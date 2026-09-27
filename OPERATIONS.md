# PrintBit Operations Runbook

## Start and stop

- Start dev server: `pnpm dev`
- Build client bundle: `pnpm build`
- Type-check: `pnpm exec tsc --noEmit --ignoreDeprecations 6.0`
- Build C# worker: `cd worker && dotnet build`
- Run C# worker locally (console host): `dotnet run --project .\worker\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj`
- Publish worker Windows service: `dotnet publish .\worker\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o C:\Users\printbit\printbit-worker`
- Query worker service: `sc.exe queryex PrintBitHardware`
- Start/stop worker service: `sc.exe start PrintBitHardware` / `sc.exe stop PrintBitHardware`
- Verify worker command pipe IPC: `pnpm run worker-pipe:verify`
- Run one-time legacy JSON->SQLite import: `pnpm run db:migrate:legacy`
- Force rerun legacy import (clears import marker): `pnpm run db:migrate:legacy -- --force`
- Apply controlled updates policy: `pnpm run updates:apply`
- Verify controlled updates policy: `pnpm run updates:verify`
- Revert controlled updates policy: `pnpm run updates:revert`
- Verify printer driver pin: `pnpm run driver:verify`
- Install watchdog scheduled tasks: `pnpm run watchdog:install`
- Verify watchdog secondary monitor: `pnpm run watchdog:verify`
- Uninstall watchdog scheduled tasks: `pnpm run watchdog:uninstall`
- Install startup trigger at machine boot: `powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 -AtStartup`
- Install watchdog at machine boot: `powershell -ExecutionPolicy Bypass -File .\scripts\install-watchdog.ps1 -AtStartup`

## Pre-flight checklist (kiosk)

1. C# Worker Service & print pipeline:
   - `PrintBitHardware` Windows service is running (`sc.exe query PrintBitHardware`).
   - Worker IPC command & event pipes verified: `pnpm run worker-pipe:verify`.
   - Worker queue directory exists and is writable (`C:\Users\printbit\printbit-worker\queue` or `PRINTBIT_WORKER_QUEUE_DIR`).
   - `SumatraPDF.exe` exists in `bin/` or `C:\Users\printbit\bin\SumatraPDF.exe`.
   - Both Windows logical printer queues are configured: `EPSON L5290 Series` (Standard) and `PrintBit - High` (High).
2. Printer is installed, online, paper is loaded, and USB port mapping is stable (typically `USB001`).
3. Serial coin hardware is connected (115200 baud).
4. Scanner is connected (for copy/scan features via NAPS2).
5. ESP32 bridge is connected and configured (if hotspot/captive flow is enabled).
6. NAPS2 is installed (`C:\Program Files\NAPS2\NAPS2.Console.exe`) with Epson scanner drivers.
7. Windows Time (`W32Time`) is running and synced to NTP (`w32tm /query /status`).

## Common checks

- Balance API: `GET /api/balance`
- Pricing API: `GET /api/pricing`
- Pricing config API (new): `GET /api/pricing-config` — returns active pricing engine configuration
- Active session API: `GET /api/session/active`
- Admin summary (requires PIN header): `GET /api/admin/summary`
- Customer E-Receipt API (tokenized): `GET /api/receipts/by-token/:token`
- Admin E-Receipt API (support path): `GET /api/admin/transactions/:transactionId/receipt`

Admin dashboard overview now surfaces an explicit open owed-change KPI (`owedChangeOpenCount`) so unresolved payouts are visible without drilling into anomaly logs.

## Pricing Engine Configuration and Rollout

### Pricing Engine Modes

The pricing engine supports three operational modes for safe phased rollout:

1. **Legacy mode** (default): Uses original pricing logic. Pricing engine computed in parallel but not used for billing.
2. **Shadow mode**: Both legacy and pricing engine compute in parallel. Quote endpoint returns both values for validation and comparison without affecting actual billing.
3. **Live mode**: Pricing engine becomes the billing source. All transactions use the new pricing logic.

### Mode Switching

1. Access admin settings page (`/admin/settings`) or use admin API to update `settings.pricingEngine.enabledMode`.
2. Valid values: `legacy` | `shadow` | `live`.
3. Mode changes take effect immediately for new transactions; existing pending transactions use their computed quote amount.
4. Before switching to `live`:
   - Run in `shadow` mode for at least 24 hours to validate pricing calculations.
   - Compare legacy and pricing engine amounts via `/api/print/quote?includePricingEngine=true`.
   - Audit price deltas and confirm bulk tier behavior, blank-page policy, and color multiplier values.

### Pricing Engine Configuration Fields

Configuration stored in `settings.pricingEngine`:

- `enabledMode`: Operating mode (`legacy` | `shadow` | `live`).
- `paperProfiles`: Array of paper size profiles with BW and color prices.
- `thresholds`: Coverage classification boundaries (`bwMax`, `fullColorMin`).
- `colorMultiplier`: Proportional surcharge for partial-color pages (0.0-1.0).
- `blankPagePolicy`: How to charge blank pages (`charge_zero` | `charge_bw` | `charge_color`).
- `bulkTiers`: Array of volume-based discount tiers (minPages, discountPerPage).
- `rounding`: Final amount rounding strategy (`ceil_whole_peso`).

### Troubleshooting

- **Quote endpoint returns `409`:** Document analysis is pending or failed. Retry after a few seconds or upload a different document.
- **Pricing deltas visible in shadow mode:** This is expected during testing. Use admin logs to audit per-transaction pricing breakdowns.
- **Mode switch not taking effect:** Clear session storage and refresh the confirm page to load new pricing config.

## Controlled Windows and driver updates (Issue #39)

### Baseline setup

1. Populate `scripts\printer-driver-baseline.json` with production values for the kiosk default printer.
2. Ensure baseline uses exact versions from a known-good printer + driver combination.

### Staged rollout process (one-kiosk canary first)

1. Select one kiosk as canary and back up critical runtime state:
   - **SQLite database:** Copy `printbit.sqlite` (and .sqlite-shm/.sqlite-wal if present) to a timestamped backup directory.
   - **Uploads directory:** Copy the entire `uploads/` directory to preserve queued documents and scans.
   - Verify backup integrity by checking file sizes and testing SQLite file with `sqlite3 backup.sqlite "PRAGMA integrity_check;"` before proceeding.
2. Apply update controls:
   - `pnpm run updates:apply`
   - `pnpm run updates:verify`
3. Validate driver pin:
   - `pnpm run driver:verify`
4. Perform maintenance-window OS update and printer-driver servicing on canary only.
5. Run post-update functional checks:
   - Print upload/pay/print flow
   - Coin acceptance + balance updates
   - Scanner flow if enabled
6. If all checks pass, proceed kiosk-by-kiosk for the rest of the fleet.

### Rollback if print pipeline breaks

1. Revert update controls to original state:
   - `pnpm run updates:revert`
2. Roll back printer driver using Device Manager / vendor installer to known-good version from baseline.
3. Re-run:
   - `pnpm run driver:verify`
   - `pnpm run updates:verify` (after re-applying policy if returning to managed mode)
4. Validate full transaction flow before returning kiosk to production.

## Definition of Done (mandatory): Epson L5290 spooler handoff reliability

All sections below must pass before closing spooler handoff reliability work.

### 1) Queue identity and USB port mapping verification

1. Run `GET /api/admin/printer/list`.
2. Confirm the active queue is the production Epson L5290 queue, `isDefault=true`, and `portName` matches the expected USB port (typically `USB001`).
3. Record `name`, `driverName`, `portName`, and `pnpInstanceId` in the ticket/change log.
4. If mapping is wrong or missing, run `POST /api/admin/printer/re-detect`, then re-verify before proceeding.

### 2) Windows spooler health and queue observation

1. Verify spooler is healthy: `Get-Service Spooler` must be `Running`.
2. Clear stale/paused Epson queue jobs.
3. Run `POST /api/admin/printer/test-print`, then run one real kiosk print transaction.
4. Observe queue progression (`Get-PrintJob -PrinterName "<EPSON L5290 queue name>"`) until jobs leave queue and printer output is produced.
5. If jobs stall/fail, capture timestamp + queue state and treat checklist as failed.

### 3) Physical printer checks (on-device)

1. Confirm printer panel has no active errors (jam, cover open, out of paper/ink).
2. Confirm paper path and tray are loaded/aligned for expected media size.
3. Run nozzle check; if gaps/streaks appear, run head cleaning and repeat nozzle check.
4. Print maintenance/test pattern and confirm readable, streak-free output.

### 4) USB cable and driver stability across reconnect/restart

1. Inspect and secure USB cable at both printer and host ends.
2. Perform one controlled USB reconnect (unplug/replug) and verify Epson queue returns online with same port mapping.
3. Reboot host once; verify spooler is running, Epson queue still default, and test print succeeds.
4. Confirm no Device Manager warning state for Epson/USB print devices after reconnect/restart.

### 5) Transaction/reference ID correlation to physical output

1. Run at least 2 test print transactions.
2. Capture each `transactionId` (reference ID) from kiosk/admin flow.
3. For each ID, query `GET /api/admin/transactions/:transactionId` and confirm expected settlement fields with terminal `spoolerPhase`.
4. Mark each physical printout with its `transactionId` + timestamp (or attach photo evidence) for audit trace.
5. Do not mark spooler handoff work done unless every sampled `transactionId` has matching successful spooler/admin evidence and physical output.

## Frequent issues

### E-Receipt link invalid/expired

- Customer links use `/receipt/t/:token` and expire after 24 hours by default.
- Receipt payloads include change reconciliation fields (`requested`, `dispensed`, `remaining`, `state`, `owedChangeId`, `message`) tied to the transaction ID.
- Expected token API outcomes:
  - `404` + `RECEIPT_TOKEN_NOT_FOUND` for unknown token
  - `403` + `RECEIPT_TOKEN_REVOKED` for revoked token
  - `410` + `RECEIPT_TOKEN_EXPIRED` for expired token
- Admin support path: open **Admin -> Transactions -> Open E-Receipt** for the transaction context ID.
- Expected admin lookup outcomes:
  - `404` when no receipt snapshot exists
  - `410` when the receipt has expired
- Expired receipt records/tokens are cleaned at startup and then on a 15-minute interval.

## Watchdog & self-healing (Issue #40)

- Health endpoint: `GET /api/watchdog/health` (loopback polling target for local watchdog).
- Watchdog loop script: `scripts/watchdog.ps1`
- Secondary watchdog verifier: `scripts/verify-watchdog.ps1`
- Task installer: `scripts/install-watchdog.ps1`

### Install on kiosk

1. Run `pnpm run watchdog:install` from elevated PowerShell.
2. Confirm Scheduled Tasks exist:
   - `PrintBit Watchdog`
   - `PrintBit Watchdog Verifier`
3. Optional one-shot smoke run: `pnpm run watchdog:run-once`
4. Verify heartbeat file is updating:
   - `uploads/watchdog/watchdog-heartbeat.json`
5. For power-loss resilience, prefer startup trigger installs:
   - `powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 -AtStartup`
   - `powershell -ExecutionPolicy Bypass -File .\scripts\install-watchdog.ps1 -AtStartup`
6. After pulling watchdog/startup script changes, re-run both install commands so updated task settings are applied on the kiosk host.

## Power loss, reboot & crash recovery (Issue #37)

### Planned kiosk shutdown

- From the authenticated admin console, open `/admin/system` and use **Shut Down Windows** under **Power Controls**.
- PrintBit refuses the request while a recovery session is in flight or the hopper is busy. Finish the active customer operation first.
- The action requests a planned Windows shutdown through `shutdown.exe /s /t 0`; it does not use the force-close option. See the [Microsoft shutdown command reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown).
- After power-on, verify that Assigned Access, the Node server, the C# worker, the watchdog, and the printer are all running before returning the kiosk to service.

### Software recovery behavior

- At process startup, PrintBit records startup lifecycle markers in persistent runtime state.
- If previous startup has no corresponding clean shutdown marker, startup reports `unexpected_restart_detected` in admin/anomaly logs.
- Startup reconciliation scans in-flight payment sessions and applies policy:
  - pre-settlement sessions are voided;
  - settled print sessions without final spooler outcome are auto-refunded by default;
  - any refund blocked by trusted-time enforcement remains unresolved and visible for admin review.

### Hardware & production field SOP

1. Use a UPS sized for kiosk tablet/mini-PC + printer + networking to prevent abrupt power cuts.
2. Configure BIOS/UEFI to restore power automatically after AC loss (`Restore on AC Power Loss = Power On`).
3. Use surge protection and secure power/USB cable retention in enclosure.
4. After any unplanned reboot:
   - check `GET /api/admin/summary` for `recoveryStats` and refund/open counts;
   - verify watchdog status and heartbeat freshness;
   - run one end-to-end transaction test before returning kiosk to service.
5. If unresolved recovery sessions remain (e.g., trusted time blocked), technician should restore time sync and re-check pending refunds from admin panel before reopening.

### Runtime behavior

- Watchdog polls `/api/watchdog/health` every `PRINTBIT_WATCHDOG_POLL_INTERVAL_MS` (default 5000ms).
- If health is unreachable, watchdog restarts the server (after threshold/backoff) and ensures Edge kiosk relaunch when watchdog is managing Edge.
- If health returns `unhealthy`, restart happens only when `PRINTBIT_WATCHDOG_RESTART_ON_UNHEALTHY=true`; by default this is disabled to avoid disrupting active sessions.
- Even when unhealthy-restart is enabled, restarts are skipped while a server process is still alive unless `PRINTBIT_WATCHDOG_RESTART_WHEN_PROCESS_ALIVE=true`.
- Repeated failures use exponential backoff:
  - `PRINTBIT_WATCHDOG_RESTART_BASE_DELAY_MS` (default 2000)
  - `PRINTBIT_WATCHDOG_RESTART_MAX_DELAY_MS` (default 60000)
- Escalation threshold:
  - `PRINTBIT_WATCHDOG_FAILURE_ALERT_THRESHOLD` (default 5)
  - Escalation/restore events are reported through anomaly/admin logs.

### Secondary monitor

- `PrintBit Watchdog Verifier` checks watchdog heartbeat freshness.
- If stale, it restarts the watchdog task automatically.
- Default stale threshold is 180000ms inside `verify-watchdog.ps1`.

## C# Worker Service operations & diagnostics

The worker service (`PrintBitHardware`) runs as a native Windows Service under `LocalSystem`. It handles the print spooler, SumatraPDF execution, coin acceptor pulse decoding, hopper dispense commands, power safety monitoring, Windows Defender upload scanning, USB mass storage discovery, and NAPS2 scanning.

### Verifying worker status & pipe health

```powershell
# Check service status (must report STATE: 4 RUNNING)
sc.exe queryex PrintBitHardware

# Run the automated pipe and identity verification
pnpm run worker-pipe:verify

# Inspect active process (must be exactly 1 instance)
Get-Process -Name "PrintBit.HardwareService"
```

### Investigating worker logs

Worker logs are written via Serilog to:
`C:\Users\printbit\printbit-worker\logs\printbit-worker-.log` (or within the service directory).

- Check for `Global\PrintBitHardwareWorker` mutex collision (exit code 2).
- Check for spooler submission timeouts or SumatraPDF errors.
- Check for serial port COM connection failures.

### Updating the worker

```powershell
sc.exe stop PrintBitHardware
# Wait until: sc.exe query PrintBitHardware reports STATE: 1 STOPPED

dotnet publish .\worker\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -o C:\Users\printbit\printbit-worker

sc.exe start PrintBitHardware
pnpm run worker-pipe:verify
```

## Print fails

- Verify `PrintBitHardware` Windows service is running: `sc.exe queryex PrintBitHardware`.
- Run `pnpm run worker-pipe:verify` to confirm command and event pipe integrity.
- Check `C:\Users\printbit\printbit-worker\queue` (or `PRINTBIT_WORKER_QUEUE_DIR`) for accumulating or stalled `.json` sidecars or `.pdf` files.
- Verify `SumatraPDF.exe` is present and executable (`C:\Users\printbit\bin\SumatraPDF.exe` or `bin/`).
- Verify the Windows logical queues (`EPSON L5290 Series` and `PrintBit - High`) are online and not in an error/paused state.
- Inspect the worker log file in `C:\Users\printbit\printbit-worker\logs\`.
- Check default Windows printer status and restart spooler if needed (`Restart-Service Spooler` or admin action).

## Print dispatcher phased rollout gate (Issue #112)

Use `GET /api/admin/print-dispatch/latency` to evaluate cutover readiness.

Move from `PRINTBIT_PRINT_DISPATCH_MODE=phased` to `new-only` only when:

1. `sampleCount` has representative traffic for both PDF and non-PDF uploads.
2. p95 latency and failure behavior are stable across recent operating windows.
3. If validating the slowness speculation, non-PDF p95 is interpreted as materially slower only when it is >=30% above PDF p95.

Rollback path:

- Set `PRINTBIT_PRINT_DISPATCH_MODE=legacy` and restart the service.

## Ink / toner levels show "N/A"

- Most consumer and office printers do not expose per-cartridge fill levels through Windows WMI/CIM.
- If the admin System page shows "N/A" for ink, the printer driver does not report supply data to Windows.
- Printers that expose `DetectedErrorState` may still show "Low" or "Empty" alerts even without exact percentages.
- Telemetry is queried from the Windows default printer only; ensure the correct printer is set as default.

### Epson L5290 software setup for ink telemetry (Wi-Fi/LAN first)

1. Install the official Epson L5290 driver package on the kiosk host and confirm the queue appears in Windows Printers.
2. Ensure the printer and kiosk are on the same LAN and the queue uses a stable network port/IP.
3. In PrintBit admin, open **System** and verify `/api/admin/printer/list` shows the expected Epson queue identity.
4. In PrintBit admin settings, explicitly **enable Consumables Forecasting** (`consumablesForecasting.enabled = true`) before saving, then set rolling window, alert threshold, and tray capacity/current sheets.  
   - Fresh kiosks default this flag to `false` (`src/core/database/db.ts`, `DEFAULT_DATA.settings.consumablesForecasting.enabled`), so toggle it on first.
   - API alternative: `PUT /api/admin/settings` with `{ "consumablesForecasting": { "enabled": true, ... } }`.
5. If ink telemetry is not immediately visible, run `POST /api/admin/printer/re-detect` and re-check (after enabling forecasting):
   - `/api/admin/printer/ink-diagnostics`
   - `/api/admin/printer/ink-history`
   - `/api/admin/consumables/forecast`
6. Use SNMP-capable network queue/driver configuration where possible; fallback methods can report lower-confidence ink estimates.

### Consumables incident expectations (forecast vs immediate threshold)

- Consumables forecasting can open two concurrent ink incident types for the same supply:
  - forecast depletion (`consumables-forecast:ink:<printer>:<supply>`) when days-remaining is within configured threshold;
  - immediate low/empty threshold (`consumables-threshold:ink:<printer>:<supply>`) when latest status is `low`/`empty` or reported level is at/below the configured low threshold.
- Immediate threshold incidents are expected even when depletion projection is unavailable (`avgDailyDrop = 0` / insufficient forecast data).
- Threshold incidents auto-resolve when supply telemetry recovers (status no longer low/empty and level exceeds low threshold), using the same recovery pass that resolves recovered forecast incidents.
- Operator action: treat threshold incidents as near-term replenishment signals, then verify recovery on the next telemetry refresh (`/api/admin/printer/re-detect` and `/api/admin/consumables/forecast`).

## Coins not updating

- Verify serial cable and COM availability.
- Ensure no other application is occupying the COM port.
- Check admin/system status for serial error details.

## Upload session not resolving

- Ensure phone is connected to kiosk Wi-Fi.
- Confirm tokenized route `/upload/:token` is reachable.
- Retry session creation from kiosk print page.

### ESP32 captive portal checks

- When using ESP32 onboarding, set `PRINTBIT_NETWORK_PROVIDER=esp32`.
- Align AP values with firmware (`SSID=PrintBit`, password/auth must match).
- In ESP32 `.ino`, expose `POST /kiosk/register` so the kiosk can dynamically publish its current IP and captive path.
- Keep `PRINTBIT_ESP32_AP_BASE_URL` pointed to the ESP32 AP gateway (default `http://192.168.4.1`).
- For fixed kiosk routing after reboot, keep `PRINTBIT_ESP32_KIOSK_IP=192.168.4.2` and `PRINTBIT_ESP32_STATIC_IP_ENFORCE=true`; startup scripts will re-apply static IPv4 before server launch.
- Validate end-to-end:
  - Start a new print session on kiosk (`/print`)
  - Scan QR and join ESP32 AP
  - Phone captive portal opens and reaches PrintBit upload page
  - Upload appears in kiosk file list for the active session

## Scanner preview fails

- Confirm scanner is available and not in use.
- Retry `/api/scan/preview`.
- Check logs for `scan_preview_failed` entries.

## Scan soft-copy delivery fails

- Check scanner readiness from `GET /api/scanner/status`.
- For wireless delivery, regenerate the link from `POST /api/scanner/wireless-link` and retry `/scan/download/:token`.
- In kiosk lockdown mode, USB export routes are disabled and return `423` with `code: "USB_EXPORT_DISABLED"`.

## Storage and state safety

- Runtime artifacts:
  - `uploads/`
  - `printbit.sqlite`
- Legacy `db.json` import is idempotent and marker-guarded; use the force command only during controlled migration recovery.
- Transient print uploads are deleted after successful completion (`/print` legacy success or spooler-confirmed modern print success) and on wireless session cancel/timeout.
- Transient scan/copy files under `uploads/scans` are released on scan QR **Done**, copy success, and timeout/cancel flows.
- Startup crash-recovery cleanup purges stale transient upload + scan files older than `PRINTBIT_TRANSIENT_FILE_STARTUP_RETENTION_MS` (default 30 minutes).
- Periodic scan retention cleanup still runs using `PRINTBIT_SCAN_FILE_RETENTION_MS` (default 24 hours) as a fallback safety net.
- Back up `printbit.sqlite` before maintenance.
- Use admin endpoints to clear storage instead of manual destructive deletes when possible.

## Install/software dependency reference

Use [INSTALLATION_AND_DEPENDENCIES.md](./INSTALLATION_AND_DEPENDENCIES.md) as the primary source for software installation and dependency verification.
