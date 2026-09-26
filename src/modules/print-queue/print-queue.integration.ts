/**
 * Print Queue Integration for Financial Service
 /**
  * Handles coordination between financial confirm-payment flow and local JobProcessor:

 * - Creates enqueue payload from print request
 * - Manages transaction-to-job correlation
 * - Handles idempotency verification
 * - Bridges existing financial context with queue job
 *
 * Phase 2: Workerized print pipeline integration
 */

import { randomUUID } from 'node:crypto';
import type { PrintJobEnqueuePayload } from './print-job.schema';
import { PRINT_JOB_PAYLOAD_VERSION } from './print-job.schema';
import type { PrintJobOptions } from '@/services/printer';
import { getTrustedTimestamp } from '@/services/time-source';

/**
 * Build print job enqueue payload from confirm-payment context
 *
 * @param context Financial confirm-payment request context
 * @returns Complete PrintJobEnqueuePayload ready for queue
 */
export function buildPrintJobEnqueuePayload(context: {
  transactionId: string;
  idempotencyKey: string;
  mode: 'print' | 'copy';
  sessionId: string | null;
  documentId: string | null;
  serverFilename: string;
  printOptions: PrintJobOptions;
  requiredAmount: number;
  billedColorPages: number;
  billedBwPages: number;
  printerName: string | null;
  spoolerCorrelationKey?: string | null;
}): PrintJobEnqueuePayload {
  // Generate new spooler correlation key for this enqueue
  const spoolerCorrelationKey =
    typeof context.spoolerCorrelationKey === 'string' &&
    context.spoolerCorrelationKey.trim().length > 0
      ? context.spoolerCorrelationKey.trim()
      : randomUUID();

  const payload: PrintJobEnqueuePayload = {
    schemaVersion: PRINT_JOB_PAYLOAD_VERSION,
    correlation: {
      transactionId: context.transactionId,
      spoolerCorrelationKey,
      idempotencyKey: context.idempotencyKey,
      sessionId: context.sessionId,
      documentId: context.documentId,
    },
    request: {
      mode: context.mode,
      copies: context.printOptions.copies,
      colorMode: context.printOptions.colorMode,
      orientation: context.printOptions.orientation,
      rotationDeg: context.printOptions.rotationDeg ?? 0,
      paperSize: context.printOptions.paperSize,
      duplex: context.printOptions.duplex ?? false,
      pageRange: (context.printOptions.pageRange as string | null) ?? null,
      pageSelection: context.printOptions.pageSelection ?? null,
      serverFilename: context.serverFilename,
      printerName: context.printerName,
      quality: context.printOptions.quality ?? 'standard',
      settings: {
        quality: context.printOptions.quality ?? 'standard',
      },
    },
    financial: {
      requiredAmount: context.requiredAmount,
      billedColorPages: context.billedColorPages,
      billedBwPages: context.billedBwPages,
    },
    dispatch: {
      enqueuedAt: getTrustedTimestamp().timestamp,
    },
  };

  return payload;
}

/**
 * Error class for print job enqueue operations
 */
export class PrintJobEnqueueError extends Error {
  constructor(
    public code: string,
    message: string,
    public context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PrintJobEnqueueError';
  }
}
