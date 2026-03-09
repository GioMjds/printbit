# PrintBit API Documentation

Base URL: `http://<kiosk-ip>:3000`

## Authentication and access rules

- Most end-user routes are open on the local kiosk network.
- Admin APIs require:
  1. local-network access (when `adminLocalOnly` is enabled), and
  2. header `x-admin-pin: <PIN>`.

---

## System and hotspot

### `GET /api/config/hotspot`
Returns configured hotspot credentials.

### `POST /api/hotspot/start`
Starts hotspot process.

### `POST /api/hotspot/stop`
Stops hotspot process.

### `GET /api/session/active`
Returns currently active upload session token and URL (if available).

### `GET /portal`
Renders captive-portal bridge page for mobile users.

---

## Balance, pricing, and payment

### `GET /api/balance`
Returns current `balance` and `earnings`.

### `GET /api/pricing`
Returns pricing settings (`printPerPage`, `copyPerPage`, `colorSurcharge`).

### `POST /api/balance/reset`
Resets current balance to `0` (non-admin route currently available).

### `POST /api/balance/add-test-coin`
Testing/demo route to add synthetic coin values (`1`, `5`, `10`, `20`).

Request:

```json
{ "value": 5 }
```

### `POST /api/confirm-payment`
Primary confirmation endpoint for print/copy charging.

Request (print example):

```json
{
  "mode": "print",
  "sessionId": "uuid",
  "filename": "optional-selected-file",
  "copies": 1,
  "colorMode": "grayscale",
  "orientation": "portrait",
  "paperSize": "A4",
  "amount": 5
}
```

Response:

```json
{
  "ok": true,
  "chargedAmount": 5,
  "balance": 0,
  "earnings": 100,
  "change": {
    "requested": 2,
    "dispensed": 2,
    "state": "dispensed",
    "attempts": 1
  }
}
```

The `change` object is always present. `state` is one of `"none"`, `"dispensed"`, or `"failed"`. When `state` is `"failed"`, an `owedChangeId` and `message` are included — the owed change is recorded for admin resolution.

### Legacy endpoints

- `POST /upload` (single file upload, legacy path)
- `POST /print` (legacy print trigger using default options)

---

## Wireless upload sessions

### `GET /api/wireless/sessions`
Creates a new wireless session.

### `GET /api/wireless/sessions/by-token/:token`
Resolves a session by token.

### `GET /api/wireless/sessions/:sessionId`
Gets session details and uploaded document metadata.

### `GET /api/wireless/sessions/:sessionId/preview`
Returns preview content for uploaded file (PDF/image/HTML-converted).

### `POST /api/wireless/sessions/:sessionId/upload?token=<token>`
Uploads one file into the target session.

---

## Upload portal pages

### `GET /upload/:token`
Renders upload web page for tokenized session.

### `GET /upload/:token/:asset`
Serves upload page assets (`styles.css`, `app.js`).

---

## Scan APIs

### `POST /api/scan/jobs`
Creates a scan job.

### `GET /api/scan/jobs/:id`
Gets scan job status.

### `GET /api/scan/jobs/:id/result`
Downloads completed scan output.

### `POST /api/scan/preview`
Runs quick preview scan for copy flow.

### `GET /api/scan/preview/:filename`
Serves a saved preview scan file.

### `POST /api/scan/jobs/:id/cancel`
Requests scan job cancellation.

### `GET /api/scanner/status`
Returns scanner readiness for scan UI compatibility, including preferred device and basic capability info.

### `POST /api/scanner/scan`
Runs an interactive scan for the `/scan` page and returns preview page URLs + filename.

**Body parameters:**
- `source` — `"feeder"` (ADF document feeder) or `"glass"` (flatbed scanner glass). **Required.**
- `color` — `"color"` or `"grayscale"`. **Required.**
- `dpi` — `150`, `300`, or `600`. **Required.**

### `GET /api/scanner/wired/drives`
Lists currently detected removable USB drives.

### `POST /api/scanner/wired/export`
Exports a scanned file from `uploads/scans` to a selected removable USB drive.

### `POST /api/scanner/wireless-link`
Creates a temporary tokenized download link for a scanned file.

### `GET /scan/download/:token`
Downloads a scanned file using a temporary tokenized link.

---

## Copy APIs

### `POST /api/copy/jobs`
Creates a copy job from validated preview file. After successful print dispatch, charges balance and dispenses coin change via hopper (same settlement flow as print). The job `payment` field includes `chargedAmount` and `remainingBalance`.

### `GET /api/copy/jobs/:id`
Gets copy job status.

### `POST /api/copy/jobs/:id/cancel`
Requests copy job cancellation.

---

## Admin APIs

All routes below require admin local access + valid `x-admin-pin`.

### `POST /api/admin/auth`
Validates PIN.

### `GET /api/admin/summary`
Returns balance, earnings buckets, job stats, coin stats, storage, system status (including printer telemetry).

The `status.printer` object contains:

```json
{
  "connected": true,
  "name": "HP LaserJet Pro",
  "driverName": "HP Universal Printing PCL 6",
  "portName": "USB001",
  "status": "Idle",
  "ink": [
    { "name": "Ink / Toner", "level": null, "status": "unknown" }
  ],
  "lastCheckedAt": "2026-03-06T12:00:00.000Z",
  "lastError": null
}
```

Each `ink` entry has:
- `level`: `0`–`100` when the driver exposes it, `null` otherwise.
- `status`: `"ok"` | `"low"` | `"empty"` | `"unknown"`.

### `GET /api/admin/status`
Returns system/runtime status (includes `printer` telemetry with the same shape as above).

### `POST /api/admin/hopper/self-test`
Triggers a coin hopper self-test. Returns `{ ok, amount, message, attempts }`.

### `GET /api/admin/settings`
Returns settings. All pricing values are whole-peso integers.

### `PUT /api/admin/settings`
Updates pricing, timeout, PIN, and local-only guard. Pricing fields (`printPerPage`, `copyPerPage`, `scanDocument`, `colorSurcharge`) must be non-negative integers (whole pesos). Fractional values are rejected with `400`.

### `GET /api/admin/logs`
Returns logs (`?limit=1..1000`, default 200).

### `GET /api/admin/logs/export.csv`
Exports logs as CSV.

### `DELETE /api/admin/logs`
Clears logs.

### `POST /api/admin/balance/reset`
Resets balance to `0`.

### `POST /api/admin/storage/clear`
Clears top-level files under upload directory.

### `GET /api/admin/owed-changes`
Returns all owed change entries with counts: `{ total, openCount, resolvedCount, entries[] }`. Each entry has `id`, `timestamp`, `amount`, `reason`, `status` ("open"|"resolved"), and optional `meta`.

### `POST /api/admin/owed-changes/:id/resolve`
Marks a single owed change entry as resolved. Returns `{ ok, entry }`. Returns `404` if not found, `409` if already resolved.

### `POST /api/admin/owed-changes/resolve-all`
Bulk-resolves all open owed change entries. Returns `{ ok, resolvedCount }`.
