# CONTEXT.md — PrintBit

> Brief for AI coding assistants and new developers. Treat this as a **living document**.
> Update in the same PR that changes the architecture it describes.
> Last updated: 2026-07-01

PrintBit is a **Windows-only**, coin-operated self-service printing kiosk for campus environments.
Users upload files via a phone-to-kiosk QR flow; the kiosk accepts coins, dispatches print jobs,
dispenses change from a coin hopper, and emits tokenized E-Receipts. Hardware coin flow, payment
safety, and coin idempotency are first-class concerns — they shape the whole architecture.

This repo is the **Node.js / Express backend + static frontend**. A companion Windows Service in
`../printbit-worker/` (a separate `pnpm` workspace) handles the printer spooler bridge over named
pipes; it shares `printbit.sqlite` state and never opens HTTP.

---

## 1. Project overview

| Concern          | Value                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Domain           | Self-service printing kiosk (print, copy, scan, E-Receipt, admin)                                             |
| Backend          | Node.js ≥ 22.5, Express 5, Socket.IO 4, TypeScript 6 (strict mode)                                            |
| Storage          | SQLite via `node:sqlite` (`DatabaseSync`), repository pattern, no ORM                                         |
| Frontend         | Static HTML/CSS + esbuild bundles under `src/public/**` (no React, no SPA)                                    |
| Hardware bridges | `serialport` (coin acceptor + coin hopper on shared 115200 baud line), ESP32 HTTP bridge                      |
| Print dispatch   | Pluggable engines — PDFtoPrinter / GhostScript (+ optional Sumatra fallback), mode-gated by env |
| Scanner          | NAPS2 (`.Console.exe`) integration                                                                            |
| Package manager  | `pnpm` 10.x (this repo is the `printbit` package inside a `pnpm-workspace.yaml`)                              |
| OS               | Windows 11 only — hardware, COM ports, WMI, scheduled tasks, PowerShell scripts                               |
| Runtime node     | `tsx watch src/server.ts` (dev) / `node dist/server.js` (built)                                               |

---

## 2. Repository layout

```folder
printbit/
├── src/
│   ├── server.ts                   # Express + Socket.IO entrypoint
│   ├── app.module.ts               # Registers every feature module with the Express app
│   ├── config/                     # Env-driven runtime config (http.config.ts is the bulk)
│   ├── core/                       # Cross-cutting primitives (NOT feature logic)
│   │   ├── database/               # SQLite repository layer
│   │   │   ├── db.ts               # In-memory runtime_state facade (cache + atomic helpers)
│   │   │   ├── sqlite-storage.ts   # SQLite singleton + transaction wrapper
│   │   │   ├── idempotency.ts      # acquireIdempotencyKey / storeIdempotencyKey / release
│   │   │   ├── balance-lock.ts     # withBalanceLock (mutual exclusion over balance writes)
│   │   │   ├── shared.schema.ts    # Cross-module types (PrintMode, ColorMode, CoinStats, …)
│   │   │   └── models/             # One *SqliteStore class per domain (see §3)
│   │   ├── exceptions/             # HttpException family — use these in route handlers
│   │   └── middleware/             # error-handler.middleware.ts
│   ├── modules/                    # Feature modules (controller + service + module.ts)
│   │   ├── admin/                  # Admin auth, summary, settings, logs, transactions
│   │   ├── financial/              # Balance, pricing, confirm-payment, legacy upload/print
│   │   ├── printer/                # Print job dispatch + spooler supervision
│   │   ├── scanner/                # NAPS2 scanner adapter (scan, copy preview)
│   │   ├── copy/                   # Copy job lifecycle
│   │   ├── wireless-session/       # Phone upload session lifecycle (single-device ownership)
│   │   ├── upload-portal/          # /upload/:token page rendering + assets
│   │   ├── receipt/                # E-Receipt token mint/verify, customer + admin reads
│   │   ├── hotspot/                # ESP32 network provider and registration
│   │   ├── watchdog/               # PrintBit secondary health monitor
│   │   ├── hopper/                 # Coin hopper HTTP routes (forwarded to ESP32 in esp32 mode)
│   │   ├── anomaly/                # Anomaly detection / fingerprinting / alerts
│   │   ├── language/               # i18next-backed language switch (en, fil)
│   │   ├── feedback/               # Customer feedback submissions
│   │   ├── report/                 # "Report issue" submissions + admin queue
│   │   └── page/                   # HTML page route registration (PUBLIC_PAGE_ROUTES)
│   ├── services/                   # Cross-module business logic, singletons
│   │   ├── serial.ts               # Shared serial line (coin + hopper, 115200 baud)
│   │   ├── hopper.ts / hopper-protocol.ts  # Hopper dispense orchestration + Arduino protocol
│   │   ├── session.ts              # SessionStore singleton (in-memory)
│   │   ├── pricing-engine.ts       # PH-localized coverage-aware pricing
│   │   ├── document-analysis.ts    # Per-page coverage/classification (PDF + image)
│   │   ├── print-quote.ts          # Quote builder (legacy + pricing engine)
│   │   ├── print-dispatcher.ts / print-spooler.ts  # Dispatch engines + WMI spooler monitor
│   │   ├── printer.ts / printer-monitor.ts / printer-status.ts  # Print subsystem
│   │   ├── settlement.ts           # Charge balance + dispense change (shared by print & copy)
│   │   ├── recovery.ts             # Recovery session reconciliation on startup
│   │   ├── financial-ledger.ts     # Hash-chained financial event log
│   │   ├── watchdog-health.ts      # Watchdog self-test
│   │   ├── windows-printer-edge.ts # edge-js runspace to talk to Windows print APIs
│   │   └── index.ts                # Re-exports the service barrel for the rest of the app
│   ├── middleware/                 # Express middleware (captive portal, csrf, file-validation, …)
│   ├── public/                     # Static frontend (HTML per page + TypeScript bundles)
│   ├── guards/                     # Client-side TS guards (printer-guard.ts)
│   ├── runtime/                    # API-aware Express app builder (for tests / alt entrypoints)
│   └── utils/                      # Misc helpers (network, formatters, lockout, …)
├── tests/                          # Jest specs (mostly document-analysis + bug-repro)
├── scripts/                        # PowerShell ops scripts (startup, lockdown, watchdog, …)
├── bin/                            # External executables (PDFtoPrinter.exe, SumatraPDF.exe, …)
├── esp32-captive-portal.ino        # ESP32 firmware (STA + WiFiManager, captive portal)
├── printbit.sqlite                 # Runtime persisted state (DO NOT hand-edit)
├── uploads/                        # Runtime uploaded files (transient, deleted after job)
├── docs/                           # User/operator-facing docs
├── agent_docs/                     # Topic briefs (in_progress, hardware, print dispatch, doc sync)
├── API_DOCUMENTATION.md            # Full HTTP API surface
├── ARCHITECTURE.md                 # Layer narrative + data flow diagrams
├── OPERATIONS.md                   # Runbook (start/stop, pre-flight, pricing engine rollout)
└── AGENTS.md                       # Project rules file (overrides default behavior)
```

**Repository structure conventions to preserve:**

- Every feature lives in `src/modules/<name>/{*.controller.ts, *.service.ts, *.module.ts, *.schema.ts, index.ts}`.
- Module registration function is exported from `index.ts` (see `src/modules/module.types.ts`).
- A new module must be wired into `src/app.module.ts::registerAppModules`.
- HTTP-facing schemas live in `src/modules/<name>/*.schema.ts`. Cross-module types live in `src/core/database/shared.schema.ts`.

---

## 3. Domain model

All persistent state is in `printbit.sqlite` via the repository classes in `src/core/database/models/`.
Process-memory state lives in singleton services (e.g. `SessionStore`, `JobStore`).

```diagram
                          ┌─────────────────────┐
                          │   wireless_sessions │
                          │  (phone upload)     │
                          └────────┬────────────┘
                                   │ session_id (FK)
                                   ▼
                       ┌───────────────────────────┐
                       │ wireless_session_documents│
                       │  file + analysisJson      │
                       └───────────────────────────┘

  ┌────────────────┐   ┌──────────────────┐   ┌──────────────────┐
  │ receipt_records│◀──│ receipt_access_  │   │   admin_logs     │
  │ (snapshot)     │   │   tokens         │   │   (audit trail)  │
  └────────────────┘   └──────────────────┘   └──────────────────┘
           ▲                                          ▲
           │ transactionId                            │ meta
           │                                          │
  ┌────────────────┐                         ┌──────────────────┐
  │ print_jobs     │                         │ financial_ledger │
  │ (in-flight)    │                         │ (hash-chained)   │
  └────────────────┘                         └──────────────────┘
           ▲                                          ▲
           │                                          │
  ┌────────────────┐  ┌──────────────────┐  ┌────────────────┐
  │ owed_changes   │  │ pending_refunds  │  │ feedback       │
  │ (hopper fail)  │  │ (admin refund)   │  │ report_issues  │
  └────────────────┘  └──────────────────┘  └────────────────┘

  ┌────────────────────┐   ┌────────────────────┐   ┌─────────────────┐
  │ runtime_state (1)  │   │ pricing_settings   │   │ admin_settings  │
  │ → balance,         │   │ → paperProfiles,   │   │ → adminPin,     │
  │   earnings,        │   │   thresholds,      │   │   lockout,      │
  │   coinStats,       │   │   blankPagePolicy, │   │   localOnly     │
  │   jobStats,        │   │   bulkTiers,       │   └─────────────────┘
  │   settings,        │   │   rounding         │
  │   analysisCache    │   └────────────────────┘
  └────────────────────┘
```

| Domain           | Table / Store                                                          | Primary key      | Notable fields                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime cache    | `runtime_state` (id=1) — `db.ts::RuntimeDb`                            | `id=1`           | `balance`, `earnings`, `coinStats{1,5,10,20}`, `jobStats`, `settings` (pricing/pricingEngine), `analysisCache`                           |
| Wireless session | `wireless_sessions` — `wireless-session.model.ts`                      | `sessionId`      | `token`, `status`, `ownerClientId`, `ownerClaimedAt`, `lastActivityAt` (TTL 5 min, server-side)                                          |
| Session document | `wireless_session_documents`                                           | `documentId`     | `sessionId` (FK), `filePath`, `analysisJson`, `analysisStatus`, `analysisVersion`                                                        |
| Receipt snapshot | `receipt_records` — `receipt.model.ts`                                 | `id`             | `transactionId`, `mode`, `chargedAmount`, `status`, `change{requested,dispensed,state,attempts,owedChangeId}`, `expiresAt` (24h default) |
| Receipt token    | `receipt_access_tokens`                                                | `id`             | `receiptId` (FK), `tokenHash` (NOT raw token), `expiresAt`, `revokedAt`                                                                  |
| Print job        | `print_jobs` — `print-job.model.ts`                                    | `id`             | `sessionId`, `dispatchMode`, `state`, `spoolerCorrelationKey`, `terminalAt`                                                              |
| Spooler life     | `spooler_lifecycle`                                                    | `correlationKey` | `state`, `lastCheckedAt`, `attempts`, `pausedAt`                                                                                         |
| Admin log        | `admin_logs` — `admin.model.ts`                                        | `id`             | `timestamp`, `timestampMeta` (NTP or system), `actor`, `action`, `meta` (LogMeta)                                                        |
| Owed change      | `owed_changes` — `payment.model.ts`                                    | `id`             | `amount`, `reason`, `status` (`open` / `resolved`), `meta`                                                                               |
| Pending refund   | `pending_refunds`                                                      | `id`             | `chargedAmount`, `status` (`open` / `refunded` / `dismissed`), `jobContext`                                                              |
| Financial ledger | `financial_ledger` — `payment.model.ts`                                | `id`             | `eventType`, `amount`, `previousHash`, `hash` (hash-chained)                                                                             |
| Feedback         | `feedback` / `feedback_sessions`                                       | `id`             | Customer-submitted feedback with optional session linkage                                                                                |
| Report issue     | `report_issues` / `report_issue_sessions` / `report_issue_attachments` | `id`             | User-submitted "report a problem" with attachments                                                                                       |
| Consumables      | `consumables` — `consumables.model.ts`                                 | (singleton)      | Toner/ink level tracking                                                                                                                 |
| Pricing cache    | `pricing_analysis_cache`                                               | `fileHash`       | Cached per-page coverage analysis                                                                                                        |
| Anomaly incident | `anomaly_incidents`                                                    | `id`             | Fingerprinted anomaly events                                                                                                             |
| Recovery         | `recovery_sessions` — `recovery.model.ts`                              | `id`             | Tracks in-flight settlements to reconcile on restart                                                                                     |

**Ephemeral (in-memory) state:**

- `SessionStore` (`src/services/session.ts`) — wireless session ownership + active token
- `JobStore` (`src/services/job-store.ts`) — copy/scan job state machine
- `PricingAnalysisQueue` — per-session document analysis job queue
- Hotspot / serial / printer / scanner runtime process flags

**Confirmation outcome:** a pure client-side Print Job state for a settled customer action after
terminal evidence arrives. It correlates transaction and spooler identities, keeps a terminal
failure ahead of any late success for the same Print Job, and selects the customer outcome
(`success` or staff-assisted maintenance) together with receipt availability, including a receipt
that becomes available after a maintenance outcome. Its interface accepts normalized Print Job
evidence and returns state and outcome only; it does not own Socket.IO payload translation,
browser storage, pricing, balance display, printing progress, or DOM rendering. On reload, the
browser adapter translates persisted payment identity into restoration evidence.

**Schema change rules:**

- New columns → add migration in the relevant `*.model.ts` `migrate()` function and call it from `getSqliteDb()` initialization.
- DB columns are `snake_case`; TypeScript interfaces are `camelCase`. Conversion happens in the model's `prepare*` / `map*` helpers — never call raw `db.prepare(...).all()` from controllers.

---

## 4. API surface

Base URL: `http://<kiosk-ip>:3000`. See `API_DOCUMENTATION.md` for full request/response shapes.
Admin endpoints require both a local-network check and `x-admin-pin: <PIN>` header.

| Route prefix                                                                           | Module              | Notes                                                                  |
| -------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `/api/balance` (+ `/reset`, `/add-test-coin`)                                          | financial           | `GET` open; mutations are admin-protected                              |
| `/api/pricing` / `/api/pricing-config`                                                 | financial           | Config returns pricing engine config (`enabledMode`, paperProfiles, …) |
| `/api/print/quote` / `/api/confirm-payment`                                            | financial           | Quote returns server-verified page counts; confirm settles + dispenses |
| `/coin` (legacy `?value=`)                                                             | financial           | ESP32 coin bridge; idempotency via `x-coin-event-id` (NEVER remove)    |
| `/api/wireless/sessions[/:id[/preview]]`                                               | wireless-session    | Single-device ownership via `x-upload-client-id` UUID v4               |
| `/api/wireless/sessions/:id/upload`                                                    | wireless-session    | Requires `x-upload-client-id` match                                    |
| `/api/analyze-job`                                                                     | financial           | Pricing analysis job queue/status                                      |
| `/upload/:token[/:asset]`                                                              | upload-portal       | Tokenized mobile upload page + assets                                  |
| `/api/scan/jobs[/:id[/result]]`                                                        | scanner             | Scan job lifecycle (create, status, download, cancel)                  |
| `/api/scan/preview[/:filename]`                                                        | scanner             | Copy-flow preview scan with short-lived `releaseToken`                 |
| `/api/scanner/{status,scan,wired/drives,wired/export,wireless-link,release}`           | scanner             | `color` + `dpi` required; USB export returns `423` in lockdown         |
| `/api/copy/jobs[/:id[/confirm]]`                                                       | copy                | Same settlement flow as print                                          |
| `/api/receipts/by-token/:token`                                                        | receipt             | Customer-safe, 24h expiry; `404` / `403` / `410` per token state       |
| `/api/admin/*`                                                                         | admin               | Summary, settings, transactions, logs, feedback, report, alerts, …     |
| `/api/admin/transactions/:id/{context,receipt}`                                        | admin               | Admin support lookup without exposing customer tokens                  |
| `/api/transactions/:id/receipt`                                                        | receipt (legacy)    | Transaction-ID compat path                                             |
| `/api/hotspot/start`                                                                   | hotspot             | No-op in `esp32` mode                                                  |
| `/api/hopper/{dispense,status}`                                                        | hopper              | Forwards to ESP32 in `esp32` mode, else serial                         |
| `/api/printer/status`                                                                  | printer             | Used by `printer-guard.ts` client gate                                 |
| `/api/config/hotspot` / `/api/session/active`                                          | app.module (legacy) | Pre-module shim endpoints (do not move)                                |
| `/receipt/t/:token` / `/receipt/:transactionId`                                        | page (HTML)         | Receipt page (public + admin paths)                                    |
| `/print`, `/copy`, `/scan`, `/config`, `/confirm`, `/`                                 | page (HTML)         | Kiosk pages                                                            |
| `/admin/{dashboard,earnings,system,settings,logs,transactions,feedback,report,alerts}` | page (HTML)         | Admin pages                                                            |
| `/portal`                                                                              | page                | ESP32 captive-portal bridge                                            |

**Socket.IO events** broadcast from the server (consumed by `printer-guard.ts`, `idle-timeout.ts`,
admin dashboard, confirm page): `balance`, `coin`, `print:status`, `printerMalfunction`,
`printerRecovered`, `serial:status`, `hopper:status`, session-level upload events.

---

## 5. Architectural patterns and conventions

These rules are non-obvious and load-bearing. Violating them is the most common source of regressions.

### Module registration

- Each `src/modules/<name>/` exports a `register*Module(app, deps)` function. The signature is
  typed by `ModuleRegisterFn` in `src/modules/module.types.ts`.
- Modules are wired in `src/app.module.ts::registerAppModules` — add new modules there, **not** in
  `server.ts`. `server.ts` only bootstraps Express + Socket.IO + the lifecycle.
- Deps flow inwards: `server.ts` → `app.module.ts` → modules. Never import from `src/services/index.ts` inside a module's controller; import the specific file (e.g. `import { sessionStore } from '@/services/session'`).

### Database access

- **All** DB operations go through `src/core/database/models/*.ts` (the `*SqliteStore` classes).
  No controller, route, or service should ever import `node:sqlite` directly.
- `withTransaction(handler)` is the only safe way to make multi-statement writes. The default
  `db.exec('BEGIN IMMEDIATE')` is used for write transactions to avoid SQLITE_BUSY.
- Balance mutations **must** go through `withBalanceLock` to serialize concurrent coin/job/reset operations.
- Coin-event idempotency **must** use `acquireIdempotencyKey` / `storeIdempotencyKey` / `releaseIdempotencyKey`. Removing the `x-coin-event-id` check causes double-credit — see `agent_docs/hardware-integration.md`.

### Errors

- Throw `HttpException` subclasses from `src/core/exceptions/` (e.g. `BadRequestException`, `NotFoundException`, `ConflictException`, `ServiceUnavailableException`). The error handler middleware converts them to consistent JSON responses. Do not `res.status(…).json(…)` directly in controllers.

### Schemas and validation

- HTTP-facing request bodies must be validated in the controller (or schema) before reaching services.
- TypeScript types for cross-module domain objects live in `src/core/database/shared.schema.ts`. Add a type there once and import from both sides — do not redefine in two modules.

### Frontend

- Static pages under `src/public/<page>/index.html` import a shared TypeScript bundle built by esbuild (`scripts/build-client.js`).
- Client-side guards (`printer-guard.ts`, `idle-timeout.ts`) are in `src/guards/`. They subscribe to Socket.IO and gate UI. Pattern is identical: call `initXxxGuard(socket)` from the page's bootstrap.
- All coin-accepting kiosk pages must initialize the printer guard so coin input is gated when the printer is down.

### Hardware boundaries

- Serial port is owned by `src/services/serial.ts`. **Do not open a new serial connection elsewhere.** Coin and hopper share one 115200-baud line.
- ESP32 bridge headers are required on `/coin` and `/hopper/*`: `x-coin-source`, `x-coin-api-key`, `x-coin-event-id`. See `agent_docs/hardware-integration.md`.
- ESP32 firmware (`esp32-captive-portal.ino`) is **STA-mode only** (WiFiManager). Do not re-introduce AP-only mode — it caused phantom coin events.

### Print dispatch

- Mode is gated by `PRINTBIT_PRINT_DISPATCH_MODE` (`legacy` | `phased` | `new-only`). See `agent_docs/print_dispatch.md`.
- The dispatcher is asynchronous — `confirm-payment` returns `print.state: "awaiting_spooler_terminal"` and the spooler monitor (`src/services/print-spooler.ts`) reconciles terminal state via WMI.
- LibreOffice conversion runs in the C# worker with its own configured timeout and isolated profile.

### Pricing engine

- Three modes: `legacy` (default), `shadow` (parallel compute, not billed), `live` (engine bills). See `OPERATIONS.md` §"Pricing Engine Configuration and Rollout" before switching to `live`.
- `blankPagePolicy`, `thresholds.{bwMax,fullColorMin}`, `colorMultiplier`, `bulkTiers`, and `rounding` live in `settings.pricingEngine`. All prices are whole-peso integers (hopper only dispenses 1-peso coins).

### E-Receipts

- v1 scope is `mode: "print"` and `mode: "copy"`. Tokenized customer access (`/receipt/t/:token`) and admin support access (`GET /api/admin/transactions/:id/receipt`) coexist.
- Tokens are stored **hashed** (`tokenHash`); never log or persist raw tokens. Default retention is 24h; cleanup runs at startup and every 15 min.

### Financial integrity

- `financial_ledger` is hash-chained (`previousHash` + `hash`). Append-only — do not implement edits or deletes on this table.
- `PRINTBIT_TRUSTED_TIME_ENFORCE=true` blocks financial operations when NTP cannot sync. Default is `false`. When flipping to `true`, ensure NTP is reachable first.

### Documentation sync (see `agent_docs/documentation_sync.md`)

| What changed                                   | Update                                               |
| ---------------------------------------------- | ---------------------------------------------------- |
| New/changed HTTP route or response shape       | `API_DOCUMENTATION.md`                               |
| New/changed env var                            | `README.md` env table + `.env` example               |
| New user-facing flow or UX step                | `README.md` end-user guides                          |
| Service / layer / data-flow change             | `ARCHITECTURE.md`                                    |
| Startup / shutdown / diagnostic runbook change | `OPERATIONS.md`                                      |
| New binary dependency / install step           | `INSTALLATIONS.md` (and `OPERATIONS.md` if relevant) |
| Lockdown / watchdog script change              | `WINDOWS_KIOSK_LOCKDOWN_SETUP.md` / `OPERATIONS.md`  |
| ESP32 firmware / wiring change                 | `WINDOWS_TABLET_ESP32_KIOSK_SETUP.md`                |
| Domain model / patterns / module layout change | **`CONTEXT.md` (this file)**                         |

---

## 6. Build, run, and test commands

| Action                             | Command                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| Install dependencies               | `pnpm install`                                                                        |
| Dev server (auto-restart)          | `pnpm dev` → `tsx watch src/server.ts` on `http://0.0.0.0:3000`                       |
| Build client + server bundles      | `pnpm run build` → `node scripts/build-client.js` then `node scripts/build-server.js` |
| Start built server                 | `pnpm start` → `node dist/server.js`                                                  |
| Type-check                         | `pnpm exec tsc --noEmit --ignoreDeprecations 6.0` (required after any `.ts` change)   |
| Lint                               | `pnpm run lint` / `pnpm run lint:fix`                                                 |
| Test                               | `pnpm test` (Jest; `*.spec.ts`, `*.int.ts`, `*.e2e.ts`)                               |
| Reset database (dev)               | `pnpm run db:reset`                                                                   |
| One-time legacy import             | `pnpm run db:migrate:legacy` (use `-- --force` to rerun)                              |
| Launch in kiosk mode (Windows)     | `pnpm run kiosk`                                                                      |
| Ensure ESP32 network on boot       | `pnpm run ensure-network` (PowerShell)                                                |
| Install/uninstall startup task     | `pnpm run install-startup` / `pnpm run uninstall-startup`                             |
| Watchdog install/verify/uninstall  | `pnpm run watchdog:install` / `:verify` / `:uninstall`                                |
| Kiosk lockdown apply/verify/revert | `pnpm run lockdown:apply` / `:verify` / `:revert`                                     |
| Controlled updates policy          | `pnpm run updates:apply` / `:verify` / `:revert`                                      |
| Verify printer driver version      | `pnpm run driver:verify`                                                              |

> **`@/*` path alias** points to `./src/*` (set in `tsconfig.json`). Use it in all imports.
> Do not introduce a different alias.

---

## 7. Environment variables

Defaults shown in `[]`. `PRINTBIT_` prefix is the canonical form; a few keys also accept a legacy unprefixed alias.

### Server & Network

| Var                               | Default                    | Purpose                                            |
| --------------------------------- | -------------------------- | -------------------------------------------------- |
| `PORT`                            | `3000`                     | HTTP listen port                                   |
| `PRINTBIT_NETWORK_PROVIDER`       | `esp32`                    | `esp32` — selects hotspot/captive flow             |
| `PRINTBIT_HOTSPOT_SSID`           | `PrintBit`                 | Hotspot SSID                                       |
| `PRINTBIT_HOTSPOT_PASSWORD`       | ``                         | Hotspot password; empty → `nopass`, else `WPA`     |
| `PRINTBIT_HOTSPOT_AUTH_TYPE`      | derived                    | Override derived auth type                         |
| `PRINTBIT_PUBLIC_URL`             | (unset)                    | Public base URL override (e.g. Cloudflare Tunnel)  |
| `PRINTBIT_CAPTIVE_PORTAL`         | `true`                     | Set `false` to disable captive portal middleware   |
| `PRINTBIT_KIOSK_LOCKDOWN`         | `false`                    | Enables Windows Assigned Access lockdown policies  |
| `PRINTBIT_USB_EXPORT_ENABLED`     | `true` (false in lockdown) | Toggle USB mass-storage export                     |
| `PRINTBIT_SESSION_EXPIRY_ENABLED` | `true`                     | Enforce 5-min idle TTL on wireless upload sessions |

### ESP32 bridge

| Var                                  | Default                      | Purpose                                                          |
| ------------------------------------ | ---------------------------- | ---------------------------------------------------------------- |
| `PRINTBIT_ESP32_CAPTIVE_PORTAL_PATH` | `/portal`                    | Path PrintBit exposes for the ESP32 captive page                 |
| `PRINTBIT_ESP32_AP_BASE_URL`         | `http://192.168.4.1`         | ESP32 LAN base URL                                               |
| `PRINTBIT_ESP32_REGISTER_TOKEN`      | `printbit-register-token`    | Shared secret for ESP32 `POST /kiosk/register`                   |
| `PRINTBIT_ESP32_KIOSK_SUBNET_PREFIX` | `192.168.4.`                 | Subnet prefix for kiosk IP auto-detection                        |
| `PRINTBIT_ESP32_KIOSK_IP`            | (auto)                       | Explicit kiosk IP override (`192.168.4.2` in production)         |
| `PRINTBIT_ESP32_KIOSK_NETMASK`       | `255.255.255.0`              | Netmask for startup static-IP enforcement                        |
| `PRINTBIT_ESP32_GATEWAY_IP`          | (derived)                    | Gateway override for startup static-IP enforcement               |
| `PRINTBIT_ESP32_WIFI_INTERFACE`      | (auto)                       | Windows Wi-Fi interface alias for startup static-IP enforcement  |
| `PRINTBIT_ESP32_STATIC_IP_ENFORCE`   | `false`                      | Reapplies static IP on startup (opt-in)                          |
| `PRINTBIT_ESP32_COIN_SOURCE`         | `esp32`                      | Required `x-coin-source` header value                            |
| `PRINTBIT_ESP32_COIN_API_KEY`        | **(required in esp32 mode)** | Shared secret with ESP32 firmware; rejected at boot if missing   |
| `PRINTBIT_ESP32_COIN_BRIDGE_RELAXED` | `false`                      | **Simulation only** — accepts legacy `/coin?value=` without auth |
| `PRINTBIT_ESP32_ALWAYS_ACCEPT_COINS` | `true` (esp32)               | Accepts ESP32 coin credits even during slot/printer safety gates |

### Print Dispatch

| Var                                              | Default                | Purpose                                 |
| ------------------------------------------------ | ---------------------- | --------------------------------------- |
| `PRINTBIT_PRINT_DISPATCH_MODE`                   | `legacy`               | `legacy` / `phased` / `new-only`        |
| `PRINTBIT_PDFTOPRINTER_PATH`                     | `bin/PDFtoPrinter.exe` | PDFtoPrinter binary                     |
| `PRINTBIT_GHOSTSCRIPT_PATH`                      | PATH `gswin64c`        | GhostScript binary                      |
| `PRINTBIT_LIBREOFFICE_PATH`                      | PATH `soffice`         | LibreOffice binary                      |
| `PRINTBIT_SUMATRA_PATH`                          | `bin/SumatraPDF.exe`   | Optional Sumatra fallback (phased mode) |
| `PRINTBIT_PRINT_DISPATCH_TIMEOUT_MS`             | `60000`                | Default per-job dispatch timeout        |
| `PRINTBIT_PRINT_DISPATCH_LIBREOFFICE_TIMEOUT_MS` | `120000` (min 10s)     | LibreOffice timeout (slow first launch) |

### Spooler monitor

| Var                                        | Default            | Purpose                              |
| ------------------------------------------ | ------------------ | ------------------------------------ |
| `PRINTBIT_PRINT_SPOOLER_MONITOR_WINDOW_MS` | `180000` (min 30s) | WMI spooler monitoring window        |
| `PRINTBIT_PRINT_SPOOLER_POLL_INTERVAL_MS`  | `1500` (min 250ms) | Polling interval                     |
| `PRINTBIT_PRINT_SPOOLER_LOOKBACK_MINUTES`  | `3` (min 1)        | How far back to query spooler events |
| `PRINTBIT_PRINT_SPOOLER_QUERY_TIMEOUT_MS`  | `20000` (min 5s)   | WMI query timeout                    |

### Hardware / financial

| Var                             | Default | Purpose                                         |
| ------------------------------- | ------- | ----------------------------------------------- |
| `PRINTBIT_SERIAL_PORT`          | (auto)  | Pin serial COM port (e.g. `COM6`)               |
| `PRINTBIT_TRUSTED_TIME_ENFORCE` | `false` | Block financial operations when NTP cannot sync |

### Worker (named-pipe bridge to the .NET Hardware Service)

| Var                                 | Default                  | Purpose                                            |
| ----------------------------------- | ------------------------ | -------------------------------------------------- |
| `PRINTBIT_WORKER_QUEUE_DIR`         | (unset)                  | Override worker queue directory                    |
| `PRINTBIT_WORKER_FAILED_DIR`        | (unset)                  | Override worker failed-jobs directory              |
| `PRINTBIT_WORKER_PIPE_NAME`         | `printbit-node-errors`   | Inbound named pipe from the worker                 |
| `PRINTBIT_WORKER_RETURN_PIPE_NAME`  | `printbit-worker-events` | Outbound named pipe to the worker                  |
| `PRINTBIT_WORKER_RETURN_MAX_BYTES`  | `8192` (min 256)         | Max message size on the return pipe                |
| `PRINTBIT_WORKER_PRECHECKS_ENABLED` | `true`                   | Toggle pre-dispatch checks (set `false` to bypass) |

> **Production note:** `printbit-coin-bridge-key` is a predictable example value. Before deployment,
> generate a unique `PRINTBIT_ESP32_COIN_API_KEY` and set the same value in ESP32 firmware
> (`coinBridgeApiKey` in `esp32-captive-portal.ino`).

---

## 8. Testing strategy

- **Framework:** Jest 30 + ts-jest (Node environment). Config in `jest.config.ts`.
- **Test location:** Co-located where practical, plus a top-level `tests/` for cross-cutting specs
  (e.g. `document-analysis.spec.ts`, `bug-repro.spec.ts`).
- **Naming:** `*.spec.ts` (unit), `*.int.ts` (integration), `*.e2e.ts` (end-to-end).
- **Mocking:** Jest manual mocks in `tests/mock_data/`. For hardware-adjacent tests, prefer
  in-memory fakes over real serial/spooler interactions.
- **What to test:**
  - Pricing engine classification + tier math (high signal, low hardware dependency).
  - Idempotency / balance-lock serialization (concurrency invariants).
  - Receipt snapshot shape + token status codes (`404` / `403` / `410`).
  - Session expiry / ownership conflict.
  - Document analysis edge cases (blank, BW, partial, full color).
- **What NOT to test:** Hardware-in-the-loop paths (real serial, real printer, real ESP32) — those
  need the operator runbook in `OPERATIONS.md`, not unit tests.
- **Pre-commit:** Lint-staged runs ESLint --fix on staged `.ts` files. No Jest hook by default —
  CI/test runs are manual.

---

## 9. Known gaps and constraints

These are real, intentional constraints. Do not "fix" them by adding infrastructure that wasn't requested.

| Area                   | Gap / constraint                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform**           | Windows-only. No Linux/macOS support planned — `edge-js`, WMI, COM ports, and PowerShell scripts tie it to Windows.                                                              |
| **TLS**                | No HTTPS configured by default. Kiosks are deployed on isolated LANs; a reverse proxy is the documented path.                                                                    |
| **Auth**               | Admin auth is PIN + Argon2id + httpOnly cookie + local-network gate + 5-tap gesture + lockout. No SSO.                                                                           |
| **Print workers**      | A companion `printbit-worker` .NET Windows Service exists separately (not in this repo's `src/`) and shares `printbit.sqlite` via named pipes. Do not move its code into `src/`. |
| **Coin support**       | Only 1-peso coins are dispensed by the hopper. All prices are whole-peso integers by design.                                                                                     |
| **Idempotency**        | `x-coin-event-id` is required on `/coin` and enforced on both ESP32 (suppress retransmit) and the kiosk (dedupe). **Never remove either check.**                                 |
| **Print dispatcher**   | Mode is environmental (`legacy` / `phased` / `new-only`). Switching modes is an admin action and should be tested with a canary first.                                           |
| **Pricing engine**     | `enabledMode` defaults to `legacy`. Switch to `live` only after running `shadow` for ≥24h with deltas audited.                                                                   |
| **E-Receipts**         | v1 scope is `print` + `copy` only. Scan receipts are not implemented.                                                                                                            |
| **USB export**         | Disabled by default in kiosk lockdown mode. `/api/scanner/wired/drives` and `/export` return `423 USB_EXPORT_DISABLED`.                                                          |
| **Session ownership**  | Single-device per session via `x-upload-client-id`. Clients must generate a UUID v4 per device. Concurrent phones get `409 SESSION_OWNED`.                                       |
| **i18n**               | `en` and `fil` only. `i18n.config.ts` is intentionally not exported.                                                                                                             |
| **Frontend**           | No framework — static HTML + esbuild bundles. Pages subscribe to Socket.IO directly.                                                                                             |
| **Database**           | Local SQLite only. Not suitable for high-concurrency or multi-kiosk deployments (per `SECURITY.md`).                                                                             |
| **Test runner**        | Active but limited coverage — most tests target pricing engine and bug-repros, not full integration flows.                                                                       |
| **Migrations**         | No formal migration tool. Schema changes are applied via `migrate()` functions in each `*SqliteStore` class.                                                                     |
| **NTP**                | Optional. `PRINTBIT_TRUSTED_TIME_ENFORCE=false` by default. When `true`, financial ops are blocked if NTP is unreachable.                                                        |
| **Active in-progress** | See `agent_docs/in_progress.md`: session lifecycle, ESP32 bridge, print dispatch, lockdown/watchdog, security hardening — avoid broad refactors in these areas.                  |

---

## 10. Companion workspace: `printbit-worker/`

`../printbit-worker/` is a sibling `pnpm` workspace — a .NET 10 Windows Service that:

- Watches the Windows print queue and dispatches jobs through the spooler.
- Listens on a named pipe for Node.js error payloads and prints them.
- Emits print lifecycle events back to PrintBit on a separate named pipe.

It is **not** an HTTP service. Treat it as a separate repo: its own `AGENTS.md` is authoritative for
changes inside it. Only the IPC contracts (pipe names, message shapes, idempotency keys) are
shared. The `PRINTBIT_WORKER_*` env vars above are the contract surface from PrintBit's side.

---

## 11. Quick orientation for new sessions

1. Read `AGENTS.md` (project rules) and `agent_docs/in_progress.md` (active work).
2. Skim this file end-to-end.
3. If the change touches a feature module, open `src/modules/<name>/index.ts` and follow the
   controller → service → `*SqliteStore` chain.
4. If the change touches hardware, read `agent_docs/hardware_integration.md` first.
5. If the change touches print dispatch, read `agent_docs/print_dispatch.md` first.
6. Run `pnpm exec tsc --noEmit --ignoreDeprecations 6.0` after every `.ts` edit.
7. Update docs in the same PR (see §5 "Documentation sync").
8. If something is unclear or appears to violate these conventions, **surface it** — do not silently
   pick one interpretation.
