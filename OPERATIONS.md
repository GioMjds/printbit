# PrintBit Operations Runbook

## Start and stop

- Start dev server: `pnpm dev`
- Build client bundle: `pnpm build`
- Type-check: `pnpm exec tsc --noEmit`

## Pre-flight checklist (kiosk)

1. `bin/SumatraPDF.exe` exists.
2. Printer is installed and has a default printer selected.
3. Serial coin hardware is connected (if coin mode is used).
4. Scanner is connected (for copy/scan features).
5. MyPublicWiFi is installed (if hotspot/captive flow is enabled).
6. NAPS2 is installed (`C:\Program Files\NAPS2\NAPS2.Console.exe`) with Epson scanner drivers.

## Common checks

- Balance API: `GET /api/balance`
- Pricing API: `GET /api/pricing`
- Active session API: `GET /api/session/active`
- Admin summary (requires PIN header): `GET /api/admin/summary`

## Frequent issues

## Print fails

- Verify `bin/SumatraPDF.exe` path and permissions.
- Confirm uploaded file exists in `uploads/`.
- Check default Windows printer status.

## Ink / toner levels show "N/A"

- Most consumer and office printers do not expose per-cartridge fill levels through Windows WMI/CIM.
- If the admin System page shows "N/A" for ink, the printer driver does not report supply data to Windows.
- Printers that expose `DetectedErrorState` may still show "Low" or "Empty" alerts even without exact percentages.
- Telemetry is queried from the Windows default printer only; ensure the correct printer is set as default.

## Coins not updating

- Verify serial cable and COM availability.
- Ensure no other application is occupying the COM port.
- Check admin/system status for serial error details.

## Upload session not resolving

- Ensure phone is connected to kiosk Wi-Fi.
- Confirm tokenized route `/upload/:token` is reachable.
- Retry session creation from kiosk print page.

## Scanner preview fails

- Confirm scanner is available and not in use.
- Retry `/api/scan/preview`.
- Check logs for `scan_preview_failed` entries.

## Scan soft-copy delivery fails

- Check scanner readiness from `GET /api/scanner/status`.
- For wireless delivery, regenerate the link from `POST /api/scanner/wireless-link` and retry `/scan/download/:token`.
- For USB delivery, verify removable drive detection via `GET /api/scanner/wired/drives` before calling `POST /api/scanner/wired/export`.

## Storage and state safety

- Runtime artifacts:
  - `uploads/`
  - `db.json`
- Scanned files in `uploads/scans` are auto-cleaned based on `PRINTBIT_SCAN_FILE_RETENTION_MS` (default 24 hours).
- Back up `db.json` before maintenance.
- Use admin endpoints to clear storage instead of manual destructive deletes when possible.

## Install/software dependency reference

Use [INSTALLATION_AND_DEPENDENCIES.md](./INSTALLATION_AND_DEPENDENCIES.md) as the primary source for software installation and dependency verification.
