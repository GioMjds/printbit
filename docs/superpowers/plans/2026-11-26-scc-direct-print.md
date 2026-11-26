# SCC Direct Print (Bypass) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin print a customer's file from the PIN-gated `/scc` page with no coins, and book that revenue in a separate `directEarnings` bucket.

**Architecture:** The `/scc` page reuses the kiosk upload session, upload, and quote endpoints. A new admin-only route `POST /api/admin/direct-print/confirm` sets `res.locals.paymentSource = 'direct'` and delegates to the existing `FinancialService.confirmPayment`. That handler swaps coin settlement for `settlementService.settleDirect()` and tags ledger and log entries. Earnings, analytics, and refund code split on the `paymentSource: 'direct'` tag.

**Tech Stack:** TypeScript, Express 5.2, Socket.IO, Jest + ts-jest + supertest, esbuild client bundles (`scripts/build-client.js`), pnpm.

**Spec:** `docs/superpowers/specs/2026-11-26-scc-direct-print-design.md`

## Global Constraints

- Branch: `feat/scc-direct-print`. Commit after every task.
- `paymentSource` is read only from `res.locals`, never from `req.body`.
- Direct prints are charged at the normal kiosk quote (`/api/print/quote`). No manual price override.
- Direct revenue never changes `db.data.earnings` or `db.data.balance`, and never dispenses change.
- Developer mode / `environment: 'test'` jobs add to neither bucket.
- Direct jobs are `mode: 'print'` only. Copy and scan are out of scope.
- No per-customer names or accounts.
- Run commands from the repo root `D:\giomj\Projects\printbit`. Test runner: `pnpm exec jest <path>`.
- After code changes run `graphify update .` (per `CLAUDE.md`).

## Review Focus

1. **Worker reports a print failure after enqueue for a direct job.** `worker-print-lifecycle.ts` and `recovery.ts` call `upsertSpoolerFailureRefund` without `paymentSource`. The refund must still reverse `directEarnings` and must not credit the coin balance. Pinned in Task 2 ("untagged context resolves direct from the ledger").
2. **Admin closes a direct pending refund with "restore balance".** That would put money in the coin balance that nobody inserted. It must be rejected with 409. Pinned in Task 2.
3. **A kiosk customer has coins inserted while the admin direct-prints.** The customer's balance must stay untouched. Pinned in Task 1 (balance 12 stays 12).
4. **The admin requests a price right after upload, while page analysis is still running.** The quote returns 409 `ANALYSIS_PENDING`. The page must retry, not show an error. Pinned in Task 6 (`shouldRetryQuote`).
5. **The admin enters copies `0`, `150` or a blank page range.** Copies must clamp to 1..99 and a blank range must mean "all pages" (`null`). Pinned in Task 6 (`buildDirectPrintSettings`).

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src/core/database/db.ts` | Modify | Add `directEarnings` to schema, defaults, normalize. |
| `src/services/settlement.ts` | Modify | Add `settleDirect()`. |
| `src/services/settlement.spec.ts` | Create | Tests for `settleDirect`. |
| `src/services/pending-refund.ts` | Modify | Direct-aware auto and manual refunds. |
| `src/services/pending-refund.spec.ts` | Create | Refund tests. |
| `src/modules/financial/payment-source.ts` | Create | `PaymentSource` type + `resolvePaymentSource()`. |
| `src/modules/financial/financial.controller.ts` | Modify | Admin direct-print route. |
| `src/modules/financial/financial.controller.spec.ts` | Create | Route guard tests. |
| `src/modules/financial/financial.service.ts` | Modify | `confirmPayment` branch + tags. |
| `src/modules/admin/earnings-split.ts` | Create | Pure earnings sum helpers. |
| `src/modules/admin/earnings-split.spec.ts` | Create | Split tests. |
| `src/modules/admin/admin.service.ts` | Modify | Use helpers; add direct buckets + analytics `totals.direct`. |
| `src/modules/admin/admin.controller.ts` | Modify | Dashboard payload `directEarnings`. |
| `src/public/admin/shared.ts` | Modify | Client `EarningsAnalyticsResponse.totals.direct`. |
| `src/public/admin/earnings/index.html`, `app.ts` | Modify | Direct (bypass) card. |
| `src/public/admin/transactions/app.ts`, `styles.css` | Modify | Direct badge. |
| `src/public/scc/direct-print-request.ts` | Create | Pure request builders + quote retry rule. |
| `src/public/scc/direct-print-request.spec.ts` | Create | Tests for builders. |
| `src/public/scc/direct-print.ts` | Create | Direct Print panel DOM logic. |
| `src/public/scc/index.html`, `styles.css`, `app.ts` | Modify | Panel markup, styles, wiring. |

---

### Task 1: `directEarnings` storage and `settleDirect`

**Files:**
- Modify: `src/core/database/db.ts:188`, `:244`, `:1219`
- Modify: `src/services/settlement.ts` (add method to `SettlementService`)
- Test: `src/services/settlement.spec.ts`

**Interfaces:**
- Consumes: `SettlementInput`, `SettlementResult` (existing, `src/services/settlement.ts`).
- Produces: `db.data.directEarnings: number`; `settlementService.settleDirect(input: SettlementInput): Promise<SettlementResult>`.

- [ ] **Step 1: Write the failing test**

Create `src/services/settlement.spec.ts`:

```ts
const mockDb = {
  data: {} as Record<string, unknown> & {
    balance: number;
    earnings: number;
    directEarnings: number;
    settings: { developerMode: { enabled: boolean } };
  },
  write: jest.fn().mockResolvedValue(undefined),
};

jest.mock('@/services/db', () => ({
  db: mockDb,
  withBalanceLock: (fn: () => unknown) => fn(),
}));
jest.mock('@/services/admin', () => ({
  adminService: { appendAdminLog: jest.fn() },
}));
jest.mock('@/services/hopper', () => ({
  hopperService: { dispenseChange: jest.fn() },
}));
jest.mock('@/services/time-source', () => ({
  assertTrustedTimeForFinancialOperation: jest.fn(),
}));

import { settlementService } from './settlement';

function makeIo() {
  return { emit: jest.fn() };
}

describe('settlementService.settleDirect', () => {
  beforeEach(() => {
    mockDb.data = {
      balance: 12,
      earnings: 100,
      directEarnings: 0,
      settings: { developerMode: { enabled: false } },
    };
    mockDb.write.mockClear();
  });

  it('books direct revenue without touching coin balance or kiosk earnings', async () => {
    const io = makeIo();
    const result = await settlementService.settleDirect({
      requiredAmount: 8,
      io: io as never,
      jobContext: { mode: 'print', transactionId: 'tx-1' },
    });

    expect(result).toEqual({
      ok: true,
      chargedAmount: 8,
      previousBalance: 12,
      remainingBalance: 12,
      earnings: 100,
      change: { requested: 0, dispensed: 0, state: 'none' },
    });
    expect(mockDb.data.balance).toBe(12);
    expect(mockDb.data.earnings).toBe(100);
    expect(mockDb.data.directEarnings).toBe(8);
    expect(io.emit).not.toHaveBeenCalled();
    expect(mockDb.write).toHaveBeenCalledTimes(1);
  });

  it('books nothing in developer mode', async () => {
    mockDb.data.settings.developerMode.enabled = true;
    await settlementService.settleDirect({
      requiredAmount: 8,
      io: makeIo() as never,
      jobContext: { mode: 'print', transactionId: 'tx-2' },
    });
    expect(mockDb.data.directEarnings).toBe(0);
  });

  it('books nothing for test-environment jobs', async () => {
    await settlementService.settleDirect({
      requiredAmount: 8,
      io: makeIo() as never,
      jobContext: { mode: 'print', transactionId: 'tx-3', environment: 'test' },
    });
    expect(mockDb.data.directEarnings).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/services/settlement.spec.ts`
Expected: FAIL with `settlementService.settleDirect is not a function`.

- [ ] **Step 3: Add the schema field**

In `src/core/database/db.ts`, in `export type Schema = {` add the line after `earnings: number;`:

```ts
  earnings: number;
  directEarnings: number;
```

In `DEFAULT_DATA` add after `earnings: 0,`:

```ts
  earnings: 0,
  directEarnings: 0,
```

In `normalizeSchema` add after `earnings: finiteOr(data?.earnings, DEFAULT_DATA.earnings),`:

```ts
    earnings: finiteOr(data?.earnings, DEFAULT_DATA.earnings),
    directEarnings: finiteOr(data?.directEarnings, DEFAULT_DATA.directEarnings),
```

`db.write()` serializes all of `db.data` to `runtime_state.payload_json`, so no migration is needed.

- [ ] **Step 4: Implement `settleDirect`**

In `src/services/settlement.ts`, add this method inside `class SettlementService`, directly after the closing brace of `settle(...)`:

```ts
  /**
   * Settles an admin direct print. The customer paid staff directly, so the
   * coin balance and hopper are never touched.
   */
  async settleDirect(input: SettlementInput): Promise<SettlementResult> {
    const { requiredAmount, jobContext } = input;
    assertTrustedTimeForFinancialOperation('settlement:direct');

    return withBalanceLock(async () => {
      const currentBalance = db.data!.balance;
      const isTest =
        jobContext.environment === 'test' ||
        db.data?.settings?.developerMode?.enabled === true;
      if (!isTest) {
        db.data!.directEarnings += requiredAmount;
        await db.write();
      }
      return {
        ok: true,
        chargedAmount: requiredAmount,
        previousBalance: currentBalance,
        remainingBalance: currentBalance,
        earnings: db.data!.earnings,
        change: { requested: 0, dispensed: 0, state: 'none' as const },
      };
    });
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec jest src/services/settlement.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Typecheck for fixtures that build a full `Schema`**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no new errors. If a fixture or script typed as `Schema` reports `Property 'directEarnings' is missing`, add `directEarnings: 0,` next to its `earnings` field and re-run.

- [ ] **Step 7: Commit**

```bash
git add src/core/database/db.ts src/services/settlement.ts src/services/settlement.spec.ts
git commit -m "feat(settlement): add directEarnings bucket and settleDirect"
```

---

### Task 2: Direct-aware refunds

**Files:**
- Modify: `src/services/pending-refund.ts` (`upsertSpoolerFailureRefund`, `processPendingRefund`, new export)
- Test: `src/services/pending-refund.spec.ts`

**Interfaces:**
- Consumes: `db.data.directEarnings` (Task 1); ledger `job_started` entries with `meta.paymentSource === 'direct'` and `referenceId === transactionId` (written in Task 3).
- Produces: `isDirectPaymentTransaction(jobContext: Record<string, string | number | boolean | null | undefined>): boolean`. Refund entries for direct jobs carry `jobContext.paymentSource = 'direct'`.

- [ ] **Step 1: Write the failing tests**

Create `src/services/pending-refund.spec.ts`:

```ts
type MockData = {
  balance: number;
  earnings: number;
  directEarnings: number;
  pendingRefunds: Record<string, unknown>[];
  financialLedger: Record<string, unknown>[];
};

const mockDb = {
  data: {} as MockData,
  write: jest.fn().mockResolvedValue(undefined),
};
const mockAppend = jest.fn().mockResolvedValue(undefined);

jest.mock('@/services/db', () => ({
  db: mockDb,
  withBalanceLock: (fn: () => unknown) => fn(),
}));
jest.mock('@/services/financial-ledger', () => ({
  financialLedgerService: { append: mockAppend },
}));
jest.mock('@/services/time-source', () => ({
  assertTrustedTimeForFinancialOperation: jest.fn(),
  getTrustedTimestamp: () => ({ timestamp: '2026-11-26T02:00:00.000Z' }),
  isTrustedTimeError: () => false,
}));

import {
  PendingRefundServiceError,
  processPendingRefund,
  upsertSpoolerFailureRefund,
} from './pending-refund';

beforeEach(() => {
  mockDb.data = {
    balance: 3,
    earnings: 50,
    directEarnings: 20,
    pendingRefunds: [],
    financialLedger: [],
  };
  mockAppend.mockClear();
});

describe('upsertSpoolerFailureRefund for direct jobs', () => {
  it('reverses directEarnings and never credits the coin balance', async () => {
    const outcome = await upsertSpoolerFailureRefund({
      chargedAmount: 8,
      reason: 'Enqueue failed',
      autoRefund: true,
      jobContext: {
        transactionId: 'tx-d',
        paymentSource: 'direct',
        spoolerCorrelationKey: 'k-1',
      },
    });

    expect(mockDb.data.balance).toBe(3);
    expect(mockDb.data.earnings).toBe(50);
    expect(mockDb.data.directEarnings).toBe(12);
    expect(outcome.restoredBalanceAmount).toBe(0);
    expect(outcome.entry.reason).toBe(
      'Enqueue failed (direct: refund customer manually)',
    );
    expect(outcome.entry.jobContext.paymentSource).toBe('direct');
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'refund_issued',
        meta: expect.objectContaining({ paymentSource: 'direct' }),
      }),
    );
  });

  it('untagged context resolves direct from the ledger (worker failure path)', async () => {
    mockDb.data.financialLedger.push({
      eventType: 'job_started',
      referenceId: 'tx-w',
      meta: { mode: 'print', paymentSource: 'direct' },
    });

    await upsertSpoolerFailureRefund({
      chargedAmount: 5,
      reason: 'Worker failed',
      autoRefund: true,
      jobContext: { transactionId: 'tx-w', spoolerCorrelationKey: 'k-2' },
    });

    expect(mockDb.data.balance).toBe(3);
    expect(mockDb.data.directEarnings).toBe(15);
  });

  it('leaves kiosk refunds unchanged', async () => {
    await upsertSpoolerFailureRefund({
      chargedAmount: 8,
      reason: 'Enqueue failed',
      autoRefund: true,
      jobContext: { transactionId: 'tx-k', spoolerCorrelationKey: 'k-3' },
    });

    expect(mockDb.data.balance).toBe(11);
    expect(mockDb.data.earnings).toBe(42);
    expect(mockDb.data.directEarnings).toBe(20);
  });
});

describe('processPendingRefund for direct entries', () => {
  beforeEach(() => {
    mockDb.data.pendingRefunds.push({
      id: 'r-1',
      timestamp: '2026-11-26T01:00:00.000Z',
      chargedAmount: 8,
      reason: 'Worker failed (direct: refund customer manually)',
      status: 'open',
      closedAt: null,
      jobContext: { transactionId: 'tx-d', paymentSource: 'direct' },
    });
  });

  it('rejects restoring a direct refund to the coin balance', async () => {
    await expect(
      processPendingRefund({ entryId: 'r-1', restoreBalance: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mockDb.data.balance).toBe(3);
    expect(mockDb.data.pendingRefunds[0].status).toBe('open');
  });

  it('cash refund reduces directEarnings, not kiosk earnings', async () => {
    await processPendingRefund({ entryId: 'r-1', restoreBalance: false });
    expect(mockDb.data.directEarnings).toBe(12);
    expect(mockDb.data.earnings).toBe(50);
    expect(mockDb.data.balance).toBe(3);
  });

  it('exports the error type used for the 409', () => {
    expect(new PendingRefundServiceError(409, 'x')).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec jest src/services/pending-refund.spec.ts`
Expected: FAIL. The direct test shows `balance` `11` instead of `3`, and the restore test does not reject.

- [ ] **Step 3: Add the direct-transaction helper**

In `src/services/pending-refund.ts`, add after `function ensureDb(): void { ... }`:

```ts
/**
 * True when the refund belongs to an admin direct print. Worker and recovery
 * callers do not pass paymentSource, so fall back to the job_started ledger tag.
 */
export function isDirectPaymentTransaction(
  jobContext: Record<string, string | number | boolean | null | undefined>,
): boolean {
  if (jobContext.paymentSource === 'direct') return true;
  const transactionId =
    typeof jobContext.transactionId === 'string'
      ? jobContext.transactionId
      : null;
  if (!transactionId) return false;
  return (db.data?.financialLedger ?? []).some(
    (entry) =>
      entry.eventType === 'job_started' &&
      entry.referenceId === transactionId &&
      entry.meta?.paymentSource === 'direct',
  );
}
```

- [ ] **Step 4: Make `upsertSpoolerFailureRefund` direct-aware**

In `upsertSpoolerFailureRefund`, replace the block from `const autoRefunded = input.autoRefund;` through the end of the `if (autoRefunded) { ... }` block with:

```ts
  const autoRefunded = input.autoRefund;
  const isDirect = isDirectPaymentTransaction(input.jobContext);
  const contextWithDisposition: Record<
    string,
    string | number | boolean | null | undefined
  > = {
    ...normalizedContext,
    ...(isDirect ? { paymentSource: 'direct' } : {}),
    refundDisposition: autoRefunded ? 'auto_refunded' : 'pending_admin_review',
    restoredBalanceAmount: autoRefunded && !isDirect ? input.chargedAmount : 0,
  };
  const entry: PendingRefundEntry = {
    id: randomUUID(),
    timestamp: createdTs,
    chargedAmount: input.chargedAmount,
    reason: isDirect
      ? `${input.reason} (direct: refund customer manually)`
      : input.reason,
    status: autoRefunded ? 'refunded' : 'open',
    closedAt: autoRefunded ? createdTs : null,
    jobContext: normalizeJobContext(contextWithDisposition),
  };

  let restoredBalanceAmount = 0;
  if (autoRefunded) {
    await withBalanceLock(async () => {
      if (isDirect) {
        // Customer paid staff directly: reverse direct revenue only.
        db.data!.directEarnings = Math.max(
          0,
          db.data!.directEarnings - input.chargedAmount,
        );
        return;
      }
      db.data!.balance += input.chargedAmount;
      db.data!.earnings = Math.max(0, db.data!.earnings - input.chargedAmount);
      restoredBalanceAmount = input.chargedAmount;
    });
    await financialLedgerService.append({
      eventType: 'refund_issued',
      amount: input.chargedAmount,
      referenceId: entry.id,
      meta: {
        source: 'auto_spooler_refund',
        reason: input.reason,
        ...(isDirect ? { paymentSource: 'direct' } : {}),
      },
    });
  }
```

- [ ] **Step 5: Make `processPendingRefund` direct-aware**

In `processPendingRefund`, directly after the `if (entry.status !== 'open') { ... }` block, insert:

```ts
  const isDirect = entry.jobContext.paymentSource === 'direct';
  if (isDirect && input.restoreBalance) {
    throw new PendingRefundServiceError(
      409,
      'Direct prints are refunded in cash, not kiosk balance.',
    );
  }
```

Then replace the `else` (cash) branch body with:

```ts
  } else {
    await withBalanceLock(async () => {
      if (isDirect) {
        db.data!.directEarnings = Math.max(
          0,
          db.data!.directEarnings - entry.chargedAmount,
        );
      } else {
        db.data!.earnings = Math.max(
          0,
          db.data!.earnings - entry.chargedAmount,
        );
      }
    });
    await financialLedgerService.append({
      eventType: 'refund_issued',
      amount: entry.chargedAmount,
      referenceId: (entry.jobContext.transactionId as string) || entry.id,
      meta: {
        source: 'admin_cash_refund',
        reason: entry.reason,
        payoutType: 'cash',
        ...(isDirect ? { paymentSource: 'direct' } : {}),
      },
    });
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec jest src/services/pending-refund.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src/services/pending-refund.ts src/services/pending-refund.spec.ts
git commit -m "feat(refunds): reverse directEarnings for direct print refunds"
```

---

### Task 3: Admin direct-print route and `confirmPayment` branch

**Files:**
- Create: `src/modules/financial/payment-source.ts`
- Modify: `src/modules/financial/financial.controller.ts`
- Modify: `src/modules/financial/financial.service.ts` (`confirmPayment`, lines ~1185-2150)
- Test: `src/modules/financial/financial.controller.spec.ts`

**Interfaces:**
- Consumes: `settlementService.settleDirect` (Task 1).
- Produces: `type PaymentSource = 'kiosk' | 'direct'`; `resolvePaymentSource(locals: Record<string, unknown>): PaymentSource`; route `POST /api/admin/direct-print/confirm` (body = `/api/confirm-payment` body, `mode` must be `'print'`, header `Idempotency-Key`). Ledger `job_started`/`job_completed` meta, the `payment_confirmed` log meta, recovery `settled` context, and the enqueue-failure refund `jobContext` carry `paymentSource: 'direct'` for direct jobs.

- [ ] **Step 1: Write the failing route test**

Create `src/modules/financial/financial.controller.spec.ts`:

```ts
import express, { type Request, type Response } from 'express';
import request from 'supertest';

const mockValidateAdminSession = jest.fn();

jest.mock('@/services/db', () => ({
  db: { data: { settings: { adminLocalOnly: false } } },
}));
jest.mock('@/utils/admin-session', () => ({
  ADMIN_SESSION_COOKIE_OPTIONS: {},
  createAdminSession: jest.fn(),
  destroyAdminSession: jest.fn(),
  getAdminSessionDeviceId: jest.fn().mockReturnValue(null),
  validateAdminSession: (token: string) => mockValidateAdminSession(token),
}));
jest.mock('@/services/admin-device.service', () => ({
  ADMIN_DEVICE_COOKIE: 'adminDevice',
  DEVICE_COOKIE_OPTIONS: {},
  adminDeviceService: {
    getById: jest.fn(),
    touch: jest.fn(),
    verifyCookie: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('@/middleware/rate-limit', () => ({
  createRateLimit:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
}));
jest.mock('@/middleware/file-validation', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    legacyUploadMiddleware: { single: () => pass },
    validateLegacyUploadMagicBytes: pass,
    scanLegacyUploadForMalware: pass,
    handleMulterError: pass,
  };
});
jest.mock('./financial.service', () => ({ FinancialService: class {} }));

import { FinancialController } from './financial.controller';
import { resolvePaymentSource } from './payment-source';

function makeApp() {
  const confirmPayment = jest.fn(async (_req: Request, res: Response) => {
    res.json({ paymentSource: resolvePaymentSource(res.locals) });
  });
  const controller = new FinancialController({ confirmPayment } as never);
  const app = express();
  app.use(express.json());
  app.use(controller.router);
  return { app, confirmPayment };
}

describe('POST /api/admin/direct-print/confirm', () => {
  beforeEach(() => {
    mockValidateAdminSession.mockImplementation((t: string) => t === 'good');
  });

  it('returns 401 without an admin session', async () => {
    const { app, confirmPayment } = makeApp();
    const res = await request(app)
      .post('/api/admin/direct-print/confirm')
      .send({ mode: 'print' });
    expect(res.status).toBe(401);
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it('runs confirmPayment as a direct payment for admins', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/admin/direct-print/confirm')
      .set('x-admin-token', 'good')
      .send({ mode: 'print' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paymentSource: 'direct' });
  });

  it('rejects non-print modes', async () => {
    const { app, confirmPayment } = makeApp();
    const res = await request(app)
      .post('/api/admin/direct-print/confirm')
      .set('x-admin-token', 'good')
      .send({ mode: 'copy' });
    expect(res.status).toBe(400);
    expect(confirmPayment).not.toHaveBeenCalled();
  });
});

describe('POST /api/confirm-payment', () => {
  it('ignores paymentSource sent in the request body', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/confirm-payment')
      .send({ mode: 'print', paymentSource: 'direct' });
    expect(res.body).toEqual({ paymentSource: 'kiosk' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/modules/financial/financial.controller.spec.ts`
Expected: FAIL with `Cannot find module './payment-source'`.

- [ ] **Step 3: Create the payment-source helper**

Create `src/modules/financial/payment-source.ts`:

```ts
export type PaymentSource = 'kiosk' | 'direct';

/** Only server-side routes set this; request bodies are never trusted for it. */
export function resolvePaymentSource(
  locals: Record<string, unknown>,
): PaymentSource {
  return locals.paymentSource === 'direct' ? 'direct' : 'kiosk';
}
```

- [ ] **Step 4: Add the admin route**

In `src/modules/financial/financial.controller.ts`, add imports below the existing ones:

```ts
import {
  requireAdminLocalAccess,
  requireAdminPin,
} from '@/middleware/admin-auth';
import { createRateLimit } from '@/middleware/rate-limit';

const directPrintRateLimit = createRateLimit({
  keyPrefix: 'admin-direct-print',
  windowMs: 60_000,
  max: 10,
});
```

In `initializeRoutes()`, add after `this.router.post('/api/confirm-payment', this.confirmPayment);`:

```ts
    this.router.post(
      '/api/admin/direct-print/confirm',
      requireAdminLocalAccess,
      requireAdminPin,
      directPrintRateLimit,
      this.confirmDirectPrint,
    );
```

Add this handler next to the existing `confirmPayment` handler:

```ts
  private confirmDirectPrint = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    if (req.body?.mode !== 'print') {
      res.status(400).json({ error: 'Direct print supports print jobs only.' });
      return;
    }
    res.locals.paymentSource = 'direct';
    await this.financialService.confirmPayment(req, res);
  };
```

The admin router is mounted at `/api/admin` but has no catch-all, so unmatched requests fall through to this router.

- [ ] **Step 5: Run route test to verify it passes**

Run: `pnpm exec jest src/modules/financial/financial.controller.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Branch `confirmPayment` on the payment source**

All edits are in `src/modules/financial/financial.service.ts`.

6a. Imports. Change `import { settlementService } from '@/services/settlement';` to:

```ts
import {
  settlementService,
  type SettlementInput,
} from '@/services/settlement';
import { resolvePaymentSource } from './payment-source';
```

6b. Skip the coin-acceptor disarm. Replace:

```ts
    const { paymentLeaseId } = (req.body ?? {}) as ConfirmPaymentBody;
    if (this.paymentAcceptorGate) {
```

with:

```ts
    const paymentSource = resolvePaymentSource(res.locals);
    const directTag = paymentSource === 'direct' ? { paymentSource } : {};
    const { paymentLeaseId } = (req.body ?? {}) as ConfirmPaymentBody;
    if (this.paymentAcceptorGate && paymentSource === 'kiosk') {
```

6c. Tag `job_started`. In the `eventType: 'job_started'` ledger append, change the meta to:

```ts
        meta: {
          mode,
          sessionId: sessionId ?? null,
          documentId: targetDocumentId ?? null,
          filename: serverFilename ?? null,
          ...directTag,
          ...(isTestEnvironment ? { environment: 'test' } : {}),
        },
```

6d. Swap settlement. Replace `const settlement = await settlementService.settle({ ... });` (the whole call) with:

```ts
    const settlementInput: SettlementInput = {
      requiredAmount,
      io: this.deps.io,
      jobContext: {
        transactionId,
        mode,
        copies,
        colorMode: printOptions?.colorMode ?? colorMode,
        rotationDeg: printOptions?.rotationDeg ?? rotationDeg,
        duplex: printOptions?.duplex ?? false,
        spoolerCorrelationKey,
        sessionId: sessionId ?? null,
        documentId: targetDocumentId ?? null,
        filename: serverFilename ?? null,
        environment: isTestEnvironment ? 'test' : undefined,
        ...directTag,
      },
    };
    const settlement =
      paymentSource === 'direct'
        ? await settlementService.settleDirect(settlementInput)
        : await settlementService.settle(settlementInput);
```

6e. Tag the `settled` recovery checkpoint that follows `const settledAt = ...`. In its `context: {` object, add `...directTag,` as the first property:

```ts
      context: {
        ...directTag,
        changeState: settlement.change.state,
```

6f. Tag `job_completed`. In the `eventType: 'job_completed'` ledger append meta, add `...directTag,` after `remainingBalance: settlement.remainingBalance,`:

```ts
          remainingBalance: settlement.remainingBalance,
          ...directTag,
          ...(isTestEnvironment ? { environment: 'test' } : {}),
```

6g. Tag the enqueue-failure refund. In the `upsertSpoolerFailureRefund({ ... source: 'confirm-payment-enqueue' ... })` call, add to `jobContext`:

```ts
            source: 'confirm-payment-enqueue',
            ...directTag,
```

6h. Tag the post-enqueue checkpoint. In the second `checkpointRecoverySession({ ... phase: 'settled' ... context: { filename: serverFilename, queuedAt } })`, change the context to:

```ts
          context: {
            ...directTag,
            filename: serverFilename,
            queuedAt,
          },
```

6i. Tag the `payment_confirmed` admin log. In `adminService.appendAdminLog('payment_confirmed', 'Payment confirmed.', { ... })`, add `...directTag,` after `amount: requiredAmount,`:

```ts
          amount: requiredAmount,
          ...directTag,
```

- [ ] **Step 7: Typecheck and run the financial and service tests**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `pnpm exec jest src/modules/financial src/services`
Expected: PASS, including the existing `worker-print-lifecycle.spec.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/modules/financial/payment-source.ts src/modules/financial/financial.controller.ts src/modules/financial/financial.controller.spec.ts src/modules/financial/financial.service.ts
git commit -m "feat(financial): admin direct-print route with direct settlement"
```

---

### Task 4: Split earnings buckets and analytics

**Files:**
- Create: `src/modules/admin/earnings-split.ts`
- Test: `src/modules/admin/earnings-split.spec.ts`
- Modify: `src/modules/admin/admin.service.ts` (`computeEarningsBuckets` ~1237, `EarningsAnalyticsResult` ~108, `computeDetailedEarningsAnalytics` ~1607)
- Modify: `src/modules/admin/admin.controller.ts:1189`, `:1254`

**Interfaces:**
- Consumes: tags from Task 3; `db.data.directEarnings` (Task 1).
- Produces:
  - `isDirectPayment(meta: LogMeta | null | undefined): boolean`
  - `sumEarningsLogs(logs: Iterable<AdminLogEntry>, bounds: { startOfToday: Date; startOfWeek: Date }, include: (meta: LogMeta | undefined) => boolean): { today: number; week: number }`
  - `sumDirectLedger(entries: Iterable<FinancialLedgerEntry>, bounds: { startOfToday: Date; startOfWeek: Date; startOfMonth: Date; startOfYear: Date }): { today: number; week: number; month: number; year: number }`
  - `adminService.computeDirectEarningsBuckets(now?: Date): { today: number; week: number; allTime: number }`
  - Analytics response `totals.direct: { today: number; week: number; month: number; year: number; allTime: number }`
  - Dashboard payload field `directEarnings` (same shape as `earnings`).

- [ ] **Step 1: Write the failing tests**

Create `src/modules/admin/earnings-split.spec.ts`:

```ts
import type { AdminLogEntry, LogMeta } from '@/modules/admin/admin.schema';
import type { FinancialLedgerEntry } from '@/services/db';
import {
  isDirectPayment,
  sumDirectLedger,
  sumEarningsLogs,
} from './earnings-split';

let seq = 0;
function log(type: string, timestamp: string, meta: LogMeta): AdminLogEntry {
  seq += 1;
  return { id: `log-${seq}`, timestamp, type, message: '', meta };
}

function ledger(
  eventType: string,
  timestamp: string,
  amount: number,
  meta: LogMeta,
): FinancialLedgerEntry {
  seq += 1;
  return {
    id: `led-${seq}`,
    timestamp,
    timestampMeta: {} as never,
    eventType: eventType as FinancialLedgerEntry['eventType'],
    amount,
    referenceId: null,
    meta,
    previousHash: null,
    hash: '',
  };
}

const startOfToday = new Date('2026-11-26T00:00:00');
const startOfWeek = new Date('2026-11-20T00:00:00');

const logs = [
  log('payment_confirmed', '2026-11-26T09:00:00', { transactionId: 'k1', amount: 10 }),
  log('payment_confirmed', '2026-11-26T09:05:00', {
    transactionId: 'd1',
    amount: 7,
    paymentSource: 'direct',
  }),
  log('payment_confirmed', '2026-11-23T09:00:00', { transactionId: 'k2', amount: 5 }),
  log('payment_confirmed', '2026-11-23T09:05:00', {
    transactionId: 'd2',
    amount: 4,
    paymentSource: 'direct',
  }),
  log('payment_confirmed', '2026-11-26T09:10:00', {
    transactionId: 't1',
    amount: 99,
    environment: 'test',
  }),
];

describe('isDirectPayment', () => {
  it('detects only the direct tag', () => {
    expect(isDirectPayment({ paymentSource: 'direct' })).toBe(true);
    expect(isDirectPayment({ paymentSource: 'kiosk' })).toBe(false);
    expect(isDirectPayment(undefined)).toBe(false);
  });
});

describe('sumEarningsLogs', () => {
  it('keeps kiosk and direct revenue apart', () => {
    const bounds = { startOfToday, startOfWeek };
    expect(sumEarningsLogs(logs, bounds, (m) => !isDirectPayment(m))).toEqual({
      today: 10,
      week: 15,
    });
    expect(sumEarningsLogs(logs, bounds, isDirectPayment)).toEqual({
      today: 7,
      week: 11,
    });
  });
});

describe('sumDirectLedger', () => {
  it('sums direct completions minus direct refunds only', () => {
    const entries = [
      ledger('job_completed', '2026-11-26T08:00:00', 8, { paymentSource: 'direct' }),
      ledger('refund_issued', '2026-11-26T08:30:00', 3, { paymentSource: 'direct' }),
      ledger('job_completed', '2026-11-26T08:45:00', 50, { mode: 'print' }),
      ledger('job_completed', '2026-11-02T08:00:00', 6, { paymentSource: 'direct' }),
      ledger('job_completed', '2026-03-01T08:00:00', 2, { paymentSource: 'direct' }),
      ledger('job_completed', '2026-11-26T09:00:00', 99, {
        paymentSource: 'direct',
        environment: 'test',
      }),
      ledger('job_started', '2026-11-26T07:59:00', 8, { paymentSource: 'direct' }),
    ];
    expect(
      sumDirectLedger(entries, {
        startOfToday,
        startOfWeek,
        startOfMonth: new Date('2026-11-01T00:00:00'),
        startOfYear: new Date('2026-01-01T00:00:00'),
      }),
    ).toEqual({ today: 5, week: 5, month: 11, year: 13 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec jest src/modules/admin/earnings-split.spec.ts`
Expected: FAIL with `Cannot find module './earnings-split'`.

- [ ] **Step 3: Create the pure helpers**

Create `src/modules/admin/earnings-split.ts`. The `sumEarningsLogs` loop is moved unchanged from `computeEarningsBuckets`, plus the `include` filter:

```ts
import type { AdminLogEntry, LogMeta } from '@/modules/admin/admin.schema';
import type { FinancialLedgerEntry } from '@/services/db';

export function isDirectPayment(meta: LogMeta | null | undefined): boolean {
  return meta?.paymentSource === 'direct';
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

export function sumEarningsLogs(
  logs: Iterable<AdminLogEntry>,
  bounds: { startOfToday: Date; startOfWeek: Date },
  include: (meta: LogMeta | undefined) => boolean,
): { today: number; week: number } {
  let today = 0;
  let week = 0;
  const seenTxIds = new Set<string>();
  const failedTxIds = new Set<string>();

  for (const log of logs) {
    if (log.meta?.environment === 'test') continue;
    if (!include(log.meta)) continue;
    const txId =
      (typeof log.meta?.transactionId === 'string' &&
        log.meta.transactionId) ||
      (typeof log.meta?.jobId === 'string' && log.meta.jobId) ||
      null;
    if (txId) {
      if (log.type === 'copy_job_failed') {
        failedTxIds.add(txId);
        continue;
      }
      if (failedTxIds.has(txId)) continue;
      if (seenTxIds.has(txId)) continue;
      seenTxIds.add(txId);
    }

    const amountRaw = log.meta?.amount ?? log.meta?.chargedAmount;
    const amount = typeof amountRaw === 'number' ? amountRaw : Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const ts = new Date(log.timestamp);
    if (Number.isNaN(ts.getTime())) continue;

    if (ts >= bounds.startOfToday) today += amount;
    if (ts >= bounds.startOfWeek) week += amount;
  }

  return { today: roundMoney(today), week: roundMoney(week) };
}

export function sumDirectLedger(
  entries: Iterable<FinancialLedgerEntry>,
  bounds: {
    startOfToday: Date;
    startOfWeek: Date;
    startOfMonth: Date;
    startOfYear: Date;
  },
): { today: number; week: number; month: number; year: number } {
  const totals = { today: 0, week: 0, month: 0, year: 0 };
  for (const entry of entries) {
    if (!isDirectPayment(entry.meta)) continue;
    if (entry.meta?.environment === 'test') continue;
    if (
      entry.eventType !== 'job_completed' &&
      entry.eventType !== 'refund_issued'
    ) {
      continue;
    }
    const amount = Number(entry.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const ts = new Date(entry.timestamp);
    if (Number.isNaN(ts.getTime())) continue;

    const signed = entry.eventType === 'refund_issued' ? -amount : amount;
    if (ts >= bounds.startOfToday) totals.today += signed;
    if (ts >= bounds.startOfWeek) totals.week += signed;
    if (ts >= bounds.startOfMonth) totals.month += signed;
    if (ts >= bounds.startOfYear) totals.year += signed;
  }
  return {
    today: roundMoney(totals.today),
    week: roundMoney(totals.week),
    month: roundMoney(totals.month),
    year: roundMoney(totals.year),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec jest src/modules/admin/earnings-split.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Use the helpers in `admin.service.ts`**

5a. Add the import near the other local imports:

```ts
import {
  isDirectPayment,
  sumDirectLedger,
  sumEarningsLogs,
} from './earnings-split';
```

5b. Replace the whole `computeEarningsBuckets(now = new Date()) { ... }` method (from its signature to its closing brace, before `findUnreconciledCopyTransactions`) with:

```ts
  private earningsWindow(now: Date): { startOfToday: Date; startOfWeek: Date } {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - 6);
    return { startOfToday, startOfWeek };
  }

  private listEarningsLogsSince(startOfWeek: Date) {
    // Date-bounded query avoids transferring all payment logs.
    return adminLogStore.listByTypesSince(
      [
        'payment_confirmed',
        'copy_job_enqueued',
        'copy_job_completed',
        'copy_job_failed',
      ],
      startOfWeek.toISOString(),
    );
  }

  computeEarningsBuckets(now = new Date()) {
    const bounds = this.earningsWindow(now);
    const { today, week } = sumEarningsLogs(
      this.listEarningsLogsSince(bounds.startOfWeek),
      bounds,
      (meta) => !isDirectPayment(meta),
    );
    return {
      today,
      week,
      allTime: Number(db.data!.earnings.toFixed(2)),
    };
  }

  computeDirectEarningsBuckets(now = new Date()) {
    const bounds = this.earningsWindow(now);
    const { today, week } = sumEarningsLogs(
      this.listEarningsLogsSince(bounds.startOfWeek),
      bounds,
      isDirectPayment,
    );
    return {
      today,
      week,
      allTime: Number(db.data!.directEarnings.toFixed(2)),
    };
  }
```

5c. In `export interface EarningsAnalyticsResult`, add to `totals` after `period: number;`:

```ts
    period: number;
    direct: {
      today: number;
      week: number;
      month: number;
      year: number;
      allTime: number;
    };
```

5d. In `computeDetailedEarningsAnalytics`, inside `for (const entry of db.data!.financialLedger) {`, add directly after the `environment === 'test'` skip:

```ts
      if (isDirectPayment(entry.meta)) {
        continue;
      }
```

5e. Directly before `const buckets = period.buckets.map(` in the same method, add:

```ts
    const direct = sumDirectLedger(db.data!.financialLedger, {
      startOfToday,
      startOfWeek,
      startOfMonth,
      startOfYear,
    });
```

5f. In the returned `totals`, add after `period: this.normalizeMoney(periodTotal),`:

```ts
        period: this.normalizeMoney(periodTotal),
        direct: {
          today: this.normalizeMoney(direct.today),
          week: this.normalizeMoney(direct.week),
          month: this.normalizeMoney(direct.month),
          year: this.normalizeMoney(direct.year),
          allTime: this.normalizeMoney(db.data!.directEarnings),
        },
```

- [ ] **Step 6: Add `directEarnings` to the dashboard payloads**

In `src/modules/admin/admin.controller.ts`, at both lines containing `earnings: this.adminService.computeEarningsBuckets(),` (~1189 and ~1254), add the next line:

```ts
        earnings: this.adminService.computeEarningsBuckets(),
        directEarnings: this.adminService.computeDirectEarningsBuckets(),
```

- [ ] **Step 7: Typecheck and run admin tests**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors. If `listByTypesSince` returns a store-specific log type that TypeScript rejects for `Iterable<AdminLogEntry>`, fix it at the call site with `as Iterable<AdminLogEntry>` (same fields).

Run: `pnpm exec jest src/modules/admin`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/admin/earnings-split.ts src/modules/admin/earnings-split.spec.ts src/modules/admin/admin.service.ts src/modules/admin/admin.controller.ts
git commit -m "feat(earnings): separate direct earnings from kiosk earnings"
```

---

### Task 5: Admin UI — Direct card and transaction badge

**Files:**
- Modify: `src/public/admin/shared.ts:357-364`
- Modify: `src/public/admin/earnings/index.html` (after the service-mix `</section>`, ~line 420)
- Modify: `src/public/admin/earnings/app.ts` (element refs ~line 53, `renderAnalytics` ~147)
- Modify: `src/public/admin/transactions/app.ts:803`, `:830`
- Modify: `src/public/admin/transactions/styles.css` (after `.tx-mode-badge--scan`)

**Interfaces:**
- Consumes: analytics `totals.direct` (Task 4); log `meta.paymentSource` (Task 3).
- Produces: UI only.

- [ ] **Step 1: Extend the client type**

In `src/public/admin/shared.ts`, in `EarningsAnalyticsResponse.totals`, add after `period: number;`:

```ts
    period: number;
    direct: {
      today: number;
      week: number;
      month: number;
      year: number;
      allTime: number;
    };
```

- [ ] **Step 2: Add the Direct card markup**

In `src/public/admin/earnings/index.html`, directly after the closing `</section>` of `<section class="service-mix earnings-breakdown-grid" aria-labelledby="serviceMixTitle">`, add:

```html
            <section class="service-mix earnings-breakdown-grid" aria-labelledby="directMixTitle">
              <div class="service-mix__header">
                <h4 id="directMixTitle">Direct (bypass)</h4>
                <p>Paid to staff, printed from the Coin Console. Not in kiosk totals.</p>
              </div>
              <div class="service-mix__item">
                <span>Today</span><strong id="directToday">₱ 0.00</strong>
              </div>
              <div class="service-mix__item">
                <span>Last 7 days</span><strong id="directWeek">₱ 0.00</strong>
              </div>
              <div class="service-mix__item">
                <span>This month</span><strong id="directMonth">₱ 0.00</strong>
              </div>
              <div class="service-mix__item">
                <span>All time</span><strong id="directAllTime">₱ 0.00</strong>
              </div>
            </section>
```

- [ ] **Step 3: Render it**

In `src/public/admin/earnings/app.ts`, after `const serviceScan = document.getElementById('serviceScan')!;` add:

```ts
const directToday = document.getElementById('directToday')!;
const directWeek = document.getElementById('directWeek')!;
const directMonth = document.getElementById('directMonth')!;
const directAllTime = document.getElementById('directAllTime')!;
```

In `renderAnalytics`, after `serviceScan.textContent = peso(model.services[2].amount);` add:

```ts
  directToday.textContent = peso(current.totals.direct.today);
  directWeek.textContent = peso(current.totals.direct.week);
  directMonth.textContent = peso(current.totals.direct.month);
  directAllTime.textContent = peso(current.totals.direct.allTime);
```

- [ ] **Step 4: Add the transaction badge**

In `src/public/admin/transactions/app.ts`, after the `const modeBadge = ...;` line (~803) add:

```ts
    const directBadge =
      log.meta?.paymentSource === 'direct'
        ? ' <span class="tx-mode-badge tx-mode-badge--direct">Direct</span>'
        : '';
```

Change the mode cell (~830) from:

```ts
      <td class="logs-td logs-td--mode">${modeBadge}</td>
```

to:

```ts
      <td class="logs-td logs-td--mode">${modeBadge}${directBadge}</td>
```

In `src/public/admin/transactions/styles.css`, after the `.tx-mode-badge--scan { ... }` rule add:

```css
.tx-mode-badge--direct {
  margin-left: 6px;
  background: rgba(120, 200, 160, 0.18);
  color: #9fe0bf;
  border: 1px solid rgba(120, 200, 160, 0.35);
}
```

- [ ] **Step 5: Typecheck and build the client**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `node scripts/build-client.js`
Expected: exits 0 and rewrites `src/public/admin/earnings/app.js` and `src/public/admin/transactions/app.js`.

- [ ] **Step 6: Commit**

```bash
git add src/public/admin/shared.ts src/public/admin/earnings src/public/admin/transactions
git commit -m "feat(admin-ui): show direct earnings card and direct transaction badge"
```

---

### Task 6: `/scc` Direct Print panel

**Files:**
- Create: `src/public/scc/direct-print-request.ts`
- Test: `src/public/scc/direct-print-request.spec.ts`
- Create: `src/public/scc/direct-print.ts`
- Modify: `src/public/scc/index.html` (insert before `<div id="messageBanner"`)
- Modify: `src/public/scc/styles.css` (append)
- Modify: `src/public/scc/app.ts` (`connectSocket`, `showMain`, `bootstrap`)

**Interfaces:**
- Consumes: `GET /api/wireless/sessions` → `{ sessionId, token }`; `POST /api/wireless/sessions/:id/upload?token=` (multipart `file`, header `x-upload-client-id`) → `{ documentId, fileName }`; `POST /api/print/quote` → `{ quote: { requiredAmount, selectedPages } }` or 409 `{ code: 'ANALYSIS_PENDING' | 'ANALYSIS_UNAVAILABLE' | 'ANALYSIS_FAILED' }`; `POST /api/admin/direct-print/confirm` (Task 3) → `{ transactionId, chargedAmount }`; `GET /api/admin/earnings/analytics?view=daily` → `totals.direct` (Task 4); socket `printLifecycleState` `{ transactionId, state: 'queued' | 'processing' | 'paused' | 'printed' | 'failed', reason? }`.
- Produces: `DirectPrintOptions`, `MAX_DIRECT_COPIES`, `QUOTE_MAX_ATTEMPTS`, `buildDirectPrintSettings()`, `buildQuoteBody()`, `buildConfirmBody()`, `shouldRetryQuote()`; `initDirectPrint(): void`, `refreshDirectEarnings(): Promise<void>`, `handleDirectPrintLifecycle(payload: unknown): void`.

- [ ] **Step 1: Write the failing tests**

Create `src/public/scc/direct-print-request.spec.ts`:

```ts
import {
  buildConfirmBody,
  buildDirectPrintSettings,
  buildQuoteBody,
  QUOTE_MAX_ATTEMPTS,
  shouldRetryQuote,
  type DirectPrintOptions,
} from './direct-print-request';

const base: DirectPrintOptions = {
  copies: 2,
  colorMode: 'grayscale',
  paperSize: 'A4',
  duplex: false,
  quality: 'standard',
  orientation: 'portrait',
  pageRange: ' 1-3 ',
};

describe('buildDirectPrintSettings', () => {
  it('trims the page range', () => {
    expect(buildDirectPrintSettings(base).pageRange).toBe('1-3');
  });

  it('treats a blank page range as all pages', () => {
    expect(buildDirectPrintSettings({ ...base, pageRange: '   ' }).pageRange).toBeNull();
  });

  it('clamps copies to 1..99', () => {
    expect(buildDirectPrintSettings({ ...base, copies: 0 }).copies).toBe(1);
    expect(buildDirectPrintSettings({ ...base, copies: 150 }).copies).toBe(99);
    expect(buildDirectPrintSettings({ ...base, copies: Number.NaN }).copies).toBe(1);
    expect(buildDirectPrintSettings({ ...base, copies: 2.7 }).copies).toBe(2);
  });
});

describe('request bodies', () => {
  it('quote body carries session, document and settings', () => {
    expect(buildQuoteBody('s-1', 'd-1', base)).toMatchObject({
      sessionId: 's-1',
      documentId: 'd-1',
      copies: 2,
      pageRange: '1-3',
      rotationDeg: 0,
    });
  });

  it('confirm body is always a print job', () => {
    expect(buildConfirmBody('s-1', 'd-1', base, 'corr-1')).toMatchObject({
      mode: 'print',
      sessionId: 's-1',
      documentId: 'd-1',
      spoolerCorrelationKey: 'corr-1',
    });
  });
});

describe('shouldRetryQuote', () => {
  it('retries while analysis is pending', () => {
    expect(shouldRetryQuote(409, 'ANALYSIS_PENDING', 0)).toBe(true);
    expect(shouldRetryQuote(409, 'ANALYSIS_UNAVAILABLE', 3)).toBe(true);
  });

  it('stops on failure codes, other statuses, and the last attempt', () => {
    expect(shouldRetryQuote(409, 'ANALYSIS_FAILED', 0)).toBe(false);
    expect(shouldRetryQuote(400, 'ANALYSIS_PENDING', 0)).toBe(false);
    expect(shouldRetryQuote(409, null, 0)).toBe(false);
    expect(shouldRetryQuote(409, 'ANALYSIS_PENDING', QUOTE_MAX_ATTEMPTS - 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec jest src/public/scc/direct-print-request.spec.ts`
Expected: FAIL with `Cannot find module './direct-print-request'`.

- [ ] **Step 3: Create the pure builders**

Create `src/public/scc/direct-print-request.ts`:

```ts
export type DirectPrintOptions = {
  copies: number;
  colorMode: 'colored' | 'grayscale';
  paperSize: 'A4' | 'Short' | 'Long';
  duplex: boolean;
  quality: 'standard' | 'high';
  orientation: 'portrait' | 'landscape';
  pageRange: string;
};

export const MAX_DIRECT_COPIES = 99;
export const QUOTE_MAX_ATTEMPTS = 20;

const RETRYABLE_QUOTE_CODES = new Set(['ANALYSIS_PENDING', 'ANALYSIS_UNAVAILABLE']);

export function buildDirectPrintSettings(opts: DirectPrintOptions) {
  const copies = Number.isFinite(opts.copies)
    ? Math.min(MAX_DIRECT_COPIES, Math.max(1, Math.floor(opts.copies)))
    : 1;
  const pageRange = opts.pageRange.trim();
  return {
    copies,
    colorMode: opts.colorMode,
    paperSize: opts.paperSize,
    duplex: opts.duplex,
    quality: opts.quality,
    orientation: opts.orientation,
    rotationDeg: 0,
    pageRange: pageRange.length > 0 ? pageRange : null,
  };
}

export function buildQuoteBody(
  sessionId: string,
  documentId: string,
  opts: DirectPrintOptions,
) {
  return { sessionId, documentId, ...buildDirectPrintSettings(opts) };
}

export function buildConfirmBody(
  sessionId: string,
  documentId: string,
  opts: DirectPrintOptions,
  spoolerCorrelationKey: string,
) {
  return {
    mode: 'print' as const,
    sessionId,
    documentId,
    ...buildDirectPrintSettings(opts),
    spoolerCorrelationKey,
  };
}

export function shouldRetryQuote(
  status: number,
  code: string | null,
  attempt: number,
): boolean {
  return (
    status === 409 &&
    code !== null &&
    RETRYABLE_QUOTE_CODES.has(code) &&
    attempt < QUOTE_MAX_ATTEMPTS - 1
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec jest src/public/scc/direct-print-request.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the panel markup**

In `src/public/scc/index.html`, insert directly before `<div id="messageBanner" class="message-banner hidden" role="status"></div>`:

```html
      <section class="direct-print" aria-labelledby="directPrintTitle">
        <h2 id="directPrintTitle" class="coin-console-section-title">
          Direct print (no coins)
        </h2>
        <p class="direct-print__hint">
          For customers who paid you directly. Charged at the kiosk price and
          recorded as direct earnings.
        </p>

        <form id="directPrintForm" class="direct-print__form" novalidate>
          <label class="direct-print__field direct-print__field--wide">
            <span>File</span>
            <input
              id="directFile"
              type="file"
              accept=".pdf,.doc,.docx,.jpeg,.jpg,.png,.gif,.webp,.bmp,image/jpeg,image/png,image/gif,image/webp,image/bmp"
              required
            />
          </label>
          <label class="direct-print__field">
            <span>Copies</span>
            <input id="directCopies" type="number" min="1" max="99" value="1" inputmode="numeric" />
          </label>
          <label class="direct-print__field">
            <span>Color</span>
            <select id="directColor">
              <option value="grayscale">Grayscale</option>
              <option value="colored">Colored</option>
            </select>
          </label>
          <label class="direct-print__field">
            <span>Paper</span>
            <select id="directPaper">
              <option value="A4">A4</option>
              <option value="Short">Short</option>
              <option value="Long">Long</option>
            </select>
          </label>
          <label class="direct-print__field">
            <span>Orientation</span>
            <select id="directOrientation">
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
          <label class="direct-print__field">
            <span>Quality</span>
            <select id="directQuality">
              <option value="standard">Standard</option>
              <option value="high">High</option>
            </select>
          </label>
          <label class="direct-print__field">
            <span>Page range</span>
            <input id="directPageRange" type="text" placeholder="All pages, or e.g. 1-3, 5" />
          </label>
          <label class="direct-print__field direct-print__field--check">
            <input id="directDuplex" type="checkbox" />
            <span>Double-sided</span>
          </label>
        </form>

        <div class="direct-print__summary">
          <span>Price:</span>
          <strong id="directPrice">—</strong>
          <span id="directStatus" class="direct-print__status" role="status" aria-live="polite"></span>
        </div>

        <div class="direct-print__actions">
          <button id="directPrintBtn" type="button" class="coin-button direct-print__btn" disabled>
            Print (direct)
          </button>
          <button id="directResetBtn" type="button" class="reset-button">New job</button>
        </div>

        <p class="direct-print__earnings">
          Direct earnings today: <strong id="directEarningsToday">—</strong>
          · All time: <strong id="directEarningsAllTime">—</strong>
        </p>
      </section>
```

- [ ] **Step 6: Add the panel styles**

Append to `src/public/scc/styles.css`:

```css
.direct-print {
  margin-top: 40px;
  padding-top: 24px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.direct-print__hint {
  margin: 0 0 16px;
  opacity: 0.7;
  font-size: 0.9rem;
}

.direct-print__form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.direct-print__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.85rem;
}

.direct-print__field--wide {
  grid-column: 1 / -1;
}

.direct-print__field--check {
  flex-direction: row;
  align-items: center;
}

.direct-print__field input:not([type='checkbox']),
.direct-print__field select {
  min-height: 44px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  font: inherit;
}

.direct-print__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin: 20px 0 12px;
}

.direct-print__status {
  opacity: 0.75;
  font-size: 0.9rem;
}

.direct-print__actions {
  display: flex;
  gap: 12px;
}

.direct-print__btn {
  flex: 1;
  padding: 16px 12px;
  font-size: 1.1rem;
}

.direct-print__earnings {
  margin-top: 16px;
  opacity: 0.8;
  font-size: 0.9rem;
}

@media (max-width: 480px) {
  .direct-print__form {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 7: Create the panel logic**

Create `src/public/scc/direct-print.ts`:

```ts
import { apiFetch, peso, setMessage } from '../admin/shared';
import {
  buildConfirmBody,
  buildQuoteBody,
  shouldRetryQuote,
  type DirectPrintOptions,
} from './direct-print-request';

const QUOTE_RETRY_DELAY_MS = 1500;

type SessionResponse = { sessionId: string; token: string };
type UploadResponse = { documentId: string; fileName: string };
type QuotePayload = {
  quote?: { requiredAmount: number; selectedPages: number };
  error?: string;
  code?: string;
};
type ConfirmPayload = {
  transactionId?: string;
  chargedAmount?: number;
  error?: string;
  message?: string;
};

/** crypto.randomUUID needs a secure context; /scc is served over plain HTTP on the LAN. */
function randomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const clientId = randomId();

const state = {
  sessionId: null as string | null,
  token: '',
  documentId: null as string | null,
  price: null as number | null,
  idempotencyKey: null as string | null,
  spoolerCorrelationKey: null as string | null,
  transactionId: null as string | null,
  quoteVersion: 0,
  busy: false,
};

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const fileInput = el<HTMLInputElement>('directFile');
const copiesInput = el<HTMLInputElement>('directCopies');
const colorSelect = el<HTMLSelectElement>('directColor');
const paperSelect = el<HTMLSelectElement>('directPaper');
const orientationSelect = el<HTMLSelectElement>('directOrientation');
const qualitySelect = el<HTMLSelectElement>('directQuality');
const pageRangeInput = el<HTMLInputElement>('directPageRange');
const duplexInput = el<HTMLInputElement>('directDuplex');
const priceEl = el<HTMLElement>('directPrice');
const statusEl = el<HTMLElement>('directStatus');
const printBtn = el<HTMLButtonElement>('directPrintBtn');
const resetBtn = el<HTMLButtonElement>('directResetBtn');
const earningsTodayEl = el<HTMLElement>('directEarningsToday');
const earningsAllTimeEl = el<HTMLElement>('directEarningsAllTime');

function readOptions(): DirectPrintOptions {
  return {
    copies: Number.parseInt(copiesInput.value, 10),
    colorMode: colorSelect.value === 'colored' ? 'colored' : 'grayscale',
    paperSize:
      paperSelect.value === 'Short' || paperSelect.value === 'Long'
        ? paperSelect.value
        : 'A4',
    duplex: duplexInput.checked,
    quality: qualitySelect.value === 'high' ? 'high' : 'standard',
    orientation:
      orientationSelect.value === 'landscape' ? 'landscape' : 'portrait',
    pageRange: pageRangeInput.value,
  };
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function syncPrintButton(): void {
  printBtn.disabled =
    state.busy || !state.documentId || state.price === null;
}

function invalidateJob(): void {
  // New file or new options: a new price and a new payment attempt.
  state.price = null;
  state.idempotencyKey = null;
  state.spoolerCorrelationKey = null;
  priceEl.textContent = '—';
  syncPrintButton();
}

function forgetSession(): void {
  state.sessionId = null;
  state.token = '';
  state.documentId = null;
  invalidateJob();
}

async function ensureSession(): Promise<SessionResponse> {
  if (state.sessionId) return { sessionId: state.sessionId, token: state.token };
  const res = await apiFetch('/api/wireless/sessions');
  if (!res.ok) throw new Error(`Could not open an upload session (HTTP ${res.status}).`);
  const session = (await res.json()) as SessionResponse;
  state.sessionId = session.sessionId;
  state.token = session.token;
  return session;
}

async function uploadSelectedFile(): Promise<void> {
  const file = fileInput.files?.[0];
  invalidateJob();
  state.documentId = null;
  if (!file) return;

  state.busy = true;
  syncPrintButton();
  setStatus(`Uploading ${file.name}…`);
  try {
    const session = await ensureSession();
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(
      `/api/wireless/sessions/${encodeURIComponent(session.sessionId)}/upload?token=${encodeURIComponent(session.token)}`,
      {
        method: 'POST',
        body: form,
        headers: { 'x-upload-client-id': clientId },
        credentials: 'include',
      },
    );
    if (res.status === 410) {
      forgetSession();
      throw new Error('Upload session expired. Choose the file again.');
    }
    const payload = (await res.json().catch(() => ({}))) as Partial<UploadResponse> & {
      error?: string;
    };
    if (!res.ok || !payload.documentId) {
      throw new Error(payload.error ?? `Upload failed (HTTP ${res.status}).`);
    }
    state.documentId = payload.documentId;
    setStatus(`Uploaded ${payload.fileName ?? file.name}. Calculating price…`);
    state.busy = false;
    await refreshQuote();
  } catch (error) {
    setStatus('');
    setMessage(error instanceof Error ? error.message : 'Upload failed.');
  } finally {
    state.busy = false;
    syncPrintButton();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function refreshQuote(): Promise<void> {
  invalidateJob();
  if (!state.sessionId || !state.documentId) return;
  const version = ++state.quoteVersion;
  const body = JSON.stringify(
    buildQuoteBody(state.sessionId, state.documentId, readOptions()),
  );

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch('/api/print/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (version !== state.quoteVersion) return;
    const payload = (await res.json().catch(() => ({}))) as QuotePayload;
    const code = typeof payload.code === 'string' ? payload.code : null;

    if (shouldRetryQuote(res.status, code, attempt)) {
      setStatus('Analyzing pages…');
      await delay(QUOTE_RETRY_DELAY_MS);
      if (version !== state.quoteVersion) return;
      continue;
    }
    if (res.status === 410) {
      forgetSession();
      setMessage('Upload session expired. Choose the file again.');
      return;
    }
    if (!res.ok || !payload.quote) {
      setStatus('');
      setMessage(payload.error ?? `Could not calculate price (HTTP ${res.status}).`);
      return;
    }
    state.price = payload.quote.requiredAmount;
    priceEl.textContent = peso(payload.quote.requiredAmount);
    setStatus(`${payload.quote.selectedPages} page(s) selected.`);
    syncPrintButton();
    return;
  }
}

async function printDirect(): Promise<void> {
  if (!state.sessionId || !state.documentId || state.price === null) return;
  state.busy = true;
  syncPrintButton();
  // Same key on retry of the same job, so the server dedupes double submits.
  const idempotencyKey = (state.idempotencyKey ??= randomId());
  const spoolerCorrelationKey = (state.spoolerCorrelationKey ??= randomId());
  const price = state.price;
  setStatus('Sending to printer…');

  try {
    const res = await apiFetch('/api/admin/direct-print/confirm', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(
        buildConfirmBody(
          state.sessionId,
          state.documentId,
          readOptions(),
          spoolerCorrelationKey,
        ),
      ),
    });
    const payload = (await res.json().catch(() => ({}))) as ConfirmPayload;
    if (!res.ok) {
      throw new Error(
        payload.error ?? payload.message ?? `Print failed (HTTP ${res.status}).`,
      );
    }
    state.transactionId = payload.transactionId ?? null;
    setStatus(`Queued. Charged ${peso(payload.chargedAmount ?? price)} to direct earnings.`);
    setMessage('Direct print queued.');
    // Printed once: block a second accidental print of the same job.
    state.documentId = null;
    invalidateJob();
    await refreshDirectEarnings();
  } catch (error) {
    setStatus('');
    setMessage(error instanceof Error ? error.message : 'Print failed.');
  } finally {
    state.busy = false;
    syncPrintButton();
  }
}

function resetJob(): void {
  forgetSession();
  state.transactionId = null;
  fileInput.value = '';
  copiesInput.value = '1';
  pageRangeInput.value = '';
  duplexInput.checked = false;
  setStatus('');
}

export async function refreshDirectEarnings(): Promise<void> {
  try {
    const res = await apiFetch('/api/admin/earnings/analytics?view=daily');
    if (!res.ok) return;
    const data = (await res.json()) as {
      totals?: { direct?: { today: number; allTime: number } };
    };
    const direct = data.totals?.direct;
    if (!direct) return;
    earningsTodayEl.textContent = peso(direct.today);
    earningsAllTimeEl.textContent = peso(direct.allTime);
  } catch {
    // Readout is informational; leave the last value.
  }
}

export function handleDirectPrintLifecycle(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const evt = payload as { transactionId?: unknown; state?: unknown; reason?: unknown };
  if (!state.transactionId || evt.transactionId !== state.transactionId) return;
  const lifecycle = typeof evt.state === 'string' ? evt.state : 'unknown';
  if (lifecycle === 'printed') {
    setStatus('Printed.');
  } else if (lifecycle === 'failed') {
    const reason = typeof evt.reason === 'string' && evt.reason ? `: ${evt.reason}` : '';
    setStatus(`Print failed${reason}. Direct earnings were reversed; refund the customer.`);
    void refreshDirectEarnings();
  } else {
    setStatus(`Printer: ${lifecycle}…`);
  }
}

export function initDirectPrint(): void {
  fileInput.addEventListener('change', () => {
    void uploadSelectedFile();
  });
  for (const input of [
    copiesInput,
    colorSelect,
    paperSelect,
    orientationSelect,
    qualitySelect,
    pageRangeInput,
    duplexInput,
  ]) {
    input.addEventListener('change', () => {
      void refreshQuote();
    });
  }
  printBtn.addEventListener('click', () => {
    void printDirect();
  });
  resetBtn.addEventListener('click', resetJob);
}
```

- [ ] **Step 8: Wire the panel into `app.ts`**

In `src/public/scc/app.ts`:

8a. Add below the first import line:

```ts
import {
  handleDirectPrintLifecycle,
  initDirectPrint,
  refreshDirectEarnings,
} from './direct-print';
```

8b. In `connectSocket()`, after the `socket.on('coinAccepted', ...)` handler, add:

```ts
    socket.on('printLifecycleState', handleDirectPrintLifecycle);
```

8c. In `showMain()`, after `void refreshLiveBalance();` add:

```ts
  void refreshDirectEarnings();
```

8d. In `bootstrap()`, inside `if (!initialized) {`, after `bindResetButton();` add:

```ts
        initDirectPrint();
```

- [ ] **Step 9: Typecheck, lint, and build**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `pnpm run lint`
Expected: no new errors in `src/public/scc/`.

Run: `node scripts/build-client.js`
Expected: exits 0 and rewrites `src/public/scc/app.js` (the existing entry `src/public/scc/app.ts` bundles `direct-print.ts`).

- [ ] **Step 10: Commit**

```bash
git add src/public/scc
git commit -m "feat(scc): direct print panel with kiosk pricing"
```

---

### Task 7: End-to-end verification

**Files:** none new. `graphify-out/` may change.

- [ ] **Step 1: Full test suite**

Run: `pnpm exec jest`
Expected: all suites PASS. The new suites are `settlement.spec.ts`, `pending-refund.spec.ts`, `financial.controller.spec.ts`, `earnings-split.spec.ts`, and `direct-print-request.spec.ts`.

- [ ] **Step 2: Full build**

Run: `pnpm run build`
Expected: exits 0.

- [ ] **Step 3: Manual smoke test on the kiosk (printer connected, developer mode OFF)**

1. Start the server with `pnpm run dev`. Open `http://<kiosk-ip>:<port>/scc` from a phone on the hotspot and unlock it with the admin PIN.
2. Note the Earnings page totals and the coin console "Live balance".
3. In Direct print, pick a 2-page PDF with copies 1, grayscale. Expected: status "Analyzing pages…" then a price.
4. Press **Print (direct)**. Expected: the page prints. Status goes Queued, then Printer: processing…, then Printed. "Direct earnings today" goes up by the price.
5. Expected: the Live balance is unchanged. On `/admin/earnings`, kiosk totals are unchanged and the Direct (bypass) card shows the price. On `/admin/transactions`, the row has a **Direct** badge.
6. Press **Print (direct)** again without a new file. Expected: the button is disabled.
7. Unplug the printer and direct-print again. Expected: the job fails, the status says to refund the customer, direct earnings go back down, and the coin balance is unchanged.

- [ ] **Step 4: Update the knowledge graph**

Run: `graphify update .`
Expected: exits 0. If `graphify` is not on PATH, note it in the hand-off and skip.

- [ ] **Step 5: Commit any graph changes**

```bash
git add graphify-out
git commit -m "chore: update graphify graph for scc direct print"
```

Skip this commit if `git status --short` shows no changes.
