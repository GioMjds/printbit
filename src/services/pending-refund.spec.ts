type MockData = {
  balance: number;
  earnings: number;
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
  processPendingRefund,
  upsertSpoolerFailureRefund,
} from './pending-refund';

const directLedgerTag = expect.objectContaining({
  eventType: 'refund_issued',
  meta: expect.objectContaining({ paymentSource: 'direct' }),
});

beforeEach(() => {
  mockDb.data = {
    balance: 3,
    earnings: 50,
    pendingRefunds: [],
    financialLedger: [],
  };
  mockAppend.mockClear();
});

describe('upsertSpoolerFailureRefund', () => {
  it('direct job: tags the refund and never touches coin balance or earnings', async () => {
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
    expect(outcome.restoredBalanceAmount).toBe(0);
    expect(outcome.entry.reason).toBe(
      'Enqueue failed (direct: refund customer manually)',
    );
    expect(outcome.entry.jobContext.paymentSource).toBe('direct');
    expect(mockAppend).toHaveBeenCalledWith(directLedgerTag);
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
    expect(mockDb.data.earnings).toBe(50);
    expect(mockAppend).toHaveBeenCalledWith(directLedgerTag);
  });

  it('kiosk job: refunds to the coin balance as before', async () => {
    await upsertSpoolerFailureRefund({
      chargedAmount: 8,
      reason: 'Enqueue failed',
      autoRefund: true,
      jobContext: { transactionId: 'tx-k', spoolerCorrelationKey: 'k-3' },
    });

    expect(mockDb.data.balance).toBe(11);
    expect(mockDb.data.earnings).toBe(42);
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
    expect(mockDb.data.earnings).toBe(50);
    expect(mockDb.data.pendingRefunds[0].status).toBe('open');
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('cash refund leaves kiosk earnings alone and tags the ledger', async () => {
    await processPendingRefund({ entryId: 'r-1', restoreBalance: false });
    expect(mockDb.data.earnings).toBe(50);
    expect(mockDb.data.balance).toBe(3);
    expect(mockAppend).toHaveBeenCalledWith(directLedgerTag);
  });
});

describe('processPendingRefund for kiosk entries', () => {
  beforeEach(() => {
    mockDb.data.pendingRefunds.push({
      id: 'r-k',
      timestamp: '2026-11-26T01:00:00.000Z',
      chargedAmount: 8,
      reason: 'Worker failed',
      status: 'open',
      closedAt: null,
      jobContext: { transactionId: 'tx-k' },
    });
  });

  it('restore balance still credits the coin balance', async () => {
    await processPendingRefund({ entryId: 'r-k', restoreBalance: true });
    expect(mockDb.data.balance).toBe(11);
    expect(mockDb.data.earnings).toBe(42);
  });
});
