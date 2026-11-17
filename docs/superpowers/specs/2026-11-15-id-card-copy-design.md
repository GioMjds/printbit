# Copy page: ID card front-back copy and merged settings

Date: 2026-11-15
Branch: new branch from `main` (not `refactor/confirm-state-machines`)
Scope: `src/public/copy/`, `src/modules/scanner/`, `src/shared/`,
`worker/src/PrintBit.Infrastructure.Windows/Scanning/`, small touches in
`src/public/confirm/` and `src/public/config/`

## Goal

Customers ask for a front-and-back photocopy of an ID card. The printer
(EPSON L5290) is not duplex, and its own panel Copy cannot be driven from
software or previewed.

The kiosk adds an **ID Card** copy type to `/copy`. The customer scans the
front, flips the card, scans the back, and sees both sides merged on one sheet
before paying. One sheet face is printed per copy.

At the same time `/copy` absorbs the print settings that copy jobs need, so the
copy flow becomes `/copy` then `/confirm`. `/config` is no longer part of it.

Success: a customer completes an ID copy alone, sees the exact sheet before
paying, pays once, and receives one sheet per copy with both sides at real size.

## Decisions

| Topic                                | Decision                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Originals covered                    | ID-size cards only. Two-sided full-page documents are out of scope.                                         |
| Finding the card                     | Fixed marked corner on the glass. No edge detection, no deskew.                                             |
| Scan area                            | 100 x 100 mm from the glass origin corner, so portrait or landscape placement both fit.                     |
| Sheet layout                         | Front above back, real size, on one face of a portrait sheet.                                               |
| Price                                | One copy page: existing `copyBwPerPage` / `copyColorPerPage` plus the high-quality surcharge, times copies. |
| Settings on `/copy`                  | Copy type, Paper size, Color mode, Print quality, Copies.                                                   |
| Orientation and rotate for documents | Dropped. Auto layout through `defaultCopyLayout`.                                                           |
| Fixing a bad side                    | Retake that side, or rotate it in 90 degree steps. No rescan needed to rotate.                              |
| Checking scan content                | Two dismissible warnings: a side looks empty, or front and back look the same. Warnings never block.        |
| Where the two-scan session lives     | Node. The worker gains one scan size and nothing else.                                                      |
| Page layout                          | `/copy` adopts the `/config` layout.                                                                        |
| Status text                          | Kiosk mirrors the printer's own wording: "Scanning...", "Copying n/N".                                      |

## Non-goals

- No change to `src/modules/copy/copy.service.ts`, pricing, settlement, the
  print queue, receipts, or the copy job API payload.
- No new worker IPC command and no new worker event.
- No use of the printer's panel Scan or Copy functions, and no detection of
  customers using them directly. That is a separate problem.
- No extraction of the preview class from `src/public/config/app.ts`.
- No removal of the dead copy-mode branches inside `/config`. A later cleanup.
- No per-ID pricing setting, no enlarge option, no multiple cards per sheet.

## Customer flow

```
Home -> /copy -> /confirm -> printing

Document:  place document -> Check Document -> preview -> Continue
ID Card:   place front at marked corner -> Scan Front
           flip prompt -> place back at same corner -> Scan Back
           merged sheet preview -> (retake / rotate either side) -> Continue
```

### Flip reminder

Three layers remind the customer and require two scans before payment. They
do not verify that the card was flipped; two scans of anything satisfy them.
The scan content warnings below catch the two likeliest mistakes, and the
preview remains the customer's final check.

1. A flip prompt appears as soon as the front scan succeeds: "Front captured.
   Turn your ID over, place it on the same corner, then tap Scan Back." It
   shows a flip diagram, a primary **Scan Back** button and a secondary
   **Retake front** button.
2. The sheet preview keeps a dashed back slot labelled "Back side not scanned
   yet" until the back is scanned.
3. The page stays in the capture stage, which has no Continue button, until
   the back is scanned. The capture steps list shows "2 Back: waiting".

### Scan content warnings

After each ID side scan the server checks the scan and may return warnings.
The page shows one dialog per warning with **Retake** and **Keep anyway**.

| Warning           | Condition                                 | Dialog text                                                          |
| ----------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| `side_blank`      | The scanned side has almost no contrast   | "This side looks empty. Is your ID on the marked corner, face-down?" |
| `sides_identical` | Both sides exist and look nearly the same | "Front and back look the same. Did you flip your ID?"                |

Rules:

- Warnings never block. **Keep anyway** dismisses the warning for that scan;
  it returns only if that side is scanned again and the condition still holds.
- Continue is reachable once both sides exist and every shown warning has been
  answered.
- A failed or slow check produces no warning and never fails the scan.
- Known limits, which is why these are warnings: a white card on the white lid
  can read as empty; a card moved between scans can escape the same-side
  check; a card partly outside the corner region is caught by neither.

## Screen

`/copy` uses the `/config` layout: `preview-col` with `paper-viewport`,
`paper-sheet` and `preview-toolbar` on the left; a right pane built from
`option-group` / `option-card`; `config-pane-footer` at the bottom of the right
pane.

The right pane has two stages. The left pane is the same in both.

**Stage 1, capture.** The right pane shows the copy type choice first, then
what that type needs before scanning, then the scan button. No print settings
yet.

```
+----------------------------------------------------------------+
| < Back                      Copy                           (!) |
+--------------------------------+-------------------------------+
| Document Preview     [status]  | What are you copying?         |
| +----------------------------+ |  [ Document ]  [ ID Card ]    |
| | paper-viewport             | |                               |
| |  +----------------------+  | | Document: Document size       |
| |  | paper-sheet          |  | |  [ A4 ] [ Short ] [ Long ]    |
| |  |                      |  | |                               |
| |  |  placement diagram   |  | | ID Card: capture steps        |
| |  |  for the chosen type |  | |  1 Front   done  [Retake]     |
| |  |                      |  | |  2 Back    waiting            |
| |  |                      |  | |                               |
| |  +----------------------+  | +-------------------------------+
| +----------------------------+ | config-pane-footer            |
|                                | [ Check Document ]            |
|                                |  or [ Scan Front ]/[ Scan Back]|
+--------------------------------+-------------------------------+
```

**Stage 2, settings.** Shown once capture is complete: one scan for Document,
both sides for ID Card. The right pane becomes the config-like settings.

```
+----------------------------------------------------------------+
| < Back                      Copy                           (!) |
+--------------------------------+-------------------------------+
| Document Preview     [status]  | settings-scroll               |
| +----------------------------+ |  Copy type: ID Card [Change]  |
| | paper-viewport             | |  Paper size                   |
| |  +----------------------+  | |  [ A4 ] [ Short ] [ Long ]    |
| |  | paper-sheet          |  | |  Color mode                   |
| |  |   +----------+       |  | |  [ B&W ]   [ Color ]          |
| |  |   |  FRONT   |       |  | |  Print quality                |
| |  |   +----------+       |  | |  [ Standard ] [ High ]        |
| |  |   +----------+       |  | |  Copies        [-]  1  [+]    |
| |  |   |   BACK   |       |  | |                               |
| |  |   +----------+       |  | +-------------------------------+
| |  +----------------------+  | | config-pane-footer            |
| +----------------------------+ |        [ Continue to Payment ]|
| preview-toolbar:               |                               |
| [Retake front][Rotate front]   |                               |
| [Retake back] [Rotate back]    |                               |
+--------------------------------+-------------------------------+
```

Groups taken from `/config` for stage 2: Paper size, Color mode, Print quality,
Copies. Not taken: orientation, rotation, page range, duplex, pricing modal,
page picker, blank-page modal.

Stage rules:

- Every button that starts a scan is in the right pane: **Check Document**,
  **Scan Front**, **Scan Back**. The flip prompt repeats **Scan Back**.
- The left pane never holds a scan-start button. In stage 1 the sheet shows the
  placement diagram for the chosen type; for ID Card it shows the marked glass
  corner, and after the front scan it shows the front with the dashed back
  slot.
- In stage 2 the copy type is shown as a summary line with **Change**, which is
  Start over: it clears every scan, releases the server files and returns to
  stage 1.
- A retake from the stage 2 toolbar keeps the page in stage 2. While that side
  is rescanned the scan overlay covers the page.
- Returning from `/confirm` restores stage 2.

### Control rules

- **Copy type** locks after the first scan. **Change** (stage 2) or **Start
  over** (stage 1, ID Card after the front scan) clears every scan, releases
  the server files and unlocks it.
- **Paper size, Document type**: chosen in stage 1 as "Document size". It sets
  the scan area and source as today (Long goes through the ADF) and is also the
  output size. Stage 2 shows it selected and locked.
- **Paper size, ID Card type**: output sheet only, chosen in stage 2, default
  A4. Changing it rebuilds the sheet without a rescan. Stage 1 sends the
  default to the side endpoint.
- **Color mode, Print quality, Copies**: changeable at any time with no rescan.
  The scan is always in color; grayscale is applied at print. The preview turns
  gray through a CSS filter.
- **Continue** exists only in stage 2, so it is reachable only when the sheet
  is complete: one scan for Document, both sides for ID Card, and every shown
  warning answered.
- The stage 2 toolbar holds **Scan Again** for Document, and per-side
  **Retake** and **Rotate** for ID Card.
- The error banner, troubleshooting panel, ADF and printer-panel modals,
  document-care modal and idle timeout keep their current behaviour.

## Architecture

```
/copy (browser)
   |  POST /api/scan/id-copy/side     POST /api/scan/id-copy/compose
   v
scanner.controller -> scanner.service
   |                      |-- id-copy-session   (side files, rotations, expiry)
   |                      |-- id-copy-compose   (pdf-lib, one-page sheet)
   |                      `-- shared/id-card-layout (slot geometry)
   v
scan adapter -> worker StartScan (paperSize "IdCard") -> NAPS2 -> L5290

merged PDF in uploads/scans -> previewPath + releaseToken
   -> printbit.config -> /confirm -> POST /api/copy/jobs (unchanged)
```

### Units

| Unit                                          | Purpose                                                                                                                           | Depends on                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `src/shared/id-card-layout.ts`                | Pure geometry. Given a paper size and each side's rotation, returns where each scanned side is drawn on the sheet, in PDF points. | `print-configuration.ts`            |
| `src/modules/scanner/id-copy-compose.ts`      | Builds the one-page PDF from the side scans with `pdf-lib`.                                                                       | layout unit                         |
| `src/modules/scanner/id-copy-session.ts`      | In-memory session store: side files, rotations, current merged file, expiry, cleanup.                                             | file system only                    |
| `src/modules/scanner/id-copy-scan-checks.ts`  | Decides `side_blank` and `sides_identical` for a session.                                                                         | `src/services/document-analysis.ts` |
| `scanner.service.ts`, `scanner.controller.ts` | Two endpoints wiring the units to the scan adapter and release tokens.                                                            | all three                           |
| `src/public/copy/copy-flow-state.ts`          | Pure state for the page: stage (capture or settings), copy type, sides, rotations, warnings, lock state.                          | none                                |
| `src/public/copy/id-capture.ts`               | ID scan calls, flip prompt, scan overlay text.                                                                                    | flow state                          |
| `src/public/copy/copy-settings.ts`            | The four setting controls and their session persistence.                                                                          | none                                |
| `src/public/shared/copy-config.ts`            | Builds the `printbit.config` object for copy mode.                                                                                | none                                |

`copy/app.ts` (965 lines today) keeps DOM wiring and side effects and delegates
to the three new page units. `copy-flow-state.ts` follows the reducer pattern
used in `src/public/confirm/`.

## Server

### Endpoints

`POST /api/scan/id-copy/side`

- Body: `{ sessionId?: string, side: 'front' | 'back', paperSize: 'A4' | 'Short' | 'Long' }`.
- Creates a session when `sessionId` is absent or unknown.
- Scans the flatbed with `paperSize: 'IdCard'`, the admin `copyGlass` DPI,
  color, PDF, `maxPages: 1`.
- Stores the result as that side, replacing and deleting an earlier scan of the
  same side and resetting its rotation to 0.
- Rebuilds the sheet and returns
  `{ detected: true, sessionId, sides: { front, back }, complete, previewPath, releaseToken, warnings }`,
  where `warnings` is an array of `{ code: 'side_blank' | 'sides_identical', side }`,
  empty when nothing was flagged.
- On scan failure returns `{ detected: false, code, error }`, the same shape as
  `/api/scan/preview`, produced by `describeScanPreviewFailure`. The session
  and any side already captured are kept.

`POST /api/scan/id-copy/compose`

- Body: `{ sessionId, paperSize, rotations: { front?: 0|90|180|270, back?: 0|90|180|270 } }`.
- Rebuilds the sheet with no scan. Used for a paper size change or a rotation.
- Returns the same success shape. An unknown or expired session returns 409
  with a message telling the customer to scan again.

`POST /api/scanner/release` (existing)

- When the token belongs to an ID session, it deletes the merged file, both
  side files and the session entry.

### Sheet build

- The sheet is rebuilt after every side scan, so the preview is always the real
  print file. A sheet with only the front is a valid one-page PDF; the dashed
  back slot is a browser overlay.
- Each rebuild writes a new `id-copy-<uuid>.pdf` in `uploads/scans`, registers
  a release token for it and deletes the previous merged file. The prefix makes
  ID copies recognisable in receipts and admin logs with no further code.
- The whole 100 x 100 mm scan region is placed, not cropped, so a card larger
  than standard is not cut.
- Each side is positioned from the known scan corner, assuming a standard
  85.6 x 54 mm card lying landscape after rotation, so front and back line up.
- Slots never overlap. Stacked, the two slots use about the upper three
  quarters of the sheet and fit A4, Short and Long.

### Scan checks

- Both checks work on a small grayscale thumbnail (32 x 32) of each side's
  unrotated scan, rendered with the pdf.js and canvas setup already in
  `src/services/document-analysis.ts`.
- `side_blank`: the thumbnail has almost no contrast. The standard deviation of
  its gray levels is under a named threshold. An empty glass scans as an even
  light gray; a card adds edges, text and a photo.
- The existing blank-page check in `analyzeDocument` is not used. It counts any
  pixel with a channel under 250 as content, so a real scan of the empty lid,
  which is light gray rather than pure white, would never read as blank.
- `sides_identical`: the mean absolute difference between the two thumbnails
  is under a named threshold. The low resolution tolerates a card that moved a
  few millimetres.
- Both thresholds are ID-specific constants, tuned on the real scanner with an
  empty-glass scan and several cards.
- Checks run after the side is stored and before the response. Any error or
  timeout in a check is logged and yields no warning.

### Real-size printing

The print path defaults to `fit` scaling with `PRINT_MARGIN_POINTS` margins. A
full-sheet PDF therefore prints at about 95 percent, which would shrink a card
to roughly 82 x 51 mm.

The compose step enlarges each side by the inverse of the fit scale, taken from
`calculatePrintLayout` for the chosen paper. The printed card is real size, and
the copy job and print queue receive nothing new. A unit test pins the printed
size.

Sending `scaling: 'actual'` through the copy job was rejected because it would
change the inputs of the paid pipeline.

### Session

- Held in memory, like the existing release-token map, keyed by the
  `sessionId` the side endpoint issues. The session records its current
  release token so a release can find it.
- Expires after 10 minutes without a request. Expiry deletes its files.
- A Node restart loses the session. The next request returns 409 and the
  customer scans again. Nothing has been paid at this stage.
- On server start, leftover `id-copy-*.pdf` files and ID side scans in
  `uploads/scans` are deleted.

### Privacy

Side scans and merged sheets are images of identity documents. They are deleted
on release, on session expiry and on server start. `/confirm` already releases
`copyPreviewReleaseToken` when a copy job ends or is abandoned, which now frees
the whole ID session. They are never written to logs and are served only
through the existing preview route.

## Worker

- `ScanPageSizeResolver.Resolve`: new `"idcard"` case returning a
  100 x 100 mm `PageSize`. Width and length are named constants next to
  `GlassWidthMm`.
- `Naps2ScannerService`: set the page alignment explicitly for the ID region so
  it anchors to the marked corner.
- `StubScannerService`: return an ID-sized stub page for `idcard`, so dev mode
  shows a realistic merged sheet.
- `WorkerCommandParser`, `StartScanCommand`, `ScanGate`, `ScanDeadline`,
  `ScanFailurePolicy`: unchanged. `paperSize` already passes through as a
  string.

To verify on the real L5290 before the corner sticker is applied: which glass
corner is the scan origin for a custom `PageSize`, and the exact NAPS2 option
that controls alignment.

## Status text

The kiosk mirrors the printer's own wording.

| Page                 | Text                                                              | Source                                                                                                                      |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `/copy` scan overlay | "Scanning..." (Document), "Scanning front...", "Scanning back..." | The scan request in flight                                                                                                  |
| `/confirm`           | "Copying n/N"                                                     | Lifecycle state `processing`, which already carries `pagesPrinted` and `totalPages` from the worker's `PrintProgress` event |
| either               | Existing error text                                               | Existing failure paths                                                                                                      |

Scan text is driven by the request lifecycle because worker scan events are not
forwarded to the browser today. `/confirm` only changes how it words progress
in copy mode.

## Handoff to `/confirm`

- `/copy` writes `sessionStorage['printbit.config']` through
  `src/public/shared/copy-config.ts` with the fields `/confirm` reads today:
  `mode: 'copy'`, `copyPreviewPath`, `copyPreviewReleaseToken`, `colorMode`,
  `quality`, `copies`, `paperSize`, `scaling: 'fit'`, `orientation`,
  `rotationDeg: 0`, `duplex: false`, `pageRange: { type: 'all' }`,
  `totalPages: 1`, and null for the print-only and scan-only fields.
- `orientation` comes from `defaultCopyLayout` for Document and is `portrait`
  for ID Card.
- `/confirm` Back in copy mode already links to `/copy`. `/copy` restores the
  copy type, scans, rotations and settings from the session.
- `/config?mode=copy` redirects to `/copy`.

## Styles

The layout classes shared by both pages (`preview-col`, `paper-viewport`,
`paper-sheet`, `preview-toolbar`, `settings-scroll`, `option-group`,
`option-card`, `config-pane-footer`) move from `src/public/config/styles.css`
to one shared stylesheet that `/config` and `/copy` both link. `/config` must
look the same afterwards. `/copy` already paints through
`src/public/shared/print-preview-sheet.ts`, the sheet math `/config` uses.

New customer-facing strings go through `initKioskLocalization`.

## Failure handling

| Situation                               | Handling                                                                   | Customer sees                                         |
| --------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| Second scan requested while one runs    | `ScanGate` returns `SCANNER_BUSY`; scan buttons are disabled during a scan | Nothing; button disabled                              |
| Scanner stalls                          | `ScanDeadline`, `SCAN_TIMEOUT`                                             | Error banner, Retry for that side                     |
| Scanner disconnected between sides      | `SCANNER_UNAVAILABLE`, device re-probed on next scan                       | Error banner; front kept, retry back                  |
| Card sideways or upside-down            | Rotate that side                                                           | Preview updates at once                               |
| Card misplaced or cut                   | Retake that side                                                           | New preview                                           |
| Empty glass or card at the wrong corner | `side_blank` warning                                                       | "This side looks empty", Retake or Keep anyway        |
| Same side scanned twice                 | `sides_identical` warning                                                  | "Front and back look the same", Retake or Keep anyway |
| Scan check fails or times out           | Logged, no warning                                                         | Normal preview                                        |
| Printer fault on `/copy`                | Existing `initPrinterGuard`                                                | Existing fault screen                                 |
| Printer or ink not ready at payment     | Existing preflight in `copy.service.ts`                                    | Existing `/confirm` message                           |
| Customer leaves after the front scan    | Idle timeout releases the session; server expiry as backstop               | Home screen                                           |
| Session expired or Node restarted       | 409 from the ID endpoints                                                  | "Please scan your ID again" and a reset page          |

In ID mode a failed scan never discards the side that already succeeded.

## Testing

Jest:

- `id-card-layout`: slots do not overlap, fit each paper, and the printed card
  is 85.6 x 54 mm after fit scaling on A4, Short and Long.
- `id-copy-compose`: one page out; correct page size; rotation placement for
  0, 90, 180, 270; front-only sheet is valid.
- `id-copy-session`: side replacement deletes the old file; rotation resets on
  retake; expiry and release delete every file; unknown session is rejected.
- `id-copy-scan-checks`: blank side flagged; identical sides flagged; a
  slightly shifted copy of the same side still flagged; different sides not
  flagged; a failing check returns no warning.
- `copy-flow-state`: capture stage to settings stage for both copy types,
  Change returns to capture and clears scans, restore lands in the right stage,
  lock rules, retake and
  rotate transitions, start over, warning shown, dismissed, and re-raised after
  a retake.
- `copy-config`: object matches what `/confirm` reads.
- Scanner controller: failure shape matches `/api/scan/preview`.

xUnit:

- `ScanPageSizeResolverTests`: `idcard` resolves to 100 x 100 mm.

Hardware checklist on the kiosk:

- Scan origin corner matches the sticker.
- Printed card measures 85.6 x 54 mm with a ruler, on each paper size.
- B&W and color, standard and high quality, more than one copy.
- Retake and rotate each side.
- A failed back scan keeps the front.
- Empty glass raises the blank warning; the front scanned twice raises the
  same-side warning; real front and back raise neither. Tune the similarity
  threshold with several different IDs, including a mostly white one.
- Walking away after the front scan returns home and deletes the images.
- Document copy still works end to end without `/config`.
- `/config` for print looks and behaves as before the stylesheet move.
