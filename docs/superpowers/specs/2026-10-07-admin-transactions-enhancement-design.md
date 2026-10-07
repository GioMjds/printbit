# Admin Transactions Enhancement: Physical Cash Refunds, Owed Change Settlement & Page Output Reports

- **Date:** 2026-10-07
- **Status:** Approved
- **Scope:** `src/public/admin/transactions`, `src/modules/admin`, `src/services/pending-refund`, `src/services/financial-ledger`

---

## 1. Overview & Context

In a physical kiosk environment, real-world failures happen: paper jams midway through a print job, low toner, coin hopper jams or empty coin tubes during change dispensing. Currently, the Admin Transactions view (`src/public/admin/transactions`) only displays historical log records and telemetry without allowing the administrator to resolve real-world student disputes on-site.

This design introduces:
1. **Physical Cash Refund Flow**: Directly from the transaction drawer, adjusting kiosk earnings and ledger records while preserving kiosk screen balance.
2. **Inline Owed-Change Resolution**: One-click resolution for students who were shortchanged when the coin hopper jammed or ran empty.
3. **Print Output & Page Discrepancy Audit**: Visual breakdown of pages requested vs pages confirmed printed by hardware, with automatic pro-rated refund calculation.
4. **Aggregate Page Output Summary Report**: Kiosk-wide production and financial reconciliation modal with print slip and CSV export.

---

## 2. Core Architectural Decisions

### 2.1 Physical Cash Refund Only (Zero Kiosk Screen Balance Inflation)
When an on-site administrator resolves a customer dispute, cash is handed to the customer directly.
- **Machine Screen Balance (`db.data!.balance`)**: Must **NOT** be credited. Crediting machine balance would leave unearned money on the screen for the next user.
- **Kiosk Earnings (`db.data!.earnings`)**: Deducted in real time:
  $$\text{earnings} \leftarrow \max(0, \text{earnings} - \text{amount})$$
- **Financial Ledger**: Appended via `financialLedgerService.append({ eventType: 'refund_issued', amount, referenceId: transactionId, meta: { payoutType: 'cash', ... } })`.
- **Audit Log**: Recorded in `adminLogStore` (`admin_cash_refund_issued`).

### 2.2 Reusing Existing Primitives (Ponytail Principle)
Rather than inventing new state abstractions:
- Reuses `db.data!.pendingRefunds` and `db.data!.owedChanges`.
- Reuses `financialLedgerService` and `withBalanceLock`.
- Extends the existing `buildTransactionContextResponse(transactionId)` to feed the enhanced drawer.

---

## 3. Backend API Specifications

### 3.1 `POST /api/admin/transactions/:transactionId/refund` (New)
Allows an admin to issue a full or partial physical cash refund for a transaction.
- **Authentication**: `requireAdminLocalAccess`, `requireAdminPin`.
- **Validation**:
  - Validates `assertTrustedTimeForFinancialOperation('admin_cash_refund')`.
  - Calculates $\text{maxRefundable} = \text{chargedAmount} - \sum(\text{priorRefunds})$.
  - Validates $0 < \text{amount} \le \text{maxRefundable}$.
- **Execution Flow**:
  1. Acquires `withBalanceLock`.
  2. Deducts `amount` from `db.data!.earnings`.
  3. Appends `refund_issued` event to `financialLedgerService`.
  4. Updates or creates closed entry in `db.data!.pendingRefunds` with `status: 'refunded'`, `closedAt: now`, `payoutType: 'cash'`.
  5. Appends log to `adminLogStore`.
- **Response**: Returns the updated `TransactionContextPayload`.

### 3.2 `POST /api/admin/pending-refunds/:id/refund` (Existing, Reused)
Used when the transaction already has an auto-detected pending refund (e.g. from spooler failure auto-recovery).
- Frontend sends `{ restoreBalance: false }`.
- Deducts `db.data!.earnings`, marks refund entry `status = 'refunded'`, records ledger event with `payoutType: 'cash'`.

### 3.3 `POST /api/admin/owed-changes/:id/resolve` (Existing, Reused)
Called when the admin resolves shortchanged cash.
- Marks `entry.status = 'resolved'` in `db.data!.owedChanges`.
- Appends `owed_change_resolved` log to `adminLogStore`.

### 3.4 `GET /api/admin/logs/transactions/page-output-summary` (New)
Aggregates production and financial metrics matching the active filter parameters (`dateFrom`, `dateTo`, `mode`, `status`).
- **Response Structure**:
  ```json
  {
    "scope": {
      "totalTransactions": 142,
      "dateFrom": "2026-10-01T00:00:00Z",
      "dateTo": "2026-10-07T23:59:59Z"
    },
    "financials": {
      "grossCharged": 3450.00,
      "cashRefundsIssued": 120.00,
      "refundCount": 4,
      "netCashRetained": 3330.00,
      "unresolvedOwedChange": 15.00,
      "unresolvedOwedChangeCount": 2
    },
    "pages": {
      "totalRequested": 890,
      "totalPrinted": 862,
      "totalFailed": 28,
      "fulfillmentRatePercent": 96.85,
      "colorPagesPrinted": 210,
      "bwPagesPrinted": 652
    },
    "hardwareIncidents": {
      "spoolerFailures": 3,
      "hopperShortfalls": 2
    }
  }
  ```

---

## 4. Frontend UI & Drawer Enhancements (`src/public/admin/transactions/`)

### 4.1 Transaction Detail Drawer Enhancements
1. **Print Output & Page Discrepancy Card**:
   - Compares requested pages ($N$) to confirmed spooler output ($K$).
   - Displays delivered status badge (`Full Output` vs `K of N pages delivered`).
   - Computes suggested pro-rated refund: $\frac{N - K}{N} \times \text{chargedAmount}$.
2. **Inline Outstanding Refund Banner**:
   - If an open pending refund exists for the transaction, displays:
     - `⚠️ Open Customer Refund Request: ₱X.XX` (Reason: Hardware jam / spooler failure).
     - Buttons: `[Confirm Cash Handed to Customer]` and `[Dismiss Request]`.
3. **Manual / Dispute Refund Action**:
   - Drawer footer includes `[Issue Cash Refund]`.
   - Opens `#txRefundModal`:
     - Options: Pro-Rated (prefilled), Full, Custom Amount.
     - Reason input (prefilled with telemetry hints).
     - Submit button: `[Confirm Physical Cash Payout]`.
4. **Inline Owed-Change Warning Card**:
   - If `change.remaining > 0` and `owedChangeId` exists:
     - Shows `🪙 Shortchanged: ₱X.XX remaining (Hopper empty/jammed)`.
     - Button: `[Confirm Cash Change Handed to Customer]`.
5. **Financial Ledger History Table**:
   - Renders `context.ledgerEntries` table inside the drawer: Timestamp | Type | Amount | Source.

### 4.2 Aggregate Page Output Summary Modal
- Top bar action: `[Page Output Report]` (`#pageOutputReportBtn`).
- Opens `#pageOutputReportModal`:
  - Displays KPI summary grid: Financial Reconciliation, Page Production & Spooler Delivery, Hardware Incidents.
  - Action buttons: `[Print Report Slip]`, `[Export Summary CSV]`, `[Close]`.

---

## 5. Security, Concurrency & Edge Cases

1. **Anti-Over-Refund Cap**:
   - Backend strictly prevents $\text{totalRefunds} > \text{chargedAmount}$.
   - UI disables refund button and marks transaction `Fully Refunded` if cap reached.
2. **Trusted Hardware Clock Enforcement**:
   - `assertTrustedTimeForFinancialOperation` prevents financial corruption if RTC is desynchronized.
3. **UI Double-Click Guard**:
   - Buttons enter loading/disabled state immediately upon trigger.
4. **Non-Print Transactions (Copy / Scan)**:
   - Copy jobs support page audit if telemetry present.
   - Scan jobs hide the print page card and allow full/custom refunds for feeder jams or failed scans.

---

## 6. Verification & Testing Plan

1. **Unit & Integration Tests**:
   - `POST /api/admin/transactions/:id/refund`:
     - Test refund reduces `db.data!.earnings` and does not alter `db.data!.balance`.
     - Test refund appends to `financialLedgerService`.
     - Test refund exceeding charged amount is rejected with 400.
     - Test idempotency under balance lock.
   - `GET /api/admin/logs/transactions/page-output-summary`:
     - Test aggregation calculation across varying date ranges and transaction states.
2. **Frontend End-to-End Flow**:
   - Open drawer for transaction with spooler failure -> verify discrepancy card shows unprinted pages and suggested refund.
   - Click "Confirm Cash Handed to Customer" -> verify drawer updates, toast appears, and earnings KPI updates.
   - Open drawer for transaction with owed change -> verify "Confirm Cash Change Handed to Customer" marks change resolved.
   - Open "Page Output Report" modal -> verify numbers match filtered records and CSV export downloads correctly.
