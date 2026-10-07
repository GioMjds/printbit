# Admin Transactions Enhancement: Physical Cash Refunds, Owed Change Settlement & Page Output Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance `src/public/admin/transactions` and the backend admin subsystem with on-site Physical Cash Refunds, Inline Owed-Change Resolution, Print Output & Page Discrepancy Audits, and an Aggregate Page Output Summary Report.

**Architecture:** Extend `admin.controller.ts` with dedicated endpoints (`POST /api/admin/transactions/:id/refund` and `GET /api/admin/logs/transactions/page-output-summary`), enforcing physical cash rules (earnings deducted, machine balance unchanged, financial ledger recorded under `withBalanceLock`). Upgrade `src/public/admin/transactions/index.html` and `app.ts` to surface pending refunds, inline cash refunds, owed change resolution, page discrepancy badges with pro-rated refund calculations, and an aggregate KPI summary modal with CSV/print exports.

**Tech Stack:** Node.js (>=22.5), Express, TypeScript, lowdb/SQLite, Jest, Vanilla HTML/CSS/TS frontend compiled via esbuild/`scripts/build-client.js`.

**Spec:** [`docs/superpowers/specs/2026-10-07-admin-transactions-enhancement-design.md`](file:///c:/Users/printbit/printbit/docs/superpowers/specs/2026-10-07-admin-transactions-enhancement-design.md)

## Global Constraints

- **Physical Cash Payout Only**: Machine screen balance (`db.data!.balance`) is **NEVER** modified during customer refunds; kiosk earnings (`db.data!.earnings`) are deducted in real-time.
- **Ledger Invariant**: Every cash refund must write an entry to `financialLedgerService` with `eventType: 'refund_issued'`, `amount`, `referenceId: transactionId`, and `meta.payoutType = 'cash'`.
- **Anti-Over-Refund Cap**: Refund amounts must strictly satisfy $0 < \text{amount} \le \text{chargedAmount} - \sum(\text{priorRefunds})$.
- **Authentication**: All new admin routes require `requireAdminLocalAccess` and `requireAdminPin`.
- **Client Build**: After editing client typescript in `src/public/admin/transactions/app.ts`, `node scripts/build-client.js` must be run to update `app.js`.
- **Ponytail Ladder**: Reuse existing database records (`pendingRefunds`, `owedChanges`, `financialLedger`) rather than inventing separate storage tables.

---

## File Structure & Responsibilities

| File Path | Responsibility |
| --- | --- |
| `src/modules/admin/admin.controller.ts` | Route registration and request handling for `POST /api/admin/transactions/:id/refund` and `GET /api/admin/logs/transactions/page-output-summary`. |
| `src/modules/admin/admin.service.ts` | Business logic for aggregating page output summaries across transactions and resolving refund ledger entries. |
| `src/services/pending-refund.ts` | Lowdb helpers for recording and closing physical cash refund entries. |
| `src/public/admin/transactions/index.html` | Markup for refund modal, page output report modal, owed change banner, and drawer cards. |
| `src/public/admin/transactions/styles.css` | Styling for discrepancy badges, refund dialog, and printable report modal. |
| `src/public/admin/transactions/app.ts` | Event handling, API communication, page discrepancy calculations, and modal state management. |
| `tests/modules/admin/admin-transaction-refund.test.ts` | Unit/integration tests for cash refund logic, cap validation, earnings deduction, and balance isolation. |
| `tests/modules/admin/admin-page-output-summary.test.ts` | Unit/integration tests for aggregate page output report endpoint. |

---

### Task 1: Backend Physical Cash Refund Endpoint (`POST /api/admin/transactions/:id/refund`)

**Files:**
- Create: `tests/modules/admin/admin-transaction-refund.test.ts`
- Modify: `src/modules/admin/admin.controller.ts`
- Modify: `src/services/pending-refund.ts`

**Interfaces:**
- Consumes: `withBalanceLock` (`src/services/db.ts`), `financialLedgerService` (`src/services/financial-ledger.ts`), `assertTrustedTimeForFinancialOperation` (`src/services/time-source.ts`).
- Produces: `POST /api/admin/transactions/:transactionId/refund` accepting `{ amount: number, reason: string, unprintedPages?: number }` and returning `TransactionContextPayload`.

- [ ] **Step 1: Write the failing test for physical cash refund**

```typescript
// tests/modules/admin/admin-transaction-refund.test.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { db } from '@/services/db';
import { AdminController } from '@/modules/admin/admin.controller';
import { AdminService } from '@/modules/admin/admin.service';
import { financialLedgerService } from '@/services/financial-ledger';

jest.mock('@/middleware/admin-auth', () => ({
  requireAdminLocalAccess: (_req: any, _res: any, next: any) => next(),
  requireAdminPin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('@/services/time-source', () => ({
  assertTrustedTimeForFinancialOperation: jest.fn(),
  getTrustedTimestamp: () => ({ timestamp: '2026-10-07T12:00:00.000Z', meta: {} }),
  isTrustedTimeError: () => false,
}));

describe('Admin Transaction Cash Refund API', () => {
  let app: Express;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const adminService = new AdminService();
    const adminController = new AdminController(adminService, {
      io: { emit: jest.fn() } as any,
      printerTelemetry: {} as any,
      printerStateProjection: {} as any,
      consumables: {} as any,
    } as any);

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminController.router);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    db.data = {
      balance: 100,
      earnings: 500,
      pendingRefunds: [],
      financialLedger: [],
      owedChanges: [],
      adminLogs: [],
      recovery: { sessions: [] },
      paperTray: { sheets: 50, maxCapacity: 150 },
    } as any;
  });

  it('deducts earnings, does NOT alter machine balance, and appends ledger entry on physical cash refund', async () => {
    const txId = 'tx-test-123';
    // Seed an initial payment log or transaction record
    db.data!.financialLedger.push({
      id: 'led-1',
      eventType: 'payment_received',
      amount: 40,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    const res = await fetch(`${baseUrl}/api/admin/transactions/${txId}/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 25,
        reason: 'Partial jam on page 2',
        unprintedPages: 3,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactionId).toBe(txId);

    // Critical financial invariants
    expect(db.data!.balance).toBe(100); // BALANCE UNTOUCHED
    expect(db.data!.earnings).toBe(475); // 500 - 25

    // Ledger inspection
    const refundEvent = db.data!.financialLedger.find(
      (e) => e.referenceId === txId && e.eventType === 'refund_issued',
    );
    expect(refundEvent).toBeDefined();
    expect(refundEvent!.amount).toBe(25);
    expect(refundEvent!.meta?.payoutType).toBe('cash');
  });

  it('rejects refund if amount exceeds max refundable', async () => {
    const txId = 'tx-cap-test';
    db.data!.financialLedger.push({
      id: 'led-2',
      eventType: 'payment_received',
      amount: 30,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    const res = await fetch(`${baseUrl}/api/admin/transactions/${txId}/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 50, reason: 'Too much' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/modules/admin/admin-transaction-refund.test.ts`
Expected: FAIL with route 404 (endpoint does not exist yet).

- [ ] **Step 3: Implement `handleRefundTransaction` in `admin.controller.ts`**

Register route:
```typescript
this.router.post(
  '/transactions/:transactionId/refund',
  requireAdminLocalAccess,
  requireAdminPin,
  this.handleRefundTransaction,
);
```

Implement handler:
- Extract `transactionId`, `amount`, `reason`, `unprintedPages`.
- Verify `assertTrustedTimeForFinancialOperation('admin_cash_refund')`.
- Calculate `chargedAmount` from existing logs/ledger for that transaction (or from `buildTransactionContextResponse`).
- Calculate sum of previous `refund_issued` ledger entries for this `transactionId`.
- Validate $0 < \text{amount} \le \text{chargedAmount} - \text{previousRefunds}$.
- Wrap execution in `withBalanceLock`:
  - `db.data!.earnings = Math.max(0, db.data!.earnings - amount);`
  - Append ledger entry:
    ```typescript
    await financialLedgerService.append({
      eventType: 'refund_issued',
      amount,
      referenceId: transactionId,
      meta: {
        source: 'admin_cash_refund',
        payoutType: 'cash',
        reason,
        unprintedPages: unprintedPages ?? null,
      },
    });
    ```
  - Close or create `PendingRefundEntry` with `status: 'refunded'`, `closedAt: now`.
  - Append admin log: `admin_cash_refund_issued`.
- Return `this.buildTransactionContextResponse(transactionId)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/modules/admin/admin-transaction-refund.test.ts`
Expected: PASS

- [ ] **Step 5: Commit backend refund endpoint**

```bash
git add src/modules/admin/admin.controller.ts tests/modules/admin/admin-transaction-refund.test.ts
git commit -m "feat(admin): add physical cash refund endpoint for transactions"
```

---

### Task 2: Backend Aggregate Page Output Summary Endpoint (`GET /api/admin/logs/transactions/page-output-summary`)

**Files:**
- Create: `tests/modules/admin/admin-page-output-summary.test.ts`
- Modify: `src/modules/admin/admin.controller.ts`
- Modify: `src/modules/admin/admin.service.ts`

**Interfaces:**
- Consumes: `adminLogStore` (`src/core/database/models/admin.model.ts`), `financialLedger` (`src/services/db.ts`), `owedChanges` (`src/services/db.ts`).
- Produces: `GET /api/admin/logs/transactions/page-output-summary` returning scope, financials, pages production, and hardware incidents metrics.

- [ ] **Step 1: Write the failing test for aggregate page output summary**

```typescript
// tests/modules/admin/admin-page-output-summary.test.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { db } from '@/services/db';
import { AdminController } from '@/modules/admin/admin.controller';
import { AdminService } from '@/modules/admin/admin.service';

jest.mock('@/middleware/admin-auth', () => ({
  requireAdminLocalAccess: (_req: any, _res: any, next: any) => next(),
  requireAdminPin: (_req: any, _res: any, next: any) => next(),
}));

describe('Admin Page Output Summary API', () => {
  let app: Express;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const adminService = new AdminService();
    const adminController = new AdminController(adminService, {
      io: { emit: jest.fn() } as any,
    } as any);

    app = express();
    app.use('/api/admin', adminController.router);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('aggregates requested vs printed pages, refunds, and owed change correctly', async () => {
    db.data = {
      financialLedger: [
        { id: '1', eventType: 'payment_received', amount: 100, referenceId: 'tx-1', timestamp: '2026-10-07T10:00:00Z' },
        { id: '2', eventType: 'refund_issued', amount: 20, referenceId: 'tx-1', timestamp: '2026-10-07T10:10:00Z' },
      ],
      owedChanges: [
        { id: 'oc-1', amount: 5, status: 'open', timestamp: '2026-10-07T10:05:00Z' },
      ],
      adminLogs: [
        {
          id: 'log-1',
          type: 'payment_confirmed',
          timestamp: '2026-10-07T10:00:00Z',
          message: 'Payment confirmed',
          meta: { transactionId: 'tx-1', amount: 100, totalPages: 10, pagesPrinted: 8, colorPages: 2, bwPages: 6 },
        },
      ],
      pendingRefunds: [],
      recovery: { sessions: [] },
      balance: 0,
      earnings: 80,
    } as any;

    const res = await fetch(`${baseUrl}/api/admin/logs/transactions/page-output-summary`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.financials.grossCharged).toBe(100);
    expect(data.financials.cashRefundsIssued).toBe(20);
    expect(data.financials.netCashRetained).toBe(80);
    expect(data.financials.unresolvedOwedChange).toBe(5);

    expect(data.pages.totalRequested).toBe(10);
    expect(data.pages.totalPrinted).toBe(8);
    expect(data.pages.totalFailed).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/modules/admin/admin-page-output-summary.test.ts`
Expected: FAIL with 404.

- [ ] **Step 3: Implement summary aggregator in `admin.service.ts` & handler in `admin.controller.ts`**

In `admin.service.ts`:
- Add `computePageOutputSummary(query: { dateFrom?: string; dateTo?: string; mode?: string; status?: string })`.
- Parse logs and ledger entries matching date range.
- Aggregate page metrics (`totalRequested`, `totalPrinted`, `totalFailed`, `colorPagesPrinted`, `bwPagesPrinted`).
- Calculate financial metrics (`grossCharged`, `cashRefundsIssued`, `netCashRetained`, `unresolvedOwedChange`).

In `admin.controller.ts`:
- Register `this.router.get('/logs/transactions/page-output-summary', requireAdminLocalAccess, requireAdminPin, this.handleGetPageOutputSummary);`
- Call service method and return JSON.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/modules/admin/admin-page-output-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit summary endpoint**

```bash
git add src/modules/admin/admin.service.ts src/modules/admin/admin.controller.ts tests/modules/admin/admin-page-output-summary.test.ts
git commit -m "feat(admin): add aggregate page output summary endpoint"
```

---

### Task 3: Frontend Drawer Enhancements (Print Output Audit & Inline Owed Change Resolution)

**Files:**
- Modify: `src/public/admin/transactions/index.html`
- Modify: `src/public/admin/transactions/styles.css`
- Modify: `src/public/admin/transactions/app.ts`

**Interfaces:**
- Consumes: `TransactionContextPayload` (`src/public/admin/transactions/app.ts`), `POST /api/admin/owed-changes/:id/resolve`.
- Produces: Enhanced drawer view with Print Output & Page Discrepancy card, Inline Owed-Change card, and Ledger History sub-table.

- [ ] **Step 1: Update `index.html` with drawer markup containers**

Inside `#txDetailDrawer`:
- Add `<div id="dPageAuditCard" class="tx-drawer-card hidden">` for print output discrepancy display.
- Add `<div id="dOwedChangeCard" class="tx-drawer-card tx-drawer-card--warning hidden">` for shortchanged coin resolution.
- Add `<div id="dLedgerCard" class="tx-drawer-card">` containing the ledger history table `<tbody id="dLedgerBody">`.

- [ ] **Step 2: Add styles in `styles.css`**

Add CSS rules for `.tx-drawer-card`, `.tx-drawer-card--warning`, `.tx-discrepancy-badge`, and pro-rated action chip button.

- [ ] **Step 3: Update `renderDrawer()` in `app.ts`**

- Calculate unprinted pages:
  $$\text{unprinted} = \max(0, (\text{totalPages} ?? 0) - (\text{pagesPrinted} ?? 0))$$
- If $\text{unprinted} > 0$ and $\text{chargedAmount} > 0$:
  - Calculate $\text{suggestedRefund} = \frac{\text{unprinted}}{\text{totalPages}} \times \text{chargedAmount}$.
  - Render discrepancy warning with button: `Use Suggested ₱X.XX`.
- If `context.change.remaining > 0` and `context.change.owedChangeId`:
  - Show `#dOwedChangeCard` with button `[Confirm Cash Change Handed to Customer]`.
  - Attach click listener to call `POST /api/admin/owed-changes/:owedChangeId/resolve`.
  - On success, call `showToast('Owed change marked as resolved.')` and reload drawer context.
- Render `context.ledgerEntries` into `#dLedgerBody`.

- [ ] **Step 4: Build client bundle and verify**

Run: `node scripts/build-client.js`
Expected: Successful bundling of `src/public/admin/transactions/app.ts` to `app.js`.

- [ ] **Step 5: Commit drawer enhancements**

```bash
git add src/public/admin/transactions/index.html src/public/admin/transactions/styles.css src/public/admin/transactions/app.ts src/public/admin/transactions/app.js
git commit -m "feat(admin-transactions): add page output audit and inline owed change card to drawer"
```

---

### Task 4: Frontend Physical Cash Refund Flow & Modal (`#txRefundModal`)

**Files:**
- Modify: `src/public/admin/transactions/index.html`
- Modify: `src/public/admin/transactions/styles.css`
- Modify: `src/public/admin/transactions/app.ts`

**Interfaces:**
- Consumes: `POST /api/admin/transactions/:id/refund`, `POST /api/admin/pending-refunds/:id/refund`.
- Produces: UI modal `#txRefundModal` and pending refund action banner.

- [ ] **Step 1: Add Refund Modal and Banner markup to `index.html`**

- Add `#dPendingRefundBanner` inside `#txDetailDrawer` top section with `[Confirm Cash Handed to Customer]` and `[Dismiss]`.
- Add `#txRefundModal` dialog:
  - Radio selections: `Pro-Rated Refund`, `Full Refund`, `Custom Amount`.
  - Input: `#txRefundAmountInput` (number, step 0.50).
  - Input: `#txRefundReasonInput` (text).
  - Button: `#txRefundSubmitBtn` ("Confirm Physical Cash Payout").
  - Button: `#txRefundCancelBtn`.
- Add `#txIssueRefundBtn` to drawer footer action buttons.

- [ ] **Step 2: Add styles in `styles.css` for refund dialog**

Add modal styling, radiogroup layout, and danger/warning action accents.

- [ ] **Step 3: Implement refund handlers in `app.ts`**

- If `context.pendingRefunds` has an open entry:
  - Show `#dPendingRefundBanner`.
  - On `[Confirm Cash Handed to Customer]` click: call `POST /api/admin/pending-refunds/:id/refund` with `{ restoreBalance: false }`.
  - On success, show toast "Cash refund confirmed (₱X.XX). Earnings updated.", refresh drawer context and KPI ribbon.
- On `[Issue Cash Refund]` click:
  - Open `#txRefundModal`.
  - Set default refund amount to suggested pro-rated amount (or full charged amount if no pages).
- On `#txRefundSubmitBtn` click:
  - Disable button, call `POST /api/admin/transactions/:id/refund`.
  - On response, show toast, close modal, update drawer in-place.

- [ ] **Step 4: Build client bundle and verify**

Run: `node scripts/build-client.js`
Expected: Successful client compilation.

- [ ] **Step 5: Commit refund modal flow**

```bash
git add src/public/admin/transactions/index.html src/public/admin/transactions/styles.css src/public/admin/transactions/app.ts src/public/admin/transactions/app.js
git commit -m "feat(admin-transactions): add physical cash refund modal and pending refund banner"
```

---

### Task 5: Aggregate Page Output Report Modal & Export

**Files:**
- Modify: `src/public/admin/transactions/index.html`
- Modify: `src/public/admin/transactions/styles.css`
- Modify: `src/public/admin/transactions/app.ts`

**Interfaces:**
- Consumes: `GET /api/admin/logs/transactions/page-output-summary?{filterParams}`.
- Produces: Summary modal `#pageOutputReportModal` with Print Slip and CSV export triggers.

- [ ] **Step 1: Add Report button to top-bar and modal markup to `index.html`**

- Beside `exportLogsBtn`, add `<button id="pageOutputReportBtn" class="topbar-btn">Page Output Report</button>`.
- Add `#pageOutputReportModal`:
  - Financial section (Gross charged, Cash refunded, Net cash, Unresolved change).
  - Page output section (Total requested, Delivered, Failed/Jammed, Color vs B&W).
  - Incidents section (Spooler fails, Hopper jams).
  - Actions: `#pageOutputPrintBtn` ("Print Slip"), `#pageOutputCsvBtn` ("Export Summary CSV"), `#pageOutputCloseBtn`.

- [ ] **Step 2: Add styles in `styles.css` including `@media print` rules**

Style the KPI cards and add print stylesheet isolating `#pageOutputReportModal` card when printing.

- [ ] **Step 3: Implement logic in `app.ts`**

- `#pageOutputReportBtn` click handler:
  - Gather query params via `buildFilterParams(false)`.
  - Call `apiFetch('/api/admin/logs/transactions/page-output-summary?' + params)`.
  - Populate modal elements and open dialog.
- `#pageOutputPrintBtn` click handler: `window.print()`.
- `#pageOutputCsvBtn` click handler: generate CSV blob from summary data and trigger file download (`printbit-page-output-summary-YYYY-MM-DD.csv`).

- [ ] **Step 4: Build client bundle and verify**

Run: `node scripts/build-client.js`
Expected: PASS.

- [ ] **Step 5: Commit page output report modal**

```bash
git add src/public/admin/transactions/index.html src/public/admin/transactions/styles.css src/public/admin/transactions/app.ts src/public/admin/transactions/app.js
git commit -m "feat(admin-transactions): add aggregate page output summary modal and CSV/print export"
```

---

### Task 6: End-to-End Verification & Graphify Update

**Files:**
- Test all components across unit tests.
- Re-run graphify to keep knowledge graph up to date.

- [ ] **Step 1: Run complete test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 2: Run linter**

Run: `pnpm run lint`
Expected: Clean lint output.

- [ ] **Step 3: Build client and server bundles**

Run: `pnpm run build`
Expected: Build passes with zero errors.

- [ ] **Step 4: Run graphify update**

Run: `graphify update .`
Expected: Knowledge graph updated without errors.

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "chore: complete admin transactions physical refund and page output report integration"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-07-admin-transactions-enhancement.md`.
