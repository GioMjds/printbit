/**
 * Print Queue Orchestration - Phase 2 Implementation Framework
 *
 * 5-stage print job execution pipeline with service integration:
 * 1. Preflight: Printer state, ink policy, document validation
 * 2. Dispatch: Send to printer, capture result
 * 3. Settlement: Process payment and change dispensing
 * 4. Spooler: Monitor job lifecycle until terminal state
 * 5. Reconciliation: Generate receipt and emit completion
 *
 * Phase 2: Service integration ready for development
 * All stage helpers prepared; service calls marked with TODO
 *
 * Service Integration Dependencies:
 * - @/services: getPrinterTelemetry, evaluateInkPreflight, printFile, etc.
 * - @/services/print-spooler: monitorSpoolerJob
 * - @/services/settlement: settlementService
 * - @/modules/receipt/receipt.service: receiptService instance
 * - @/services/print-dispatcher: PrintDispatchError, print dispatch types
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type { Server } from 'socket.io';
import type { PrintJob } from './print-job.schema';
import { PrinterService } from '@/modules/printer/printer.service';
import {
  UPLOAD_DIR,
  WORKER_PIPE_NAME,
  WORKER_PRECHECKS_ENABLED,
  WORKER_QUEUE_DIR,
} from '@/config';
import { handoffToWorker, WorkerHandoffError } from '@/infrastructure/worker';
import {
  buildWorkerErrorPayload,
  sendWorkerError,
} from '@/infrastructure/worker';
import { powerSafetyService } from '@/services/power-safety';

/**
 * Result of orchestration execution
 */
export interface PrintWorkerOrchestrationResult {
  success: boolean;
  transactionId: string;
  spoolerCorrelationKey: string;
  stage: string;
  durationMs: number;
  chargedAmount: number;
  failureClass?: string;
  failureReason?: string;
}

/**
 * Error class for worker orchestration with retry classification
 */
export class WorkerOrchestrationError extends Error {
  constructor(
    public failureClass: string,
    public isRetryable: boolean,
    public stage: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkerOrchestrationError';
    Error.captureStackTrace(this, WorkerOrchestrationError);
  }
}

/**
 * Build context for logging and Socket.IO emissions
 */
export function buildPrintJobContext(job: PrintJob): {
  transactionId: string;
  spoolerCorrelationKey: string;
  jobId: string | number;
  mode: 'print' | 'copy';
  printerName: string;
} {
  return {
    transactionId: job.data.correlation.transactionId,
    spoolerCorrelationKey: job.data.correlation.spoolerCorrelationKey,
    jobId: job.id ?? 'unknown',
    mode: job.data.request.mode,
    printerName: job.data.request.printerName ?? 'default',
  };
}

/**
 * Record attempt in job history for diagnostics
 */
export function recordJobAttempt(
  job: PrintJob,
  attemptNumber: number,
  result: 'success' | 'retryable_failure' | 'non_retryable_failure',
  failureClass?: string,
  failureReason?: string,
  durationMs?: number,
): void {
  const now = new Date().toISOString();

  if (!job.data.attempts) {
    job.data.attempts = [];
  }

  job.data.attempts.push({
    attemptNumber,
    timestamp: now,
    result,
    failureClass,
    failureReason,
    durationMs,
  });
}

/**
 * Orchestrate print job through 5-stage pipeline
 *
 * Phase 2 Implementation Roadmap:
 *
 * Stage 1 - Preflight (validation):
 * TODO: Call getPrinterTelemetry() to verify printer online
 * TODO: Call evaluateInkPreflight() to verify ink levels
 * TODO: Validate document file exists and is accessible
 * TODO: Verify required amount vs balance
 * TODO: Emit printQueueJobStarted event
 *
 * Stage 2 - Dispatch (send to printer):
 * TODO: Call printFile(filePath, options, context)
 * TODO: Handle PrintDispatchError with failure classification
 * TODO: Capture PrintDispatchResult (engine, duration, success)
 * TODO: Call checkpointRecoverySession() with dispatch checkpoint
 * TODO: Emit printQueueJobDispatched event
 *
 * Stage 3 - Settlement (payment processing):
 * TODO: Call settlementService.settle(requiredAmount)
 * TODO: Verify settlement.ok === true
 * TODO: Capture chargedAmount from settlement
 * TODO: Handle insufficient balance (non-retryable)
 * TODO: Call checkpointRecoverySession() with settled checkpoint
 * TODO: Emit transactionSettled event
 *
 * Stage 4 - Spooler (monitor print completion):
 * TODO: Call monitorSpoolerJob() with spooler correlation key
 * TODO: Poll until terminal state (completed/failed/error)
 * TODO: Handle timeout (retryable) vs permanent failures
 * TODO: Call checkpointRecoverySession() with print_confirmed
 * TODO: Emit printQueueJobPrinted event
 *
 * Stage 5 - Reconciliation (generate receipt):
 * TODO: Call receiptService to generate receipt snapshot
 * TODO: Emit printQueueJobCompleted event
 * TODO: Emit transactionReceiptStatusChanged event
 * TODO: Return success with final status
 *
 * Error Handling:
 * - Retryable failures: Dispatch errors, spooler timeouts, settlement locks
 * - Non-retryable: Missing printer, unsupported capabilities, insufficient balance
 * - Unknown errors: Wrapped as retryable by default
 *
 * Socket.IO Events:
 * - printQueueJobStarted: Preflight passed, execution starting
 * - printQueueJobDispatched: Print engine successfully dispatched
 * - transactionSettled: Payment processed
 * - printQueueJobPrinted: Print confirmed by spooler
 * - printQueueJobCompleted: Receipt generated, transaction complete
 * - printQueueJobFailed: Job failed with failure class and retryability
 */
export async function orchestratePrintJob(
  job: PrintJob,
  io: Server,
): Promise<PrintWorkerOrchestrationResult> {
  const startTime = Date.now();
  const ctx = buildPrintJobContext(job);
  let currentStage = 'initialization';
  const chargedAmount = job.data.financial.chargedAmount ?? 0;
  const printerService = new PrinterService();
  const uploadPath = path.resolve(UPLOAD_DIR, job.data.request.serverFilename);

  try {
    // =========================================================================
    // STAGE 1: PREFLIGHT VALIDATION
    // =========================================================================
    currentStage = 'preflight';

    if (WORKER_PRECHECKS_ENABLED) {
      const preflightError = await printerService.preDispatchCheck(
        ctx.printerName,
      );
      if (preflightError) {
        throw new WorkerOrchestrationError(
          preflightError.code,
          preflightError.severity !== 'fatal',
          'preflight',
          preflightError.userMessage,
          { hint: preflightError.hint ?? null },
        );
      }
    }

    try {
      await fs.access(uploadPath);
    } catch {
      throw new WorkerOrchestrationError(
        'FILE_NOT_FOUND',
        false,
        'preflight',
        'Print file not found',
        { path: uploadPath },
      );
    }

    io.emit('printQueueJobStarted', {
      jobId: job.id,
      transactionId: ctx.transactionId,
      stage: 'preflight',
      startedAt: new Date().toISOString(),
    });

    // Also emit the legacy event that the confirm page expects for immediate feedback
    io.emit('workerPrintStarted', {
      transactionId: ctx.transactionId,
      spoolerCorrelationKey: ctx.spoolerCorrelationKey,
      timestampUtc: new Date().toISOString(),
    });

    // =========================================================================
    // STAGE 3: HANDOFF TO C# WORKER
    // =========================================================================
    currentStage = 'handoff';

    if (!powerSafetyService.canAcceptCustomerWork()) {
      throw new WorkerOrchestrationError(
        'POWER_EMERGENCY',
        false,
        'handoff',
        'Power emergency active; worker handoff blocked',
      );
    }

    if (!WORKER_QUEUE_DIR) {
      throw new WorkerOrchestrationError(
        'WORKER_QUEUE_DIR_NOT_SET',
        false,
        'handoff',
        'PRINTBIT_WORKER_QUEUE_DIR environment variable is not set',
      );
    }

    const handoffResult = await handoffToWorker({
      sourcePath: uploadPath,
      queueDir: WORKER_QUEUE_DIR,
      transactionId: ctx.transactionId,
      spoolerCorrelationKey: ctx.spoolerCorrelationKey,
      printSettings: {
        copies: job.data.request.copies,
        color: job.data.request.colorMode === 'colored',
        pageRange: job.data.request.pageRange,
        orientation: job.data.request.orientation,
        rotationDeg: job.data.request.rotationDeg,
        paperSize: job.data.request.paperSize,
        duplex: job.data.request.duplex ?? false,
        quality: job.data.request.settings?.quality ?? job.data.request.quality ?? 'standard',
      },
    });

    job.data.dispatch.jobDispatchedAt = new Date().toISOString();
    job.data.dispatch.dispatchEngine = 'csharp-worker';
    job.data.dispatch.dispatchMode = 'queue-handoff';
    job.data.dispatch.dispatchMimeType = 'application/pdf';

    io.emit('printQueueJobDispatched', {
      jobId: job.id,
      transactionId: ctx.transactionId,
      stage: 'handoff',
      fileName: handoffResult.fileName,
      dispatchedAt: job.data.dispatch.jobDispatchedAt,
    });

    return {
      success: true,
      transactionId: ctx.transactionId,
      spoolerCorrelationKey: ctx.spoolerCorrelationKey,
      stage: 'handoff',
      durationMs: Date.now() - startTime,
      chargedAmount,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;

    let failureClass: string;
    let isRetryable: boolean;
    let failureReason: string;

    if (err instanceof WorkerHandoffError) {
      failureClass = err.code;
      isRetryable = false;
      failureReason = err.message;
    } else if (err instanceof WorkerOrchestrationError) {
      failureClass = err.failureClass;
      isRetryable = err.isRetryable;
      failureReason = err.message;
    } else {
      failureClass = 'UNKNOWN_ERROR';
      isRetryable = false;
      failureReason = err instanceof Error ? err.message : String(err);
    }

    await sendWorkerError(
      buildWorkerErrorPayload({
        message: `Print job failed at ${currentStage}: ${failureReason}`,
        code: failureClass,
        source: 'print-queue-worker',
        transactionId: ctx.transactionId,
        spoolerCorrelationKey: ctx.spoolerCorrelationKey,
        stack: err instanceof Error ? err.stack : undefined,
      }),
      WORKER_PIPE_NAME,
    );

    recordJobAttempt(
      job,
      job.attemptsMade,
      isRetryable ? 'retryable_failure' : 'non_retryable_failure',
      failureClass,
      failureReason,
      durationMs,
    );

    io.emit('printQueueJobFailed', {
      jobId: job.id,
      transactionId: ctx.transactionId,
      attemptNumber: job.attemptsMade,
      stage: currentStage,
      failureReason,
      failureClass,
      isRetryable,
      failedAt: new Date().toISOString(),
    });

    if (isRetryable) {
      throw new Error(`${failureClass}: ${failureReason}`, { cause: err });
    }

    throw new Error(`NON_RETRYABLE - ${failureClass}: ${failureReason}`, { cause: err });
  }
}
