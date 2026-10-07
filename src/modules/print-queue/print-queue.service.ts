import {
  powerSafetyService,
  type PowerSafetyService,
} from '@/services/power-safety';
import { getJobProcessor } from '@/services/job-processor';
import type { PrintJobEnqueuePayload } from './print-job.schema';
import { PrintJobEnqueueError } from './print-queue.integration';

export interface EnqueuePrintJobOptions {
  powerSafetyService?: PowerSafetyService;
}

export async function enqueuePrintJob(
  payload: PrintJobEnqueuePayload,
  options?: EnqueuePrintJobOptions,
): Promise<string> {
  const safety = options?.powerSafetyService ?? powerSafetyService;
  if (!safety.canAcceptCustomerWork()) {
    throw new PrintJobEnqueueError(
      'POWER_EMERGENCY',
      'Power emergency active; customer work suspended',
      {
        transactionId: payload.correlation.transactionId,
        spoolerCorrelationKey: payload.correlation.spoolerCorrelationKey,
      },
    );
  }
  return getJobProcessor().enqueue(payload);
}
