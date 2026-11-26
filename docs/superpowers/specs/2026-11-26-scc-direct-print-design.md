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
| Direct totals source  | Derived from ledger entries tagged `paymentSource: 'direct'`. No stored counter.                                                     |

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
- Writes nothing: no balance change, no `earnings` change, no change
  dispensed, no socket emit. Revenue is recorded by the tagged
  `job_completed` ledger entry that `confirmPayment` already writes.
- Returns a `SettlementResult` with `ok: true`,
  `chargedAmount: requiredAmount`, `previousBalance` and `remainingBalance`
  equal to the untouched current balance, `earnings` = current coin-box
  earnings, and `change: { requested: 0, dispensed: 0, state: 'none' }`.

## Earnings separation

### Storage

- No schema change. `db.data.earnings` stays coin-box earnings only, because
  direct prints never touch it.
- Direct revenue is the sum of ledger `job_completed` entries tagged
  `paymentSource: 'direct'`, minus `refund_issued` entries with the same tag.
  Entries tagged `environment: 'test'` are excluded.

### Bucket computation (`src/modules/admin/admin.service.ts`)

- `computeEarningsBuckets` skips logs whose `meta.paymentSource === 'direct'`.
- The earnings analytics view excludes direct-tagged entries from `totals`,
  `buckets` and `methods`, and adds
  `totals.direct: { today, week, month, year, allTime }`, computed by
  `sumDirectLedger` (`src/modules/admin/earnings-split.ts`).

### Refunds (`src/services/pending-refund.ts`)

`upsertSpoolerFailureRefund` reads `jobContext.paymentSource`. When the
value is `'direct'` and `autoRefund` is true:

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
- A cash refund leaves `earnings` unchanged and tags its `refund_issued`
  ledger entry `paymentSource: 'direct'`.

The kiosk refund path is unchanged.

## UI

### `/scc` Direct Print panel (`src/public/scc/`)

- File picker, options form (copies, color mode, paper size, duplex, page
  range, quality), live price from the quote endpoint, **Print (direct)**
  button.
- After a successful submit, shows "Queued" with the amount and disables
  Print until a new file is chosen. No live printer status (the admin is at
  the printer).
- Buttons are disabled while a request is in flight. Errors are shown with
  the existing `setMessage` helper.
- Existing coin console sections stay as they are.

### `/admin/earnings`

- A separate **Direct (bypass)** card shows `totals.direct`. Kiosk totals
  and charts exclude direct revenue.

## Error handling

| Case                                       | Behavior                                                |
| ------------------------------------------ | ------------------------------------------------------- |
| No admin session                           | 401 from `requireAdminPin`.                             |
| Non-local request with `adminLocalOnly` on | 403 from `requireAdminLocalAccess`.                     |
| Power emergency                            | 503 `POWER_EMERGENCY` (existing check).                 |
| Trusted time unavailable                   | 503 (existing check), plus `settleDirect` assertion.    |
| Session expired or missing                 | 410/404 (existing checks).                              |
| Enqueue failure                            | Direct-tagged auto refund; coin balance untouched; 503. |
| Duplicate submit                           | Idempotency key returns the stored response.            |

## Testing

Jest, following existing spec patterns:

1. `settleDirect` leaves `balance` and `earnings` unchanged and writes
   nothing.
2. `sumDirectLedger` sums only direct, non-test completions minus direct
   refunds.
3. `upsertSpoolerFailureRefund` with a direct job context (tagged, or found
   via the ledger) does not credit `balance` and tags the refund. A direct
   pending refund rejects `restoreBalance: true` with 409.
4. `/api/confirm-payment` ignores `paymentSource` in the request body and
   still requires coin balance.
5. `/api/admin/direct-print/confirm` returns 401 without an admin session.

## Out of scope

- Per-customer names, accounts or breakdowns.
- Manual price override.
- Direct copy or scan jobs.
- Changes to the coin simulation part of `/scc`.
- Live print status and a direct-earnings readout on `/scc`.
- A Direct badge on `/admin/transactions`.
- Direct totals in the dashboard API.
