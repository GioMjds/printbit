# PrintBit Kiosk Audit: Troubleshooting Results

Date: 2026-11-10
Version audited: v1.3.4
Scope: `/print`, `/upload`, `/copy`, `/scan`, `/config`, `/confirm`, the Node/Express server, the C# Worker Service, and the ESP32 firmware.
Status: **The audit itself was investigation only. Afterwards, the `/upload` findings that are bugs (not policy or hardware decisions) were fixed, then the `/print` client findings, and the `/scan` timeout and worker findings. See [Remediation log: `/upload`](#remediation-log-upload), [Remediation log: `/print`](#remediation-log-print) and [Remediation log: `/scan`](#remediation-log-scan). None of the fixes has been tested on the real kiosk.**

## How to read this

| Tag     | Meaning                                                                |
| ------- | ---------------------------------------------------------------------- |
| **[C]** | Confirmed by reading the code                                          |
| **[E]** | Backed by evidence in the local logs (`printbit.sqlite`, read-only)    |
| **[V]** | Plausible from the code, but needs a test on the real kiosk to confirm |

Severity: **HIGH** (money, data loss, or a feature that fails), **MED** (degraded behavior or wrong results), **LOW** (polish or hygiene).

## Verification baseline

- `tsc --noEmit`: clean (exit 0).
- Jest: 12 suites, 122 tests, all passing.
- Dev database snapshot: `runtime_state` is 44,100 bytes; 26 upload sessions; 39 documents; 1,575 admin log rows.
- Every `coin_accepted` log entry (37) is a simulated coin. There is no evidence of a real coin being tested.
- After the `/upload` remediation: `tsc --noEmit` clean, Jest 19 suites and 181 tests all passing, and `scripts/build-client.js` succeeds.

---

## 1. `/print` (receiving customer files)

| Sev  | Tag | Finding                                                                                                                                                  | Location                                                          |
| ---- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| HIGH | C   | **Fixed.** A failed analysis blocks **Continue** permanently, yet the label says "Preview unverified (still printable)". There is no retry on this page. | `src/public/print/app.ts:1521`, `:1354`                           |
| MED  | C   | "Receiving file…" shows only after the whole file has arrived, because `UploadStarted` fires after multer finishes.                                      | `src/modules/wireless-session/wireless-session.controller.ts:105` |
| MED  | C   | **Fixed.** Every "Refresh QR / Clear & Start Over" opens a new socket and never closes the old one (socket and handler leak).                            | `src/public/print/app.ts:1221`                                    |
| MED  | C   | **Fixed.** The 2 s status poll has no in-flight guard and no error handling. The analysis wait loop (750 ms) has no timeout.                             | `:986`, `:993`, `:1162`                                           |
| LOW  | C   | **Fixed.** If the saved session has expired during the 15 s new-session cooldown, the page shows no session and no QR.                                   | `:1453`                                                           |
| LOW  | C   | **Fixed.** The max-pages badge can go stale after `systemSettingsChanged`. A document id is used unescaped in `querySelector`.                           | `:1330`                                                           |

## 2. `/upload` (phone upload portal)

| Sev  | Tag | Finding                                                                                                                                                                                                               | Location                                                               |
| ---- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| HIGH | C   | The ESP32 access point uses the default 4 stations on fixed channel 1. If the kiosk PC is one client, only about 3 phones fit.                                                                                        | `esp32-softAP.ino:2419`                                                |
| HIGH | E   | Uploads are rejected (503) whenever Defender reports unavailable. The log shows 7 rejected `.docx`/`.pdf` uploads on 2026-10-18. The gate is fail-closed.                                                             | `src/middleware/file-validation.ts:955`                                |
| MED  | C   | Any PDF whose first 4 MB contains `/JavaScript`, `/Launch`, or an `/OpenAction` with Launch is rejected and quarantined. This hits many legitimate fillable forms.                                                    | `src/middleware/file-validation.ts:686-714`                            |
| MED  | C   | **Fixed.** Unsupported files (for example `.xlsx`, `.pptx`, `.txt`) show an error but are still queued as "Ready to send", then rejected by the server.                                                               | `src/public/upload/app.ts:730`                                         |
| MED  | C   | **Fixed.** The summary says "You can retry failed items", but failed items never return to pending, and re-adding the same file hits the duplicate-hash check.                                                        | `:739`, `:1092`                                                        |
| MED  | C   | **Partly fixed** (limit raised to 30; still keyed by IP). The upload rate limit is 10 per minute per IP, the same as the 10-file session cap, so any retry returns 429. All phones may share an IP behind the tunnel. | `wireless-session.controller.ts:23`, `src/middleware/rate-limit.ts:21` |
| MED  | C   | Each upload spawns `MpCmdRun.exe`, plus PowerShell when the 60 s health cache is cold. Progress stays at 90% meanwhile.                                                                                               | `src/services/defender-scanner.ts:253`, `:387`                         |
| MED  | C   | **Fixed** (XHR timeout; unsupported and oversize files are no longer hashed). The whole file is hashed in the browser before queueing (`sha256File`). Large files freeze the phone briefly. The XHR has no timeout.   | `src/public/upload/app.ts`                                             |
| LOW  | C   | **Fixed.** Several rejection paths (too large, max files, size limit, unsupported type, bad token) keep the staged file and quota for up to 1 hour.                                                                   | `src/services/session.ts:359-398`                                      |
| LOW  | C   | **Fixed.** The preview endpoint looks up a document by `filename`, not `documentId`. Two files with the same name show the first one.                                                                                 | `wireless-session.service.ts:432`                                      |
| LOW  | C   | **Fixed.** `AnalysisFailed` carries the document UUID as the filename, so the kiosk shows a UUID.                                                                                                                     | `wireless-session.service.ts:1195-1199`                                |

Supported types are PDF, DOC, DOCX, JPG, JPEG, PNG, GIF, WebP and BMP. The type validation itself (magic bytes, OOXML structure, macro and zip-bomb checks) is sound.

## 3. `/copy` (glass scanner and ADF)

| Sev  | Tag | Finding                                                                                                                                                   | Location                                                       |
| ---- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| HIGH | E   | Every pre-scan failure shows "No document detected… scanner glass". Of 49 logged failures, 32 were worker IPC timeouts and 17 were "scanner offline".     | `src/modules/scanner/scanner.service.ts:936`                   |
| HIGH | C   | Copy preview is not the same as the config preview. Copy uses a plain fit-to-container render. Config uses the shared print layout (margins, fit/actual). | `src/public/copy/app.ts:601` vs `src/public/config/app.ts:661` |
| MED  | C   | Pre-scan is hardcoded to 300 DPI color and ignores the admin `scannerDpi` setting.                                                                        | `scanner.service.ts:882`                                       |
| MED  | C   | Long bond is requested as 216×330 mm whichever source is used. The worker has no glass guard, and the L5290 glass maximum is 216×297 mm.                  | `worker/.../Scanning/Naps2ScannerService.cs:199`               |
| MED  | V   | ADF pre-scan stops after page 1 (`maxPages: 1`), so the next sheet may be left half-fed.                                                                  | `:227`                                                         |
| MED  | C   | The copy page POSTs `/api/scan/preview` with no client timeout.                                                                                           | `src/public/copy/app.ts`                                       |

Paper routing today: A4 and Short go to the glass, Long goes to the ADF (derived from the paper size).

## 4. `/scan` (soft copy)

| Sev  | Tag | Finding                                                                                                                                                                            | Location                                                                                                                               |
| ---- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH | V   | The scan fee may be unpayable. The coin slot starts locked and arming is restricted to print and copy modes on both client and server.                                             | `src/public/confirm/app.ts:1405`, `src/modules/payment/payment-session.service.ts:138`, `src/services/hardware-state-projection.ts:78` |
| HIGH | E   | **Fixed.** One timeout covers the whole scan: 45 s in `appsettings.json`, while Node waits 100 s assuming 90 s. On 2026-10-13, 29 ADF scans at 600 DPI color ended in IPC timeout. | `appsettings.json:55`, `src/services/scanner.ts`                                                                                       |
| HIGH | C   | **Fixed.** The probe timeout is never applied. The token is not passed to `GetDeviceList`, so a TWAIN hang blocks all scanning.                                                    | `Naps2ScannerService.cs:75-79`                                                                                                         |
| MED  | C   | **Fixed.** The cached scanner device is never invalidated after a failed scan.                                                                                                     | `:141`                                                                                                                                 |
| MED  | C   | A timeout discards every scanned page, including the PDF export. All pages are held in RAM.                                                                                        | `Naps2ScannerService.cs`                                                                                                               |
| MED  | C   | **Fixed.** There is no scan concurrency lock in the worker.                                                                                                                        | `Naps2ScannerService.cs`                                                                                                               |

Scan log counts: `scan_failed` 40, `scan_completed` 4, `scan_soft_copy_charged` 1.

## 5. `/config` (preview accuracy, pricing, detection)

| Sev  | Tag | Finding                                                                                                                                                            | Location                                                                         |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| HIGH | C   | Phone photos with EXIF rotation print sideways compared with the preview. The browser honors EXIF; `ImageToPdfConverter` does not.                                 | `worker/.../DocumentConversion/ImageToPdfConverter.cs:61-67`                     |
| HIGH | C   | Two color detectors can disagree. An operator-list detector sets the default color mode in the UI. A pixel-based detector sets the price.                          | `src/services/color-detection.ts:305` vs `src/services/document-analysis.ts:357` |
| HIGH | C   | PDF analysis renders every page on the Node main thread. The worker-thread entry point is dead code. Coins, sockets and HTTP stall during large documents.         | `document-analysis.ts:950`, `:1007`                                              |
| MED  | V   | The first detector waits 200 ms per unresolved image and only searches page-level objects. Shared logos may cost seconds and be skipped, giving a false grayscale. | `color-detection.ts:161-215`                                                     |
| MED  | C   | `/color-analysis` is uncached and reads the PDF synchronously.                                                                                                     | `color-detection.ts`                                                             |
| MED  | C   | Blank threshold is 0.1% content coverage at half scale. A page with only a page number can be flagged blank, and an all-sparse document can be blocked.            | `document-analysis.ts:456`                                                       |
| MED  | V   | WebP is converted by LibreOffice, so its page geometry likely differs from the browser preview.                                                                    | `LibreOfficeDocumentConversionService.cs`                                        |
| MED  | V   | `convertToPdfArtifact` checks `existsSync` before its in-flight map, so a partly written artifact may be returned.                                                 | `src/services/preview.ts:22-25`                                                  |
| LOW  | C   | `PDF_RENDER_SCALE` in the config is unused. Analysis hardcodes scale 0.5.                                                                                          | `src/config/document-analysis.config.ts`                                         |

What is good: the layout contract matches between TypeScript (`PRINT_MARGIN_POINTS = 14.4`, A4 595.28×841.89, Short 612×792, Long 612×936) and C# `PrintLayout`. The analysis cache is keyed by file hash, pricing fingerprint and algorithm version (12).

## 6. `/confirm` (coins, change, reverify)

| Sev  | Tag | Finding                                                                                                                                                                                                                                                        | Location                                                                                                        |
| ---- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| HIGH | V   | Each coin is reported twice: over serial (`coin_pulse:<n>` → worker → `creditWorkerCoin`) and over HTTP `GET /coin` → `creditCoinBalance`. There is no shared dedupe. Either coins double-credit, or the HTTP path fails and stalls the ESP32 loop on retries. | `esp32-softAP.ino:2488-2494`, `HardwareOrchestrator.cs:395`, `src/modules/financial/financial.controller.ts:19` |
| HIGH | V   | Two coins inside the 730 ms window merge into an unrecognized pulse count and are lost (`coin_pulse_error:unrecognized_pulse_count`).                                                                                                                          | `esp32-softAP.ino:101`, `:2473`                                                                                 |
| HIGH | C   | Creating a new upload session sets any existing balance to 0, with only a log entry.                                                                                                                                                                           | `wireless-session.service.ts:316`                                                                               |
| MED  | V   | A print job never seen in the spooler counts as Completed when the printer is healthy.                                                                                                                                                                         | `worker/.../PrintService/DocumentPrinter.cs:407`                                                                |
| MED  | E   | Hopper self-test failed 97 times and passed once: "ESP32 hopper status check failed: This operation was aborted" against `http://192.168.4.1`.                                                                                                                 | admin logs                                                                                                      |
| MED  | C   | `creditWorkerCoin` increments the balance with no event-id dedupe and no lock check.                                                                                                                                                                           | `src/services/hardware-state-projection.ts:254-286`                                                             |
| LOW  | C   | `EnableCoinSimulation: true` is checked in. `ESP32_ALWAYS_ACCEPT_COINS` is defined and never used. A debug path prints to `C:\Users\printbit\test_output.pdf` when the printer name contains "PDF".                                                            | `appsettings.json:3`, `src/config/http.config.ts:110`, `NativePdfPrinter.cs:55`                                 |

Payment flow facts: the lease lasts 15 s with a 3 s heartbeat. Arming needs the printer ready, serial connected and balance below the amount. Print uses `/api/confirm-payment` with an idempotency key, lease id and quote hash. Copy uses `/api/copy/jobs`. Scan uses `/api/scanner/soft-copy/charge`.

---

## Cross-cutting findings

### Performance and storage

| Sev | Tag | Finding                                                                                                                                                                                                                                                 | Location                                   |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| MED | C   | The whole runtime state is serialized to one JSON row on every `db.write()`. Each coin triggers 3 to 4 full writes. The ledger (`financialLedger`) and `anomalyIncidents` have no cap. Cost is trivial at 44 KB (0.08 ms stringify) and grows with use. | `src/core/database/db.ts:1805`             |
| MED | C   | A full session snapshot is persisted on every 5 s phone poll (`claimOwner`) and a sqlite touch on every 2 s kiosk poll.                                                                                                                                 | `src/services/session.ts:1276`             |
| MED | C   | Document conversion is strictly serial (120 s timeout), so one slow DOCX delays every other conversion.                                                                                                                                                 | `src/services/document-conversion-pipe.ts` |
| LOW | C   | The analysis queue `jobStore` map is never pruned. The 2 s "Queue timeout" race can never fire.                                                                                                                                                         | `src/services/pricing-analysis-queue.ts`   |

### Operations

| Sev | Tag | Finding                                                                                                                                                                   |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MED | E   | Session expiry is disabled (`PRINTBIT_SESSION_EXPIRY_ENABLED=false` in `.env.example:96` and `.env`). The local DB holds 26 sessions and 39 documents back to 2026-10-03. |
| LOW | E   | 20 unexpected restarts in 84 boots.                                                                                                                                       |
| LOW | E   | 8 `printer_error` entries on 2026-11-07 (EPSON L5290 Series, error code 4).                                                                                               |
| LOW | C   | Test gap: the six page scripts have no tests apart from one modal spec.                                                                                                   |

---

## Proposed approach

Follow the systematic-debugging rule: no fix without a confirmed root cause, one change at a time, and a failing test before each fix.

### Step 1. Verify on the real kiosk (no code changes)

1. Insert a ₱1 coin and watch the balance and logs (double-credit check).
2. Insert two coins quickly (merge and loss check).
3. Try to pay a scan fee (coin-slot lock check).
4. Time glass and ADF scans at 150, 300 and 600 DPI, and record worker logs.
5. Print a portrait phone photo (EXIF check).
6. List the Epson driver's paper sizes for 8.5×13 (Long).
7. Connect 5 phones to the access point and upload at the same time.
8. Check that `http://192.168.4.1` is reachable from the kiosk PC (hopper self-test).

### Step 2. Money correctness

- Make one coin path authoritative and dedupe by event id.
- Decide how scan-mode payment arms the slot.
- Stop silently zeroing balance on session create.
- Do not report a never-seen spooler job as completed.
- Keep `EnableCoinSimulation` off in the production config.

### Step 3. Print accuracy

- Apply EXIF auto-orientation in `ImageToPdfConverter`.
- Use one color detector as the source of truth for both default mode and price.
- Revisit the blank-page threshold.
- Share one preview renderer between copy and config.
- Confirm the WebP path geometry.

### Step 4. Scanner reliability

- ~~Pass the probe token to `GetDeviceList`.~~ Done.
- ~~Use per-page timeouts and align the Node and worker values.~~ Done.
- Return real error codes (IPC timeout vs offline vs empty glass) instead of one message. (`/scan` side done; the `/copy` "No document detected" message is not.)
- Honor admin DPI settings and set a sane ADF default.
- ~~Invalidate the cached device on failure and add a scan lock.~~ Done.
- Guard Long paper so it only uses the ADF.

### Step 5. Speed

- Move PDF analysis off the main thread.
- Reduce Defender cost and decide the fail policy when it is unavailable.
- Add in-flight guards to the polling loops and cut persist frequency.
- Plan access point capacity (station count, channel).

### Step 6. Hygiene

- Re-enable session expiry and add cleanup.
- Cap the ledger or move it to its own table.
- ~~Fix the upload page queue filter and retry.~~ Done.
- ~~Release staged files and quota on early failures.~~ Done.
- Decide the PDF JavaScript policy.
- ~~Close old sockets on session refresh.~~ Done (`/print`).

---

## Remediation log: `/upload`

Date: 2026-11-10. Method: systematic debugging. Each root cause was confirmed in the code, a failing test was written first, then one fix was made. Nothing is committed yet, and nothing has been tried on the real kiosk or on a phone.

### Fixed

| Finding                                             | Root cause                                                                                                                                                                                               | Fix                                                                                                                                                                                                                     | Files                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Unsupported files queued after an error             | The error message and the queue loop used different checks. The loop only skipped a file when its normalized MIME type was null, so `text/plain`, the `.xlsx` and `.pptx` MIME types and similar passed. | One `classifyUploadFile` check now decides both the message and queue entry. It also rejects files over 25 MB before they are read or hashed.                                                                           | `src/public/upload/upload-queue.ts`, `app.ts`                                                           |
| Retry does not work                                 | Only `pending` items were ever sent, and the duplicate check counted failed items.                                                                                                                       | Transient failures (network error, timeout, 429, 5xx, `SCAN_UNAVAILABLE`, `SCAN_FAILED`) stay sendable, so Send retries them. Failed items no longer count as duplicates. The summary says whether a retry is possible. | `upload-queue.ts`, `app.ts`                                                                             |
| Hashing freeze, XHR without timeout                 | Unsupported or huge files were read fully into memory before any check. The XHR had no `timeout`, `abort` or `timeout` handler, so a stalled request never finished and blocked the queue.               | Size and type checks run before hashing. The XHR has a 180 s timeout (above the 60 s Defender scan timeout) and `abort` and `timeout` handlers. `sendFile` always resolves. A plain-text 429 now shows a clear message. | `upload-queue.ts`, `app.ts`                                                                             |
| Rate limit blocks retries                           | 10 per minute per IP, equal to the 10-file session cap.                                                                                                                                                  | Raised to 30 per minute as a named constant.                                                                                                                                                                            | `src/modules/wireless-session/upload-rate-limit.ts`, `wireless-session.controller.ts`                   |
| Rejected uploads hold staged file and quota         | `storeUpload` only discarded the staged file on the duplicate path.                                                                                                                                      | `uploadToSession` now discards the staged file on every failure.                                                                                                                                                        | `wireless-session.service.ts`                                                                           |
| `AnalysisFailed` shows a UUID                       | The event was sent with `filename: job.documentId`.                                                                                                                                                      | The event now carries the real filename and falls back to the id only if the document is gone.                                                                                                                          | `wireless-session.service.ts`                                                                           |
| Preview shows the wrong file for same-named uploads | Lookup by `filename` always returned the first match.                                                                                                                                                    | The preview endpoint accepts `?documentId=`, and the config page now sends it. `?filename=` still works for older clients.                                                                                              | `document-selection.ts`, `wireless-session.service.ts`, `src/public/config/app.ts`, `document-query.ts` |

### New finding, found and fixed during the work

| Sev | Tag | Finding                                                                                                                                                                                                    | Fix                                                                                                          |
| --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| MED | C   | `/api/wireless/sessions/:id/color-analysis` had the same filename lookup as the preview. With two same-named uploads, the wrong file fed color detection, which sets the default color mode and the price. | Same shared `selectRequestedDocument` helper, and the config page sends `documentId` for color analysis too. |

An unknown `documentId` returns "not found" (preview) or the default color result (color analysis). It never falls back to a different document.

### Tests added

- `src/public/upload/upload-queue.spec.ts` (28 tests)
- `src/modules/wireless-session/wireless-session.service.spec.ts` (staged-file release, `AnalysisFailed` filename, preview by `documentId`, color-analysis by `documentId`)
- `src/modules/wireless-session/upload-rate-limit.spec.ts`
- `src/modules/wireless-session/document-selection.spec.ts`
- `src/public/config/document-query.spec.ts`

### Not fixed (needs a decision or a real-device test)

| Finding                                                                  | Why it is left open                                                        | Recommendation                                                                                    |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Defender unavailable gives a 503                                         | Fail policy is a security decision. The cause of "unavailable" is unknown. | Keep fail-closed. Find why Defender reports unavailable (`npm run defender:verify` on the kiosk). |
| PDFs with `/JavaScript` or `/Launch` are rejected                        | Security trade-off.                                                        | Stop rejecting `/JavaScript` alone, because it hits fillable forms. Keep `/Launch`.               |
| Defender cost per upload (`MpCmdRun.exe`, cold PowerShell)               | Needs measurement on the real kiosk.                                       | Measure first, then decide.                                                                       |
| ESP32 access point (4 stations, channel 1)                               | Firmware change that cannot be verified without the device.                | Run the 5-phone test from Step 1, then raise the max connection count.                            |
| Rate limit is keyed by IP                                                | Phones behind the Cloudflare tunnel may still share one bucket.            | Revisit after the tunnel path is tested.                                                          |
| `buildDocxSourcePreviewUrl` in `office-preview.ts` still uses `filename` | Nothing calls it.                                                          | Update it if it is ever used.                                                                     |

## Remediation log: `/print`

Date: 2026-11-10. Method: systematic debugging. Root causes were confirmed in the code, tests were written first (red, then green), then the fixes were made. Pure logic lives in `src/public/print/print-session.ts` with `print-session.spec.ts` (22 tests); `app.ts` only wires it to the DOM. Nothing is committed and nothing has been tried on the kiosk.

### Fixed

| Finding                                                            | Root cause                                                                                                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed analysis blocks Continue; label says "still printable"      | The server refuses to quote a document whose analysis failed (`ANALYSIS_FAILED`), so "still printable" was false. Continue only waited on a status that never changed, and nothing called the existing `POST /api/wireless/sessions/:id/analyze`. The label was set only by a socket event, and the next list render erased it. | Continue on a failed file re-queues analysis, then waits (same retry `/config` uses). The row badge is now derived from session data, so it survives re-renders, and reads "Could not prepare this file. Tap Continue to retry."                                       |
| Socket and handler leak on every refresh                           | `io()` returns a cached socket, so each session stacked another full set of handlers. The server has no `leaveSession`.                                                                                                                                                                                                         | One socket and one handler set per page. A new session reconnects (which drops the old room) and joins the new one.                                                                                                                                                    |
| Status poll: no guard, no error handling; wait loop has no timeout | `setInterval` fired regardless of an in-flight request, a rejected `fetch` was unhandled, and the wait loop only exited on a terminal status.                                                                                                                                                                                   | Timer ticks skip while a request is running. Event-driven refreshes (socket, delete) queue one follow-up run. Status requests have an 8 s timeout and errors are logged. The wait loop gives up after 150 s (above the 120 s conversion timeout) with a retry message. |
| Expired saved session shows no session or QR                       | `restoreSession` called `requestNewSession`, which is blocked by the 15 s Refresh-button cooldown.                                                                                                                                                                                                                              | It now calls `createSession` directly and clears the dead session keys.                                                                                                                                                                                                |
| Max-pages badge stale after `systemSettingsChanged`                | The re-render was skipped when the file signature was unchanged, and the signature ignored the limit.                                                                                                                                                                                                                           | The limit is part of the signature.                                                                                                                                                                                                                                    |
| Document id unescaped in `querySelector`                           | `documentId` falls back to the filename, so a `"` in the name made the selector invalid and threw inside the socket handler.                                                                                                                                                                                                    | Rows are matched by comparing `dataset.documentId`. No selector is built.                                                                                                                                                                                              |

### Not fixed

| Finding                                                       | Why it is left open                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Receiving file…" shows only after the whole file has arrived | The cause is on the server: `UploadStarted` is emitted after multer finishes (`wireless-session.controller.ts:103`). The filename is not known before multer parses the body, so an early event would have no filename. Needs a decision on what the kiosk should show. |

### Test notes

- `tsc --noEmit` clean. Full Jest run: 16 suites, 157 tests, all passing. `scripts/build-client.js` succeeds.
- The restore-after-expiry change and the `dataset` row lookup are DOM code and have no unit test (Jest runs in the node environment).
- The `/upload` remediation log lists spec files (`upload-queue.spec.ts`, `upload-rate-limit.spec.ts`, `document-selection.spec.ts`, `document-query.spec.ts`, and cases in `wireless-session.service.spec.ts`). None of them exists in this working tree, so the totals quoted in the verification baseline (19 suites, 181 tests) cannot be reproduced here.

## Remediation log: `/scan`

Date: 2026-11-10. Committed in `8624a4a` (timeout value, "took too long" guide) and `abfca95` (deadlines, gate, probe token, client timeout). Nothing has been tried on the real kiosk or with the real EPSON L5290. The evidence below is code and automated tests only.

### Fixed

| Finding                                   | Root cause                                                                                                                                                            | Fix                                                                                                                                                                                                                                                                                                                               | Files                                                                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One 45 s timeout covers the whole scan    | A single `ScanTimeoutSeconds` (45) cut a whole multi-page ADF scan, while Node waited 100 s. A 600 DPI color batch cannot finish in 45 s, so Node saw an IPC timeout. | Overall cap is now 90 s. A new per-page window (`ScanPageTimeoutSeconds`, 45 s) restarts after every page, so a stalled feeder fails early and a healthy long scan is not cut. New codes `SCAN_TIMEOUT` and `SCAN_PAGE_TIMEOUT`. Node's 100 s wait is documented as worker 90 s plus 10 s for PDF export, and a spec guards that. | `ScanGuards.cs` (`ScanDeadline`), `Naps2ScannerService.cs`, both `appsettings*.json`, `ScannerSettings.cs`, `src/services/scanner.ts`, `scan-timeout-alignment.spec.ts` |
| Probe timeout never applied               | `controller.GetDeviceList(driver)` takes no token, so the 8 s probe timeout could not stop a TWAIN hang.                                                              | The probe uses `GetDevices(driver, token)` inside `Task.Run(...).WaitAsync(token)`, so a driver that ignores the token is abandoned at the deadline.                                                                                                                                                                              | `Naps2ScannerService.cs`                                                                                                                                                |
| Cached device kept after a failed scan    | `_selectedDevice` and the connected status were never reset on failure.                                                                                               | `ScanFailurePolicy.ShouldInvalidateDevice` clears the cache for `SCAN_TIMEOUT`, `SCAN_PAGE_TIMEOUT`, `PROCESS_FAILED` and `SCANNER_UNAVAILABLE`, so the next scan re-probes. User-fixable and busy outcomes (for example `FEEDER_EMPTY`, `SCANNER_BUSY`) keep it.                                                                 | `ScanGuards.cs`, `Naps2ScannerService.cs`                                                                                                                               |
| No scan concurrency lock                  | Two overlapping requests could drive the scanner at once.                                                                                                             | `ScanGate` allows one scan. A second request is rejected at once with `SCANNER_BUSY`, not queued.                                                                                                                                                                                                                                 | `ScanGuards.cs`, `Naps2ScannerService.cs`                                                                                                                               |
| `/scan` page request had no timeout (new) | `startScan` called plain `fetch`, so a dead connection left the page on the progress screen.                                                                          | The page uses a shared `fetchWithTimeout` with 110 s, above Node's 100 s so the server's more specific error normally wins.                                                                                                                                                                                                       | `src/public/scan/app.ts`, `src/public/shared/fetch-with-timeout.ts`                                                                                                     |
| Timeout shown as a generic failure (new)  | `troubleshooting.ts` had no timeout case.                                                                                                                             | New "The scanner took too long to respond" guide. It matches `timeout`, `timed out` and `no response received`.                                                                                                                                                                                                                   | `src/public/scan/troubleshooting.ts`                                                                                                                                    |

### Tests added

- `worker/tests/PrintBit.Tests/ScanGuardsTests.cs`: deadline, gate and device-invalidation policy.
- `src/services/scan-timeout-alignment.spec.ts`: Node wait stays at least worker timeout plus 10 s.
- `src/public/shared/fetch-with-timeout.spec.ts`
- `src/public/scan/troubleshooting.spec.ts`

Re-run on 2026-11-10 against the current tree: Jest `src/public/scan`, `src/public/shared`, `src/services/scan-timeout-alignment` gives 5 suites and 29 tests, all passing. `dotnet test` with filter `Scan` gives 18 tests, all passing. The full Jest and `tsc` runs were not repeated for this log.

### Not fixed

| Finding                                                                | Why it is left open                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scan fee may be unpayable (HIGH, [V])                                  | Not touched. `payment-session.service.ts:138` still allows arming only for `print` and `copy`. Needs the real-kiosk coin-slot check from Step 1, then a decision on how scan mode arms the slot.                                                                       |
| A timeout discards every scanned page, and all pages are held in RAM   | Not touched. The cancel path still deletes the output and returns no partial result. The new per-page timeout makes a total loss less likely on a healthy scan, but a stall on page N still loses pages 1 to N-1. Needs a product decision (keep partial PDF or fail). |
| The probe fix and device invalidation have no unit test                | They depend on NAPS2 and TWAIN. Only the pure guards (`ScanDeadline`, `ScanGate`, `ScanFailurePolicy`) are tested. Confirm on the L5290 by unplugging or stalling the feeder.                                                                                          |
| `SCANNER_BUSY` and `SCAN_PAGE_TIMEOUT` are not handled by name in Node | Nothing in `src` references them. They reach the user through the error message. `SCAN_PAGE_TIMEOUT` ("timed out") maps to the timeout guide. `SCANNER_BUSY` ("already in progress") falls to the generic guide.                                                       |
| `Naps2ScannerService.cs` gained a UTF-8 BOM in `abfca95`               | The first line changed only by an invisible BOM. Harmless, but it shows up in blame.                                                                                                                                                                                   |

---

## Coverage gaps

Not read in full: `src/public/scan/app.ts`, `src/modules/copy/copy.service.ts`, `src/services/hopper.ts`, `src/services/print-quote.ts`, admin modules, parts of `src/public/confirm/app.ts` (socket and event section), `JobOrchestrator.cs`, `LibreOfficeDocumentConversionService.cs`, `WorkerCommandPipeHostedService.cs`, `SerialHostedService.cs`, `HopperDevice.cs`, most of the `.ino` file, the HTML and CSS, and `cloud/worker.ts`.

The `graphify` CLI was not on PATH, so the knowledge graph was not queried and source was read directly. No hardware was exercised, and the Cloudflare Tunnel path was not tested.
