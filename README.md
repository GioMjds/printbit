# **PrintBit**

PrintBit is a Windows-based self-service kiosk application for coin-operated printing, scanning, and copy workflows.
It is designed for campus usage (students, faculty, and staff) with phone-to-kiosk document upload and on-device job confirmation.

## Core capabilities

- Coin balance via serial input (Arduino/coin acceptor).
- Wireless upload sessions for print jobs (QR + hotspot flow).
- Print and copy job charging tied to configurable pricing.
- Scan and scan-preview flow for copy mode.
- Admin dashboard for earnings, logs, settings, and diagnostics.

## End-user step-by-step guides

### Print

1. Open **Print** on the kiosk.
2. Scan the QR code with your phone and upload a file.
3. Wait for your file to appear in **Received files** and select it.
4. Tap **Continue to settings**.
5. Choose print settings (color, copies, orientation, paper size, page range) and continue.
6. Insert coins on the confirm screen until your balance covers the total, then confirm.
7. Collect your printed pages.

Troubleshooting:

- If no file appears, start a new session and upload again.
- If you see a session expiry countdown, complete upload/selection before it reaches zero or start a fresh session.
- Only one phone can actively own an upload session at a time; if ownership conflict appears, generate a new kiosk session.
- If balance is insufficient, insert more coins before confirming.

### Copy

1. Open **Copy** on the kiosk.
2. Place the page face-down on the scanner glass.
3. Tap **Check Document** and review the preview.
4. If preview is correct, tap **Continue to Config**.
5. Choose copy settings and continue to confirmation.
6. Insert coins until the required amount is reached, then confirm.
7. Collect your copied pages.

Troubleshooting:

- If no document is detected, reposition the page and tap **Retry**.
- If preview looks incorrect, tap **Check Document** again before continuing.

### Scan

1. Open **Scan** on the kiosk.
2. Choose scan source, color mode, and resolution.
3. Place your document and tap **Scan Document**.
4. Review the scanned preview. Tap **Rescan** if needed.
5. Tap **Get Soft Copy**.
6. Choose delivery:
   - **Wireless (QR):** scan the generated QR code to download.
   - **USB Flash Drive:** insert a USB drive, refresh, then export.

Troubleshooting:

- If scanner is unavailable, check scanner connection/power and retry.
- If the QR link expires, refresh the wireless link.
- If no USB is detected, insert/reinsert the drive and refresh.

## Tech stack

- **Backend:** Node.js, Express, Socket.IO, TypeScript
- **Storage:** LowDB (`db.json`)
- **Upload handling:** Multer
- **Printing:** SumatraPDF portable executable (`bin/SumatraPDF.exe`)
- **Serial integration:** `serialport`
- **Frontend:** Static HTML/CSS + TypeScript bundles under `src/public`

## Quick start

### 1) Install dependencies

```bash
pnpm install
```

### 2) Run in development

```bash
pnpm run dev
```

Server starts on `http://0.0.0.0:3000`.

### 3) Build browser bundle

```bash
pnpm run build
```

### 4) Type-check

```bash
pnpm exec tsc --noEmit
```

## Project structure

```text
src/
  server.ts                 # App entrypoint
  config/                   # Runtime constants and route-to-page mappings
  middleware/               # Captive portal, static assets, admin auth
  routes/                   # HTTP API and page route registration
  services/                 # Printer, serial, session, hotspot, db, admin logic
  public/                   # Browser UI pages (print/upload/config/confirm/copy/scan/admin)
uploads/                    # Runtime uploaded files
db.json                     # Runtime persisted machine state
bin/                        # External executables (ex: SumatraPDF.exe)
```

## Runtime prerequisites

- Windows machine (required for current hardware/print/hotspot integrations).
- `bin/SumatraPDF.exe` present for print dispatch.
- Optional but expected in production:
  - Coin acceptor serial device
  - Scanner device
  - MyPublicWiFi installation

## Important notes

- Upload and machine state are persisted in `uploads/` and `db.json`; do not delete these unintentionally during operation.
- Admin routes are restricted by local-network checks and admin PIN header requirements.
- Current hotspot/captive behavior is optimized for Android flow; iOS flow improvements are being planned.

## Additional documentation

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [OPERATIONS.md](./OPERATIONS.md)
- [INSTALLATION_AND_DEPENDENCIES.md](./INSTALLATION_AND_DEPENDENCIES.md)
- [DOCUMENTATION_SUGGESTIONS.md](./DOCUMENTATION_SUGGESTIONS.md)

## Documentation notes

- For full install/software/dependency setup, start with
  [`INSTALLATION_AND_DEPENDENCIES.md`](./INSTALLATION_AND_DEPENDENCIES.md).
- For suggested next documentation improvements, see
  [`DOCUMENTATION_SUGGESTIONS.md`](./DOCUMENTATION_SUGGESTIONS.md).
