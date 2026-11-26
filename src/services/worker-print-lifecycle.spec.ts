import fs from 'node:fs';

jest.mock('@/services/admin', () => ({
  adminService: { appendAdminLog: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@/modules/receipt/receipt.service', () => ({
  ReceiptService: jest.fn().mockImplementation(() => ({
    updateTerminalStatus: jest.fn(),
  })),
}));
jest.mock('@/services/recovery', () => ({
  checkpointRecoverySession: jest.fn().mockResolvedValue(undefined),
  getRecoverySession: jest.fn(),
  getSpoolerLifecycleRecord: jest.fn().mockReturnValue(null),
}));
jest.mock('@/services/print-lifecycle-state', () => ({
  persistAndEmitPrintLifecycleState: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/services/pending-refund', () => ({
  PendingRefundServiceError: class extends Error {},
  upsertSpoolerFailureRefund: jest.fn(),
}));
jest.mock('@/services/transient-scan-file', () => ({
  deleteTransientScanFile: jest.fn(),
}));
jest.mock('@/core/database/sqlite-storage', () => ({
  ADMIN_TEST_PAGE_USAGE_SOURCE: 'admin-test-page',
  consumablesStore: { appendUsageEvent: jest.fn() },
}));
jest.mock('@/modules/admin/consumables.service', () => ({
  evaluateConsumablesForecastAlerts: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/services/consumable-estimator', () => ({
  estimateInkUsageByJob: jest.fn().mockReturnValue(0),
}));
jest.mock('@/services/time-source', () => ({
  getTrustedTimestamp: () => ({ timestamp: new Date().toISOString() }),
}));
jest.mock('./admin-push.service', () => ({ adminPushService: {} }));
jest.mock('./job-store', () => ({ jobStore: { updateJobState: jest.fn() } }));

import { getRecoverySession } from '@/services/recovery';
import { handleWorkerReturnPrintEvent } from './worker-print-lifecycle';

describe('worker print success cleanup', () => {
  const unlink = jest.spyOn(fs.promises, 'unlink').mockResolvedValue();

  beforeEach(() => {
    unlink.mockClear();
    // Same shape checkpointRecoverySession writes: ids on the entry, not in context.
    (getRecoverySession as jest.Mock).mockReturnValue({
      mode: 'print',
      requiredAmount: 5,
      sessionId: 'session-1',
      documentId: 'doc-1',
      context: { filename: 'stored-upload.pdf', copies: 1 },
    });
  });

  function completePrint(sessionStore: Record<string, jest.Mock>) {
    return handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrintSucceeded',
        transactionId: 'tx-1',
        timestampUtc: new Date().toISOString(),
      },
      io: { emit: jest.fn() } as never,
      sessionStore: sessionStore as never,
    });
  }

  it('keeps the upload while its session still lists the document', async () => {
    const sessionStore = {
      hasDocument: jest.fn().mockReturnValue(true),
      removeDocument: jest.fn(),
    };

    await completePrint(sessionStore);

    expect(sessionStore.hasDocument).toHaveBeenCalledWith('session-1', 'doc-1');
    expect(sessionStore.removeDocument).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('removes the document through the session once the session is gone', async () => {
    const sessionStore = {
      hasDocument: jest.fn().mockReturnValue(false),
      removeDocument: jest
        .fn()
        .mockResolvedValue({ success: true, deletedFile: true }),
    };

    await completePrint(sessionStore);

    expect(sessionStore.removeDocument).toHaveBeenCalledWith('session-1', 'doc-1');
    expect(unlink).not.toHaveBeenCalled();
  });
});
