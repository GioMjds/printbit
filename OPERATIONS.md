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

## Storage and state safety

- Runtime artifacts:
  - `uploads/`
  - `db.json`
- Back up `db.json` before maintenance.
- Use admin endpoints to clear storage instead of manual destructive deletes when possible.
