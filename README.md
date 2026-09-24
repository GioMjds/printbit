<p align="center">
  <img src="src/assets/logo.png" alt="PrintBit Logo" width="150" />
</p>

# **PrintBit**

PrintBit is a web app coin-operated kiosk machine. Dedicated for printing document, photocopying documents, and even converting your documents into an soft copy.
It is designed for campus usage (students, faculty, and staff) with phone-to-kiosk document upload and on-device job confirmation.

## Core capabilities

- Coin balance via serial input (Arduino/coin acceptor).
- Wireless upload sessions for print jobs (QR + hotspot flow).
- Print, copy, and scan job charging tied to configurable pricing.
- **PH-localized Pricing Engine** (v1): Coverage-aware per-page pricing with threshold classification, bulk tier discounts, and whole-peso settlement.
- Tokenized E-Receipt links for settled transactions (`/receipt/t/:token`).
- Wireless scan-to-phone soft copy delivery with dual-QR completion.
- Admin dashboard for earnings, logs, settings, and diagnostics.

## Customer workflow

### 0. Connect to PrintBit Wi-Fi

Before using mobile-connected features (uploading print files, downloading scanned soft copies, or viewing E-Receipts), customers must connect to the kiosk's local Wi-Fi:

1. Scan the Wi-Fi QR code on the kiosk screen or manually connect to the Wi-Fi network:
   - **SSID:** `PrintBit`
2. If a captive portal pop-up appears, proceed or tap **Continue**.

---

### Kiosk service methods

#### 1. Print

1. Connect your phone to **PrintBit Wi-Fi**.
2. Select **Print** on the kiosk screen.
3. Scan the on-screen session QR code with your phone.
4. Select and upload your document (PDF, DOCX, and other image file formats) on the mobile upload page.
5. On the kiosk screen, select your file under **Received files** and tap **Continue to settings**.
6. Configure print options (color mode, copies, orientation, paper size, page range) and continue.
7. On the confirm screen, insert coins until your balance covers the total fee, then confirm payment.
8. Collect your printed documents from the tray.
9. _(Optional)_ Scan the **E-Receipt** QR code on the completion screen with your phone to view and save your digital receipt.

Troubleshooting:

- If no file appears, generate a new kiosk session and upload again.
- Complete upload and selection before the session timer expires.
- If balance is insufficient, insert additional coins before confirming.

#### 2. Copy

1. Select **Copy** on the kiosk screen.
2. Place the document face-down on the scanner glass.
3. Tap **Check Document** to generate a scan preview.
4. If the preview is correct, tap **Continue to Config**.
5. Configure copy options (color mode, copies, paper size) and continue to confirmation.
6. Insert coins until the required balance is met, then confirm payment.
7. Collect your copied pages from the tray.
8. _(Optional)_ Connect your phone to **PrintBit Wi-Fi** and scan the **E-Receipt** QR code on the completion screen to view and save your digital receipt.

Troubleshooting:

- If no document is detected, reposition the page and tap **Retry**.
- If preview looks incorrect, tap **Check Document** again before continuing.

#### 3. Scan (Soft Copy)

1. Connect your phone to **PrintBit Wi-Fi**.
2. Select **Scan** on the kiosk screen.
3. Select your desired export format (**PDF**, **JPG**, or **PNG**) and paper size.
4. Place your document on the scanner and tap **Scan Document** (rescan or add pages if needed).
5. Review the preview and tap **Proceed to Pay**.
6. Insert coins until the soft-copy fee is covered, then confirm payment.
7. The completion screen displays **two QR codes**:
   - **Download QR Code:** Scan with your phone (connected to PrintBit Wi-Fi) to download the soft-copy file directly.
   - **E-Receipt QR Code:** _(Optional)_ Scan to view and save your digital transaction receipt.

Troubleshooting:

- Ensure your phone remains connected to **PrintBit Wi-Fi** when scanning the download QR code.
- If the scanner is busy or unavailable, check connections and retry.

---

### E-Receipt

- Available after payment confirmation across all 3 methods (**Print**, **Copy**, and **Scan**).
- Customer receipt links use tokenized routes: `/receipt/t/:token`.
- Retained for up to 24 hours. After expiry, links show an expired outcome.
- Phone must be connected to **PrintBit Wi-Fi** to view the local E-Receipt.
- Admin support lookup: **Admin -> Transactions -> Open E-Receipt**.

## Tech stack

- **Backend:** Node.js, Express, Socket.IO, TypeScript, C# Worker Service
- **Storage:** SQLite (`printbit.sqlite`) for persisted kiosk state
- **Upload handling:** Multer
- **Printing:** Phased dispatcher (`SumatraPDF.exe`)
- **Serial integration:** `serialport`
- **Frontend:** Static HTML/CSS + TypeScript bundles under `src/public`
- **Testing:** Jest, Supertest

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
pnpm exec tsc --noEmit --ignoreDeprecations 6.0
```

### 5) One-time legacy import (optional)

If upgrading from an older deployment that still has `db.json`, run:

```bash
pnpm run db:migrate:legacy
```

Use `--force` to rerun import after clearing the migration marker:

```bash
pnpm run db:migrate:legacy -- --force
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
printbit.sqlite             # Runtime persisted machine state (SQLite)
  bin/                        # External executables (ex: PDFtoPrinter.exe, SumatraPDF.exe)
```

## Runtime prerequisites

- Windows machine (required for current hardware/print/hotspot integrations).
- Print dispatch dependencies configured for your selected mode:
  - `bin/PDFtoPrinter.exe` (or `PRINTBIT_PDFTOPRINTER_PATH`)
  - GhostScript (`PRINTBIT_GHOSTSCRIPT_PATH` or PATH `gswin64c`)
  - Optional Sumatra fallback (`bin/SumatraPDF.exe` or `PRINTBIT_SUMATRA_PATH`) for phased mode
- Optional but expected in production:
  - Coin acceptor serial device
  - Scanner device
  - ESP32 network bridge

### Print dispatcher configuration

- `PRINTBIT_PRINT_DISPATCH_MODE=legacy|phased|new-only` (default `legacy`)
  - `legacy`: Sumatra-only behavior
  - `phased`: PDFtoPrinter/GhostScript with Sumatra emergency fallback
  - `new-only`: PDFtoPrinter/GhostScript only
- `PRINTBIT_POWER_SAFETY_BYPASS=true` (optional, local development only) treats
  power safety as operational while testing Node.js without the physical
  printer/UPS. It does not bypass printer preflight checks or enable printing.
- `PRINTBIT_PDFTOPRINTER_PATH` (or `PDFTOPRINTER_PATH`) default: `bin/PDFtoPrinter.exe`
- `PRINTBIT_GHOSTSCRIPT_PATH` (or `GHOSTSCRIPT_PATH`) optional explicit path to `gswin64c.exe`
- `PRINTBIT_SUMATRA_PATH` (or `SUMATRA_PATH`) optional Sumatra fallback path
- `PRINTBIT_PRINT_DISPATCH_TIMEOUT_MS` (default `60000`)
- `PRINTBIT_PRINT_SPOOLER_MONITOR_WINDOW_MS` (default `180000`, minimum `30000`)
- `PRINTBIT_PRINT_SPOOLER_POLL_INTERVAL_MS` (default `1500`, minimum `250`)
- `PRINTBIT_PRINT_SPOOLER_LOOKBACK_MINUTES` (default `3`, minimum `1`)
- `PRINTBIT_PRINT_SPOOLER_QUERY_TIMEOUT_MS` (default `20000`, minimum `5000`)

## Mobile and network matrix

- Android: Chrome (latest stable + prior major) for `/upload/:token`
- iOS: Safari (latest stable + prior major) for `/upload/:token`
- Supported upload formats: PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, JPG, PNG
- Session continuity: upload page refreshes lease periodically and also on app resume (visibility/focus events)

### Network provider (ESP32)

- `PRINTBIT_NETWORK_PROVIDER=esp32` (default)
  - ESP32 provides AP + captive portal onboarding.
  - PrintBit still serves session/upload endpoints and `/portal` bridge.
  - `POST /api/hotspot/start` registers the kiosk with the ESP32 bridge.

Related env knobs:

- `PRINTBIT_HOTSPOT_SSID` (default `PrintBit`)
- `PRINTBIT_HOTSPOT_PASSWORD` (default empty)
- `PRINTBIT_HOTSPOT_AUTH_TYPE` (derived from password by default: `nopass` when empty, `WPA` otherwise)
- `PRINTBIT_ESP32_CAPTIVE_PORTAL_PATH` (default `/portal`)
- `PRINTBIT_ESP32_AP_BASE_URL` (default `http://192.168.4.1`) for kiosk registration endpoint
- `PRINTBIT_ESP32_REGISTER_TOKEN` (default `printbit-register-token`) shared token for ESP32 `/kiosk/register`
- `PRINTBIT_ESP32_KIOSK_SUBNET_PREFIX` (default `192.168.4.`) to detect kiosk IP for ESP32 mode
- `PRINTBIT_ESP32_KIOSK_IP` (default `192.168.4.2`) kiosk IP used by launch/watchdog URLs and startup static-IP enforcement in ESP32 mode
- `PRINTBIT_ESP32_STATIC_IP_ENFORCE` (default `false` in ESP32 mode) reconnects Wi-Fi; only reapplies kiosk static IPv4 when set to `true`
- `PRINTBIT_ESP32_KIOSK_NETMASK` (default `255.255.255.0`) netmask used by startup static-IP enforcement
- `PRINTBIT_ESP32_GATEWAY_IP` (optional) explicit ESP32 gateway override for startup static-IP enforcement (otherwise derived from `PRINTBIT_ESP32_AP_BASE_URL`)
- `PRINTBIT_ESP32_WIFI_INTERFACE` (optional) explicit Windows Wi-Fi interface alias for startup static-IP enforcement
- `PRINTBIT_ESP32_COIN_SOURCE` (default `esp32`) expected source label for `/coin` bridge requests
- `PRINTBIT_ESP32_COIN_API_KEY` (**required in `esp32` mode**) shared secret required by `/coin` bridge requests
- `PRINTBIT_ESP32_COIN_BRIDGE_RELAXED` (default `false`) simulation-only compatibility mode for legacy `/coin?value=` requests
- `PRINTBIT_ESP32_ALWAYS_ACCEPT_COINS` (default `true` in `esp32` mode) accepts coin credits even when slot/printer safety gates are active so kiosk UI balance keeps updating from ESP32 events
- `PRINTBIT_TRUSTED_TIME_ENFORCE` (default `false`) blocks or allows financial operations when trusted time cannot sync
- `PRINTBIT_SERIAL_PORT` (optional) to pin the serial coin/hopper device when multiple COM ports are present

Recommended `.env` for ESP32 mode:

```env
PRINTBIT_NETWORK_PROVIDER=esp32
PRINTBIT_HOTSPOT_SSID=PrintBit
PRINTBIT_HOTSPOT_PASSWORD=printbit123
PRINTBIT_HOTSPOT_AUTH_TYPE=WPA
# Fixed kiosk IP for reboot-stable ESP32 deployments
PRINTBIT_ESP32_KIOSK_IP=192.168.4.2
PRINTBIT_ESP32_AP_BASE_URL=http://192.168.4.1
PRINTBIT_ESP32_REGISTER_TOKEN=printbit-register-token
PRINTBIT_ESP32_STATIC_IP_ENFORCE=true
PRINTBIT_ESP32_KIOSK_NETMASK=255.255.255.0
# Optional interface/gateway overrides:
# PRINTBIT_ESP32_WIFI_INTERFACE=Wi-Fi
# PRINTBIT_ESP32_GATEWAY_IP=192.168.4.1
PRINTBIT_ESP32_COIN_SOURCE=esp32
PRINTBIT_ESP32_COIN_API_KEY=printbit-coin-bridge-key
# Keep strict mode for production and real ESP32 bridging
PRINTBIT_ESP32_COIN_BRIDGE_RELAXED=false
# Optional: keep ESP32 coin credits flowing even during printer/slot safety gates
PRINTBIT_ESP32_ALWAYS_ACCEPT_COINS=true
# Optional: turn on only when kiosk has stable NTP/internet access
PRINTBIT_TRUSTED_TIME_ENFORCE=false
```

Security note: `printbit-coin-bridge-key` is a predictable example value. Before deployment, generate a unique secret for `PRINTBIT_ESP32_COIN_API_KEY`, set it in the kiosk environment, and use the same value in ESP32 firmware (`coinBridgeApiKey` in `esp32-captive-portal.ino`). Do not reuse the default key in production.

Recommended `.ino` alignment for ESP32 mode:

- Use `WiFiManager.h` to connect ESP32 to your 2.4GHz LAN (STA mode)
- WiFiManager config portal SSID/password (firmware defaults): `PrintBit-Setup` / `printbit123`
- Point `PRINTBIT_ESP32_AP_BASE_URL` to the current ESP32 LAN IP (for example `http://192.168.1.120`)
- Handle kiosk registration on `POST /kiosk/register` (ESP32 listens on port `80`)
- Forward coins with secure `/coin` request headers:
  - `x-coin-source: esp32`
  - `x-coin-api-key: <same as PRINTBIT_ESP32_COIN_API_KEY>`
  - `x-coin-event-id: <unique id per coin>`
- For hopper change dispensing, support authenticated commands:
  - `POST /hopper/dispense` with `token`, `coins`, optional `requestId`
  - `GET /hopper/status?token=...` for live dispense state
  - Use the same shared secret as `PRINTBIT_ESP32_COIN_API_KEY` (`hopperControlToken` in `.ino`)

Troubleshooting mobile captive onboarding:

- If captive page does not auto-open after joining kiosk Wi-Fi, open the fallback upload link shown on Print screen.
- If session is expired/owned by another device, generate a new kiosk print session and scan again.
- If logs show `no adapter IP matches 192.168.4.x`, set `PRINTBIT_ESP32_KIOSK_IP` to the kiosk's current IP on the ESP32 network (for example `192.168.4.3`).

## Important notes

- Upload and machine state are persisted in `uploads/` and `printbit.sqlite`; do not delete these unintentionally during operation.
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
