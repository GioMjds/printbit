import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import type { SessionStore } from '@/services/session';
import { adminService } from '@/services/admin';
import { ReceiptService } from '@/modules/receipt/receipt.service';
import {
  checkpointRecoverySession,
  getRecoverySession,
  getSpoolerLifecycleRecord,
} from '@/services/recovery';
import { persistAndEmitPrintLifecycleState } from '@/services/print-lifecycle-state';
import {
  PendingRefundServiceError,
  upsertSpoolerFailureRefund,
} from '@/services/pending-refund';
import { deleteTransientScanFile } from '@/services/transient-scan-file';
import {
  ADMIN_TEST_PAGE_USAGE_SOURCE,
  consumablesStore,
} from '@/core/database/sqlite-storage';
import { evaluateConsumablesForecastAlerts } from '@/modules/admin/consumables.service';
import { estimateInkUsageByJob } from '@/services/consumable-estimator';
import { getTrustedTimestamp } from '@/services/time-source';
import type { WorkerPrintEvent } from './worker-return-pipe';
import { jobStore } from './job-store';

const receiptService = new ReceiptService();
const workerEventChains = new Map<string, Promise<void>>();
const terminalWorkerFailures = new Map<string, string | null>();

function hasTerminalWorkerFailure(
  transactionId: string,
  spoolerCorrelationKey: string | null | undefined,
): boolean {
  if (!terminalWorkerFailures.has(transactionId)) return false;
  const failedSpoolerKey = terminalWorkerFailures.get(transactionId);
  return (
    !failedSpoolerKey ||
    !spoolerCorrelationKey ||
    failedSpoolerKey === spoolerCorrelationKey
  );
}

function parseSpoolerJobId(value: string | undefined | null): number | null {
  if (value === null) return null;
  const parsed = parseInt(value ?? '', 10);
  return Number.isInteger(parsed) ? parsed : null;
}

async function deleteUploadByStoredFilename(
  storedFilename: string,
): Promise<{ deleted: boolean; alreadyMissing: boolean }> {
  const uploadsDir = path.resolve('uploads');
  const normalized = storedFilename.trim();
  if (!normalized) {
    return { deleted: false, alreadyMissing: false };
  }

  const filePath = path.resolve(uploadsDir, normalized);
  const relativePath = path.relative(uploadsDir, filePath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return { deleted: false, alreadyMissing: false };
  }

  try {
    await fs.promises.unlink(filePath);
    return { deleted: true, alreadyMissing: false };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { deleted: true, alreadyMissing: true };
    }
    throw error;
  }
}

function appendConsumableUsageEvent(
  eventMode: 'print',
  transactionId: string,
  recoveryContext: Record<string, string | number | boolean | null>,
): void {
  try {
    const copies = typeof recoveryContext.copies === 'number' ? recoveryContext.copies : 1;
    const duplex = Boolean(recoveryContext.duplex);
    const selectedPages = typeof recoveryContext.selectedPages === 'number' ? recoveryContext.selectedPages : 1;
    const colorMode = recoveryContext.colorMode === 'colored' ? 'colored' : 'grayscale';
    const billableColorPages = typeof recoveryContext.billableColorPages === 'number'
      ? recoveryContext.billableColorPages
      : (colorMode === 'colored' ? selectedPages : 0);
    const billableBwPages = typeof recoveryContext.billableBwPages === 'number'
      ? recoveryContext.billableBwPages
      : (colorMode === 'colored' ? 0 : selectedPages);
    const estimatedSheetsUsed = typeof recoveryContext.estimatedSheetsUsed === 'number'
      ? recoveryContext.estimatedSheetsUsed
      : Math.max(1, copies) * Math.ceil(selectedPages / (duplex ? 2 : 1));

    const estimatedInkUnits = estimateInkUsageByJob({
      selectedColorPages: billableColorPages,
      selectedBwPages: billableBwPages,
      copies: Math.max(1, copies),
      printerName: null,
    });
    const isAdminTestPrint = recoveryContext.adminTestPrint === true;

    consumablesStore.appendUsageEvent({
      id: isAdminTestPrint
        ? `${ADMIN_TEST_PAGE_USAGE_SOURCE}:${transactionId}`
        : randomUUID(),
      timestamp: getTrustedTimestamp().timestamp,
      transactionId,
      mode: eventMode,
      copies: Math.max(1, copies),
      duplex,
      selectedPages,
      billableColorPages,
      billableBwPages,
      estimatedSheetsUsed,
      estimatedInkUnits,
      source: isAdminTestPrint
        ? ADMIN_TEST_PAGE_USAGE_SOURCE
        : 'worker-return-pipe',
      billingPageDetection: 'fallback-assumptions',
      analysisConfidence: 'unknown',
    });
  } catch (error) {
    console.error('[WORKER-LIFECYCLE] Failed to append consumable usage event.', {
      error: error instanceof Error ? error.message : String(error),
      transactionId,
    });
  }
}

async function cleanupSuccessfulPrint(input: {
  transactionId: string;
  sessionStore: SessionStore;
  recoveryContext: Record<string, string | number | boolean | null>;
}): Promise<void> {
  const { transactionId, sessionStore, recoveryContext } = input;

  appendConsumableUsageEvent('print', transactionId, recoveryContext);
  try {
    await evaluateConsumablesForecastAlerts();
  } catch (error) {
    console.error(
      '[WORKER-LIFECYCLE] Failed to evaluate consumables forecast alerts.',
      {
        error: error instanceof Error ? error.message : String(error),
        transactionId,
      },
    );
  }
  const filename =
    typeof recoveryContext.filename === 'string' ? recoveryContext.filename : null;
  const sessionId =
    typeof recoveryContext.sessionId === 'string'
      ? recoveryContext.sessionId
      : null;
  const documentId =
    typeof recoveryContext.documentId === 'string'
      ? recoveryContext.documentId
      : null;

  if (!filename) return;

  if (sessionId && documentId) {
    const removed = await sessionStore.removeDocument(sessionId, documentId);
    if (removed.success && removed.deletedFile) {
      return;
    }
  }

  await deleteUploadByStoredFilename(filename);
  await adminService.appendAdminLog(
    'upload_deleted_after_print',
    'Uploaded file deleted after worker-confirmed print completion.',
    {
      transactionId,
      sessionId,
      documentId,
      filename,
      source: 'worker-return-pipe',
    },
  );
}

async function cleanupSuccessfulCopy(input: {
  transactionId: string;
  recoveryContext: Record<string, string | number | boolean | null>;
}): Promise<void> {
  const previewFilename =
    typeof input.recoveryContext.previewFilename === 'string'
      ? input.recoveryContext.previewFilename
      : null;
  if (!previewFilename) return;

  await deleteTransientScanFile(previewFilename);
  await adminService.appendAdminLog(
    'copy_preview_released',
    'Transient copy preview released after worker-confirmed print completion.',
    {
      transactionId: input.transactionId,
      filename: previewFilename,
      source: 'worker-return-pipe',
    },
  );
}

async function createRefundReview(input: {
  transactionId: string;
  evt: WorkerPrintEvent;
  requiredAmount: number;
  mode: 'print' | 'copy';
}): Promise<void> {
  try {
    await upsertSpoolerFailureRefund({
      chargedAmount: input.requiredAmount,
      reason: input.evt.message ?? 'Worker reported terminal print failure.',
      autoRefund: false,
      jobContext: {
        transactionId: input.transactionId,
        mode: input.mode,
        spoolerCorrelationKey: input.evt.spoolerCorrelationKey,
        workerFailureStage: input.evt.failureStage ?? null,
      },
    });
  } catch (error) {
    if (
      error instanceof PendingRefundServiceError &&
      error.code === 'TRUSTED_TIME_UNAVAILABLE'
    ) {
      await adminService.appendAdminLog(
        'trusted_time_unsynced',
        'Worker print failure refund review could not be created because trusted time is unavailable.',
        {
          transactionId: input.transactionId,
          spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
          mode: input.mode,
        },
      );
      return;
    }
    throw error;
  }
}

export function handleWorkerReturnPrintEvent(input: {
  evt: WorkerPrintEvent;
  io: Server;
  sessionStore: SessionStore;
}): Promise<void> {
  const transactionId =
    typeof input.evt.transactionId === 'string'
      ? input.evt.transactionId.trim()
      : null;
  if (!transactionId) {
    return processWorkerReturnPrintEvent(input);
  }

  const priorEvent = workerEventChains.get(transactionId) ?? Promise.resolve();
  const currentEvent = priorEvent
    .catch(() => undefined)
    .then(() => processWorkerReturnPrintEvent(input));
  workerEventChains.set(transactionId, currentEvent);
  void currentEvent.then(
    () => {
      if (workerEventChains.get(transactionId) === currentEvent) {
        workerEventChains.delete(transactionId);
      }
    },
    () => {
      if (workerEventChains.get(transactionId) === currentEvent) {
        workerEventChains.delete(transactionId);
      }
    },
  );
  return currentEvent;
}

async function processWorkerReturnPrintEvent(input: {
  evt: WorkerPrintEvent;
  io: Server;
  sessionStore: SessionStore;
}): Promise<void> {
  const transactionId =
    typeof input.evt.transactionId === 'string' &&
    input.evt.transactionId.trim().length > 0
      ? input.evt.transactionId.trim()
      : null;
  if (!transactionId) return;

  const recovery = getRecoverySession(transactionId);
  const mode = recovery?.mode ?? 'print';
  const requiredAmount = recovery?.requiredAmount ?? 0;
  const recoveryContext = recovery?.context ?? {};

  if (input.evt.type === 'PrintStarted') {
    await persistAndEmitPrintLifecycleState(
      input.io,
      {
        mode,
        state: 'processing',
        transactionId,
        spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
        spoolerJobId: parseSpoolerJobId(input.evt.spoolerJobId),
        printerName: input.evt.printerName ?? null,
        reason: input.evt.message ?? null,
      },
      {
        requiredAmount,
        sessionId: recovery?.sessionId ?? null,
        documentId: recovery?.documentId ?? null,
      },
    );
    return;
  }

  if (input.evt.type === 'PrintProgress') {
    // Defensive guard: the worker already filters pagesPrinted <= 0, but a
    // corrupt payload (e.g. NaN) must not flip the lifecycle into a
    // "processing with no progress" state that the confirm page can't
    // render meaningfully.
    const pagesPrinted =
      typeof input.evt.pagesPrinted === 'number' &&
      Number.isFinite(input.evt.pagesPrinted)
        ? input.evt.pagesPrinted
        : null;
    if (pagesPrinted === null || pagesPrinted <= 0) {
      return;
    }
    const totalPages =
      typeof input.evt.totalPages === 'number' &&
      Number.isFinite(input.evt.totalPages) &&
      input.evt.totalPages > 0
        ? input.evt.totalPages
        : null;

    await persistAndEmitPrintLifecycleState(
      input.io,
      {
        mode,
        state: 'processing',
        transactionId,
        spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
        spoolerJobId: parseSpoolerJobId(input.evt.spoolerJobId),
        printerName: input.evt.printerName ?? null,
        pagesPrinted,
        totalPages: totalPages ?? undefined,
      },
      {
        requiredAmount,
        sessionId: recovery?.sessionId ?? null,
        documentId: recovery?.documentId ?? null,
      },
    );
    return;
  }

  if (
    input.evt.type === 'PrinterOffline' ||
    input.evt.type === 'PrinterOnline'
  ) {
    return;
  }

  if (input.evt.type === 'PrinterError') {
    terminalWorkerFailures.set(
      transactionId,
      input.evt.spoolerCorrelationKey ?? null,
    );
    await persistAndEmitPrintLifecycleState(
      input.io,
      {
        mode,
        state: 'failed',
        transactionId,
        spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
        spoolerJobId: parseSpoolerJobId(input.evt.spoolerJobId),
        printerName: input.evt.printerName ?? null,
        reason: input.evt.message ?? 'The printer reported a hardware error.',
        printError: {
          code: 'WORKER_HARDWARE_ERROR',
          severity: 'recoverable',
          userMessage:
            input.evt.message ?? 'The printer reported a hardware error.',
          hint:
            'Please call maintenance staff and provide the transaction ID below.',
          timestamp: new Date().toISOString(),
          canRetry: false,
          canDismiss: false,
        },
      },
      {
        requiredAmount,
        sessionId: recovery?.sessionId ?? null,
        documentId: recovery?.documentId ?? null,
        meta: {
          workerFailureStage: input.evt.failureStage ?? 'hardware_error',
        },
      },
    );
    return;
  }

  if (input.evt.type === 'JobPaused') {
    const errorText = input.evt.errorMessage ?? input.evt.message ?? '';
    const lower = errorText.toLowerCase();
    const isPaperOut =
      lower.includes('paper') ||
      lower.includes('no paper') ||
      lower.includes('out of paper');
    const isJam = lower.includes('jam');
    const isDoor = lower.includes('door') || lower.includes('cover');

    let errorCode = 'WORKER_HARDWARE_ERROR';
    let userMsg = errorText || 'Printer paused due to a hardware issue.';
    let hint = 'Please check the printer, then click Resume.';

    if (isPaperOut) {
      errorCode = 'PAPER_TRAY_EMPTY';
      userMsg = 'Printer Out of Paper. Please load paper and click Resume.';
      hint = 'Please load paper into the rear tray, then press Resume to retry.';
    } else if (isJam) {
      errorCode = 'PAPER_JAM_PRINT';
      userMsg = 'Paper jam detected in the printer.';
      hint = 'Please clear the jammed paper, then click Resume.';
    } else if (isDoor) {
      errorCode = 'PRINTER_DOOR_OPEN';
      userMsg = 'Printer door or cover is open.';
      hint = 'Please close all printer covers, then click Resume.';
    }

    const printError = {
      code: errorCode,
      severity: 'recoverable' as const,
      userMessage: userMsg,
      hint,
      timestamp: new Date().toISOString(),
      canRetry: true,
      canDismiss: false,
    };

    await persistAndEmitPrintLifecycleState(
      input.io,
      {
        mode,
        state: 'paused',
        transactionId,
        spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
        spoolerJobId: parseSpoolerJobId(input.evt.spoolerJobId),
        printerName: input.evt.printerName ?? null,
        reason: userMsg,
        pagesPrinted:
          typeof input.evt.pagesPrinted === 'number' &&
          Number.isFinite(input.evt.pagesPrinted)
            ? input.evt.pagesPrinted
            : undefined,
        totalPages:
          typeof input.evt.totalPages === 'number' &&
          Number.isFinite(input.evt.totalPages) &&
          input.evt.totalPages > 0
            ? input.evt.totalPages
            : undefined,
        printError,
      },
      {
        requiredAmount,
        sessionId: recovery?.sessionId ?? null,
        documentId: recovery?.documentId ?? null,
      },
    );
    return;
  }

  if (input.evt.type === 'JobResumed') {
    await persistAndEmitPrintLifecycleState(
      input.io,
      {
        mode,
        state: 'processing',
        transactionId,
        spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
        spoolerJobId: parseSpoolerJobId(input.evt.spoolerJobId),
        printerName: input.evt.printerName ?? null,
        reason: input.evt.message ?? 'Job resumed by worker',
        pagesPrinted:
          typeof input.evt.pagesPrinted === 'number' &&
          Number.isFinite(input.evt.pagesPrinted)
            ? input.evt.pagesPrinted
            : undefined,
        totalPages:
          typeof input.evt.totalPages === 'number' &&
          Number.isFinite(input.evt.totalPages) &&
          input.evt.totalPages > 0
            ? input.evt.totalPages
            : undefined,
      },
      {
        requiredAmount,
        sessionId: recovery?.sessionId ?? null,
        documentId: recovery?.documentId ?? null,
      },
    );
    return;
  }

  if (
    input.evt.type === 'PrintSucceeded' ||
    (input.evt.type === 'JobCompleted' && input.evt.outcome === 'completed')
  ) {
    if (
      hasTerminalWorkerFailure(
        transactionId,
        input.evt.spoolerCorrelationKey,
      )
    ) {
      console.warn(
        '[WORKER_RETURN_PIPE] Ignoring success after a terminal hardware failure.',
        {
          transactionId,
          spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
        },
      );
      return;
    }

    const recordedLifecycle = getSpoolerLifecycleRecord(transactionId, mode);
    const sameSpoolerJob =
      !recordedLifecycle?.spoolerCorrelationKey ||
      !input.evt.spoolerCorrelationKey ||
      recordedLifecycle.spoolerCorrelationKey ===
        input.evt.spoolerCorrelationKey;
    if (recordedLifecycle?.currentState === 'failed' && sameSpoolerJob) {
      console.warn(
        '[WORKER_RETURN_PIPE] Ignoring success after a terminal hardware failure.',
        {
          transactionId,
          spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
        },
      );
      return;
    }

    if (mode === 'copy') {
      jobStore.updateJobState(transactionId, 'printed');
    }

    await persistAndEmitPrintLifecycleState(
      input.io,
      {
        mode,
        state: 'printed',
        transactionId,
        spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
        spoolerJobId: parseSpoolerJobId(input.evt.spoolerJobId),
        printerName: input.evt.printerName ?? null,
        reason: input.evt.message ?? null,
      },
      {
        requiredAmount,
        sessionId: recovery?.sessionId ?? null,
        documentId: recovery?.documentId ?? null,
      },
    );

    receiptService.updateTerminalStatus({
      transactionId,
      status: 'printed',
      terminalAt: input.evt.timestampUtc,
    });

    await checkpointRecoverySession({
      transactionId,
      mode,
      phase: 'reconciled',
      requiredAmount,
      chargedAmount: recovery?.chargedAmount ?? requiredAmount,
      sessionId: recovery?.sessionId ?? null,
      documentId: recovery?.documentId ?? null,
      spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
      reconciledAt: input.evt.timestampUtc,
      spoolerTerminalAt: input.evt.timestampUtc,
      reconciliationAction: 'none',
      reconciliationReason: 'Worker confirmed successful print completion.',
    });

    if (mode === 'copy') {
      await cleanupSuccessfulCopy({
        transactionId,
        recoveryContext,
      });
    } else {
      await cleanupSuccessfulPrint({
        transactionId,
        sessionStore: input.sessionStore,
        recoveryContext,
      });
    }

    return;
  }

  if (mode === 'copy') {
    jobStore.updateJobState(transactionId, 'failed', {
      failure: {
        code: input.evt.failureStage ?? 'WORKER_PRINT_FAILED',
        message: input.evt.message ?? 'Worker print failed.',
        retryable: false,
        stage: 'postprocess',
      },
    });
  }

  const isHardwareError =
    input.evt.failureStage === 'HardwareError' ||
    input.evt.failureStage === 'IncompleteOutput';
  const printError = isHardwareError
    ? {
        code: 'PAPER_TRAY_EMPTY',
        severity: 'recoverable' as const,
        userMessage: input.evt.message ?? 'Printer Out of Paper. Please load paper and click Resume.',
        hint: 'Ask staff to load paper into the rear tray, then press Resume to retry.',
        timestamp: new Date().toISOString(),
        canRetry: true,
        canDismiss: false,
      }
    : null;

  terminalWorkerFailures.set(
    transactionId,
    input.evt.spoolerCorrelationKey ?? null,
  );

  await persistAndEmitPrintLifecycleState(
    input.io,
    {
      mode,
      state: 'failed',
      transactionId,
      spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
      spoolerJobId: parseSpoolerJobId(input.evt.spoolerJobId),
      printerName: input.evt.printerName ?? null,
      reason: input.evt.message ?? 'Worker print failed.',
      pagesPrinted:
        typeof input.evt.pagesPrinted === 'number' &&
        Number.isFinite(input.evt.pagesPrinted)
          ? input.evt.pagesPrinted
          : undefined,
      totalPages:
        typeof input.evt.totalPages === 'number' &&
        Number.isFinite(input.evt.totalPages) &&
        input.evt.totalPages > 0
          ? input.evt.totalPages
          : undefined,
      printError,
    },
    {
      requiredAmount,
      sessionId: recovery?.sessionId ?? null,
      documentId: recovery?.documentId ?? null,
      meta: {
        workerFailureStage: input.evt.failureStage ?? null,
      },
    },
  );

  await createRefundReview({
    transactionId,
    evt: input.evt,
    requiredAmount,
    mode,
  });

  receiptService.updateTerminalStatus({
    transactionId,
    status: 'refunded_pending_review',
    terminalAt: input.evt.timestampUtc,
  });

  await checkpointRecoverySession({
    transactionId,
    mode,
    phase: 'reconciled',
    requiredAmount,
    chargedAmount: recovery?.chargedAmount ?? requiredAmount,
    sessionId: recovery?.sessionId ?? null,
    documentId: recovery?.documentId ?? null,
    spoolerCorrelationKey: input.evt.spoolerCorrelationKey ?? null,
    reconciledAt: input.evt.timestampUtc,
    spoolerTerminalAt: input.evt.timestampUtc,
    reconciliationAction: 'pending_admin_review',
    reconciliationReason: input.evt.message ?? 'Worker reported terminal print failure.',
  });
}

export async function handleQueueWorkerTerminalFailure(input: {
  transactionId: string;
  spoolerCorrelationKey: string | null;
  failureReason: string;
  failureClass: string;
  io: Server;
}): Promise<void> {
  const recovery = getRecoverySession(input.transactionId);
  const mode = recovery?.mode ?? 'print';
  const requiredAmount = recovery?.requiredAmount ?? 0;

  if (mode === 'copy') {
    jobStore.updateJobState(input.transactionId, 'failed', {
      failure: {
        code: input.failureClass,
        message: input.failureReason,
        retryable: false,
        stage: 'postprocess',
      },
    });
  }

  await persistAndEmitPrintLifecycleState(
    input.io,
    {
      mode,
      state: 'failed',
      transactionId: input.transactionId,
      spoolerCorrelationKey: input.spoolerCorrelationKey,
      reason: input.failureReason,
    },
    {
      requiredAmount,
      sessionId: recovery?.sessionId ?? null,
      documentId: recovery?.documentId ?? null,
      meta: {
        queueFailureClass: input.failureClass,
      },
    },
  );

  await upsertSpoolerFailureRefund({
    chargedAmount: recovery?.chargedAmount ?? requiredAmount,
    reason: input.failureReason,
    autoRefund: true,
    jobContext: {
      transactionId: input.transactionId,
      spoolerCorrelationKey: input.spoolerCorrelationKey,
      queueFailureClass: input.failureClass,
      mode,
    },
  });

  receiptService.updateTerminalStatus({
    transactionId: input.transactionId,
    status: 'refunded',
    terminalAt: new Date().toISOString(),
  });

  await checkpointRecoverySession({
    transactionId: input.transactionId,
    mode,
    phase: 'reconciled',
    requiredAmount,
    chargedAmount: recovery?.chargedAmount ?? requiredAmount,
    sessionId: recovery?.sessionId ?? null,
    documentId: recovery?.documentId ?? null,
    spoolerCorrelationKey: input.spoolerCorrelationKey,
    reconciledAt: new Date().toISOString(),
    reconciliationAction: 'auto_refund',
    reconciliationReason: input.failureReason,
  });
}
