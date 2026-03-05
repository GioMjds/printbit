# **PrintBit**

PrintBit is a Windows-based self-service kiosk application for coin-operated printing, scanning, and copy workflows.
It is designed for campus usage (students, faculty, and staff) with phone-to-kiosk document upload and on-device job confirmation.

## Core capabilities

- Coin balance via serial input (Arduino/coin acceptor).
- Wireless upload sessions for print jobs (QR + hotspot flow).
- Print and copy job charging tied to configurable pricing.
- Scan and scan-preview flow for copy mode.
- Admin dashboard for earnings, logs, settings, and diagnostics.

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
