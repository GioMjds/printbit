# SCC Direct Print (Bypass) — Design

Date: 2026-11-26
Status: Approved (spec reviewed 2026-11-26)

## Goal

Let an administrator print a customer's file directly from the PIN-gated
`/scc` page, without using the kiosk screen or inserting coins. These are
customers who pay the operator directly (cash in hand, GCash). Revenue from
these prints is recorded in a separate "direct" earnings bucket so it never
mixes with coin-box earnings.

## Decisions

| Topic                 | Decision                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Earnings treatment    | Separate bucket. Charged at the normal kiosk price. Never added to coin-box `earnings`.                                               |
| File and option scope | Full kiosk parity: all upload types (office docs converted to PDF), copies, color/grayscale, paper size, duplex, page range, quality. |
| Approach              | Reuse the kiosk pipeline (`confirmPayment`) with a server-set `paymentSource: 'direct'`. No parallel print pipeline.                  |
| Price                 | Always the kiosk quote from `/api/print/quote`. No manual override.                                                                   |
| Customer identity     | Not recorded. One direct bucket.                                                                                                      |
| Developer mode        | Unchanged: test jobs skip both buckets.                                                                                               |

## Architecture

### Flow on `/scc`

1. The admin authenticates with the existing PIN gate (`initAuth`).
2. A new **Direct Print** panel creates an upload session with
   `GET /api/wireless/sessions`. The admin session token already satisfies
   `createKioskAccessMiddleware`.
3. The file is uploaded via `POST /api/wireless/sessions/:sessionId/upload`.
   Existing magic-byte validation, malware scan and office-to-PDF conversion
   apply.
4. Page and color analysis runs through
   `POST /api/wireless/sessions/:sessionId/analyze`. The price comes from
   `POST /api/print/quote`.
5. The admin sets print options, sees the price, and presses
   **Print (direct)**.
6. The page calls `POST /api/admin/direct-print/confirm` with the same body
   shape as `/api/confirm-payment` and an `Idempotency-Key` header.

### New admin route

`POST /api/admin/direct-print/confirm`

- Middleware: `requireAdminLocalAccess`, `requireAdminPin`, a rate limit
  (same style as `adminTestPrintRateLimit`).
- Sets `res.locals.paymentSource = 'direct'` server-side, then delegates to
  `FinancialService.confirmPayment`.
- Only `mode: 'print'` is accepted; any other mode returns 400.

### `confirmPayment` branch

`confirmPayment` reads `paymentSource` only from `res.locals`, never from
`req.body`. The value is `'direct'` or absent (`'kiosk'`).

When `paymentSource === 'direct'`:

- Skip `paymentAcceptorGate.disarm`, because no coin lease exists.
- Call `settlementService.settleDirect(...)` instead of `settle(...)`.
- Add `paymentSource: 'direct'` to:
  - `job_started` and `job_completed` ledger entry `meta`
  - the `payment_confirmed` admin log `meta`
  - the recovery checkpoint `context`
  - the refund `jobContext` on enqueue failure
- Everything else runs unchanged: pricing, receipt, consumable usage events,
  `enqueuePrintJob`, spooler monitoring, upload cleanup.

The kiosk route `/api/confirm-payment` behaves exactly as today. A
`paymentSource` field in a kiosk request body is ignored.

### `settleDirect` (`src/services/settlement.ts`)

- Calls `assertTrustedTimeForFinancialOperation('settlement:direct')`.
- Runs inside `withBalanceLock` so writes to `db.data` stay serialized with
  kiosk settlements.
- Does not read, zero, or emit `balance`. Does not dispense change.
- If the job is not a test job (same `environment === 'test'` /
  developer-mode check as `settle`), adds `requiredAmount` to
  `db.data.directEarnings`.
- Returns a `SettlementResult` with `ok: true`,
  `chargedAmount: requiredAmount`, `previousBalance` and `remainingBalance`
  equal to the untouched current balance, `earnings` = current coin-box
  earnings, and `change: { requested: 0, dispensed: 0, state: 'none' }`.

## Earnings separation

### Storage (`src/core/database/db.ts`)

- Add `directEarnings: number` to the data shape, default `0`, loaded with
  `finiteOr` like `earnings`. Existing databases load as `0`; no migration
  is needed.
- `db.data.earnings` remains coin-box earnings only.

### Bucket computation (`src/modules/admin/admin.service.ts`)

- `computeEarningsBuckets` skips logs whose `meta.paymentSource === 'direct'`.
- New `computeDirectEarningsBuckets(now)` returns `{ today, week, allTime }`
  using the same log scan, restricted to direct-tagged logs. `allTime` reads
  `db.data.directEarnings`.
- The earnings analytics view excludes direct-tagged entries from `totals`,
  `buckets` and `methods`, and adds
  `totals.direct: { today, week, month, year, allTime }`.
- The dashboard payload adds `directEarnings` next to `earnings`.

### Refunds (`src/services/pending-refund.ts`)

`upsertSpoolerFailureRefund` reads `jobContext.paymentSource`. When the
value is `'direct'` and `autoRefund` is true:

- Subtract the charged amount from `db.data.directEarnings`, floored at 0.
- Do not change `balance` or `earnings`.
- Record `restoredBalanceAmount: 0`.
- Tag the `refund_issued` ledger entry with `paymentSource: 'direct'`.
- Set the refund reason suffix to `(direct: refund customer manually)`.

Worker and startup-recovery callers do not pass `paymentSource`. The refund
service therefore also treats a transaction as direct when its `job_started`
ledger entry carries `paymentSource: 'direct'`.

`processPendingRefund` on a direct entry:

- `restoreBalance: true` is rejected with 409 ("Direct prints are refunded in
  cash, not kiosk balance.").
- A cash refund subtracts from `directEarnings` instead of `earnings`.

The kiosk refund path is unchanged.

## UI

### `/scc` Direct Print panel (`src/public/scc/`)

- File picker, options form (copies, color mode, paper size, duplex, page
  range, quality), live price from the quote endpoint, **Print (direct)**
  button.
- Shows job progress from the existing print socket events.
- Shows a readout of today's and all-time direct earnings.
- Buttons are disabled while a request is in flight. Errors are shown with
  the existing `setMessage` helper.
- Existing coin console sections stay as they are.

### `/admin/earnings`

- A separate **Direct (bypass)** card shows `totals.direct`. Kiosk totals
  and charts exclude direct revenue.

### `/admin/transactions`

- Rows tagged `paymentSource: 'direct'` show a **Direct** badge.

## Error handling

| Case                                       | Behavior                                                |
| ------------------------------------------ | ------------------------------------------------------- |
| No admin session                           | 401 from `requireAdminPin`.                             |
| Non-local request with `adminLocalOnly` on | 403 from `requireAdminLocalAccess`.                     |
| Power emergency                            | 503 `POWER_EMERGENCY` (existing check).                 |
| Trusted time unavailable                   | 503 (existing check), plus `settleDirect` assertion.    |
| Session expired or missing                 | 410/404 (existing checks).                              |
| Enqueue failure                            | Auto refund reverses `directEarnings`; 503 to the page. |
| Duplicate submit                           | Idempotency key returns the stored response.            |

## Testing

Jest, following existing spec patterns:

1. `settleDirect` leaves `balance` and `earnings` unchanged and increments
   `directEarnings`. In developer mode it increments nothing.
2. `computeEarningsBuckets` and `computeDirectEarningsBuckets` split a mixed
   set of logs correctly.
3. `upsertSpoolerFailureRefund` with a direct job context reverses
   `directEarnings` and does not credit `balance`.
4. `/api/confirm-payment` ignores `paymentSource` in the request body and
   still requires coin balance.
5. `/api/admin/direct-print/confirm` returns 401 without an admin session.

## Out of scope

- Per-customer names, accounts or breakdowns.
- Manual price override.
- Direct copy or scan jobs.
- Changes to the coin simulation part of `/scc`.
