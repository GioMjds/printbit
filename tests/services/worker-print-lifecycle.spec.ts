const persistAndEmitPrintLifecycleState = jest.fn();
const getSpoolerLifecycleRecord = jest.fn();
const getRecoverySession = jest.fn();
const appendUsageEvent = jest.fn();

jest.mock('../../src/services/recovery', () => ({
  checkpointRecoverySession: jest.fn(),
  getRecoverySession,
  getSpoolerLifecycleRecord,
}));

jest.mock('../../src/services/print-lifecycle-state', () => ({
  persistAndEmitPrintLifecycleState,
}));

jest.mock('../../src/core/database/sqlite-storage', () => ({
  ADMIN_TEST_PAGE_USAGE_SOURCE: 'admin-test-page',
  consumablesStore: { appendUsageEvent },
}));

jest.mock('../../src/services/consumable-estimator', () => ({
  estimateInkUsageByJob: jest.fn(() => ({ k: 0.015 })),
}));

jest.mock('../../src/modules/admin/consumables.service', () => ({
  evaluateConsumablesForecastAlerts: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/modules/receipt/receipt.service', () => ({
  ReceiptService: class {
    updateTerminalStatus = jest.fn();
  },
}));

jest.mock('../../src/services/job-store', () => ({
  jobStore: { updateJobState: jest.fn() },
}));

jest.mock('../../src/services/pending-refund', () => ({
  PendingRefundServiceError: class extends Error {},
  upsertSpoolerFailureRefund: jest.fn(),
}));

jest.mock('../../src/services/transient-scan-file', () => ({
  deleteTransientScanFile: jest.fn(),
}));

jest.mock('../../src/services/admin', () => ({
  adminService: { appendAdminLog: jest.fn() },
}));

import { handleWorkerReturnPrintEvent } from '../../src/services/worker-print-lifecycle';

describe('worker PrinterError lifecycle', () => {
  beforeEach(() => {
    persistAndEmitPrintLifecycleState.mockClear();
    getSpoolerLifecycleRecord.mockReset();
    appendUsageEvent.mockClear();
    getRecoverySession.mockReset();
    getRecoverySession.mockReturnValue({
      mode: 'print',
      requiredAmount: 10,
      sessionId: 'session-paper-out',
      documentId: 'document-paper-out',
      context: {},
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('emits a correlated maintenance failure for Epson paper-out', async () => {
    await handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrinterError',
        transactionId: 'tx-paper-out',
        spoolerCorrelationKey: 'spool-paper-out',
        printerName: 'EPSON L5290 Series',
        failureStage: 'hardware_error',
        message: 'Printer error (No Paper)',
        timestampUtc: '2026-08-31T00:00:00.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    });

    expect(persistAndEmitPrintLifecycleState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: 'print',
        state: 'failed',
        transactionId: 'tx-paper-out',
        spoolerCorrelationKey: 'spool-paper-out',
        printError: expect.objectContaining({
          code: 'WORKER_HARDWARE_ERROR',
          canRetry: false,
          canDismiss: false,
        }),
      }),
      expect.objectContaining({
        requiredAmount: 10,
        sessionId: 'session-paper-out',
        documentId: 'document-paper-out',
      }),
    );
  });

  test('ignores a late success after the correlated hardware failure is recorded', async () => {
    getSpoolerLifecycleRecord.mockReturnValue({
      currentState: 'failed',
      spoolerCorrelationKey: 'spool-paper-out',
    });

    await handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrintSucceeded',
        transactionId: 'tx-paper-out',
        spoolerCorrelationKey: 'spool-paper-out',
        printerName: 'EPSON L5290 Series',
        timestampUtc: '2026-08-31T00:00:01.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    });

    expect(persistAndEmitPrintLifecycleState).not.toHaveBeenCalled();
  });

  test('persists the worker final page count on successful completion', async () => {
    getSpoolerLifecycleRecord.mockReturnValue({
      currentState: 'processing',
      spoolerCorrelationKey: 'spool-complete',
    });

    await handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrintSucceeded',
        transactionId: 'tx-complete',
        spoolerCorrelationKey: 'spool-complete',
        printerName: 'EPSON L5290 Series',
        pagesPrinted: 4,
        totalPages: 4,
        timestampUtc: '2026-09-11T00:00:01.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    });

    expect(persistAndEmitPrintLifecycleState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        state: 'printed',
        pagesPrinted: 4,
        totalPages: 4,
      }),
      expect.anything(),
    );
  });

  test('waits for a correlated hardware failure to persist before processing success', async () => {
    let releaseFailurePersistence: (() => void) | undefined;
    let terminalFailureRecorded = false;
    const failurePersistence = new Promise<void>((resolve) => {
      releaseFailurePersistence = () => {
        terminalFailureRecorded = true;
        resolve();
      };
    });
    getSpoolerLifecycleRecord.mockImplementation(() =>
      terminalFailureRecorded
        ? {
            currentState: 'failed',
            spoolerCorrelationKey: 'spool-paper-out',
          }
        : null,
    );
    persistAndEmitPrintLifecycleState.mockImplementationOnce(
      () => failurePersistence,
    );

    const printerError = handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrinterError',
        transactionId: 'tx-paper-out',
        spoolerCorrelationKey: 'spool-paper-out',
        printerName: 'EPSON L5290 Series',
        failureStage: 'hardware_error',
        message: 'Printer error (No Paper)',
        timestampUtc: '2026-08-31T00:00:00.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    });
    const success = handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrintSucceeded',
        transactionId: 'tx-paper-out',
        spoolerCorrelationKey: 'spool-paper-out',
        printerName: 'EPSON L5290 Series',
        timestampUtc: '2026-08-31T00:00:01.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(persistAndEmitPrintLifecycleState).toHaveBeenCalledTimes(1);

    releaseFailurePersistence?.();
    await Promise.all([printerError, success]);

    expect(persistAndEmitPrintLifecycleState).toHaveBeenCalledTimes(1);
  });

  test('keeps a hardware failure terminal when lifecycle persistence is unavailable', async () => {
    getSpoolerLifecycleRecord.mockReturnValue(null);

    await handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrinterError',
        transactionId: 'tx-persist-failure',
        spoolerCorrelationKey: 'spool-persist-failure',
        printerName: 'EPSON L5290 Series',
        failureStage: 'hardware_error',
        message: 'Printer error (No Paper)',
        timestampUtc: '2026-08-31T00:00:00.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    });
    await handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrintSucceeded',
        transactionId: 'tx-persist-failure',
        spoolerCorrelationKey: 'spool-persist-failure',
        printerName: 'EPSON L5290 Series',
        timestampUtc: '2026-08-31T00:00:01.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    });

    expect(persistAndEmitPrintLifecycleState).toHaveBeenCalledTimes(1);
  });

  test('records one grayscale admin test page only after print success', async () => {
    getRecoverySession.mockReturnValue({
      mode: 'print',
      requiredAmount: 0,
      sessionId: null,
      documentId: null,
      context: {
        adminTestPrint: true,
        copies: 1,
        selectedPages: 1,
        billableColorPages: 0,
        billableBwPages: 1,
      },
    });

    await handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrintStarted',
        transactionId: 'tx-admin-test',
        spoolerCorrelationKey: 'spool-admin-test',
        printerName: 'EPSON L5290 Series',
        timestampUtc: '2026-09-06T01:00:00.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    });

    expect(appendUsageEvent).not.toHaveBeenCalled();

    await handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrintSucceeded',
        transactionId: 'tx-admin-test',
        spoolerCorrelationKey: 'spool-admin-test',
        printerName: 'EPSON L5290 Series',
        timestampUtc: '2026-09-06T01:00:01.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    });

    expect(appendUsageEvent).toHaveBeenCalledTimes(1);
    expect(appendUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-admin-test',
        billableColorPages: 0,
        billableBwPages: 1,
        source: 'admin-test-page',
      }),
    );
  });

  test('does not record an admin test page after a print failure', async () => {
    getRecoverySession.mockReturnValue({
      mode: 'print',
      requiredAmount: 0,
      sessionId: null,
      documentId: null,
      context: { adminTestPrint: true },
    });

    await handleWorkerReturnPrintEvent({
      evt: {
        type: 'PrintFailed',
        transactionId: 'tx-admin-test-failed',
        spoolerCorrelationKey: 'spool-admin-test-failed',
        printerName: 'EPSON L5290 Series',
        failureStage: 'spooler',
        message: 'Test page did not print.',
        timestampUtc: '2026-09-06T01:00:02.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    });

    expect(appendUsageEvent).not.toHaveBeenCalled();
  });

  test('uses an idempotent usage id for repeated admin test success events', async () => {
    getRecoverySession.mockReturnValue({
      mode: 'print',
      requiredAmount: 0,
      sessionId: null,
      documentId: null,
      context: {
        adminTestPrint: true,
        copies: 1,
        selectedPages: 1,
        billableColorPages: 0,
        billableBwPages: 1,
      },
    });
    const successEvent = {
      evt: {
        type: 'PrintSucceeded' as const,
        transactionId: 'tx-admin-test-repeat',
        spoolerCorrelationKey: 'spool-admin-test-repeat',
        printerName: 'EPSON L5290 Series',
        timestampUtc: '2026-09-06T01:00:03.000Z',
      },
      io: {} as never,
      sessionStore: {} as never,
    };

    await handleWorkerReturnPrintEvent(successEvent);
    await handleWorkerReturnPrintEvent(successEvent);

    expect(appendUsageEvent).toHaveBeenCalledTimes(2);
    expect(appendUsageEvent.mock.calls[0][0].id).toBe(
      appendUsageEvent.mock.calls[1][0].id,
    );
  });
});
