import { randomUUID } from 'node:crypto';
import type { PrintJobEnqueuePayload } from './print-job.schema';
import { PRINT_JOB_PAYLOAD_VERSION } from './print-job.schema';
import type { PrintJobOptions } from '@/services/printer';
import { getTrustedTimestamp } from '@/services/time-source';

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
      scaling: context.printOptions.scaling ?? 'fit',
      settings: {
        quality: context.printOptions.quality ?? 'standard',
        scaling: context.printOptions.scaling ?? 'fit',
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
