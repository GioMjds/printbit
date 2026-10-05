export {
  PRINT_JOB_PAYLOAD_VERSION,
  type PrintJobCorrelation,
  type PrintJobRequest,
  type PrintJobSettings,
  type PrintJobFinancialContext,
  type PrintJobDispatchContext,
  type PrintJobAttempt,
  type PrintJobEnqueuePayload,
  type PrintJobContext,
  type PrintJob,
} from './print-job.schema';

export { getJobProcessor } from '@/services/job-processor';
export {
  enqueuePrintJob,
  type EnqueuePrintJobOptions,
} from './print-queue.service';

export {
  buildPrintJobEnqueuePayload,
  PrintJobEnqueueError,
} from './print-queue.integration';

export {
  orchestratePrintJob,
  WorkerOrchestrationError,
  recordJobAttempt,
  buildPrintJobContext,
  type PrintWorkerOrchestrationResult,
} from './print-queue.orchestration';

export {
  buildConsumptionFingerprint,
  buildThresholdFingerprint,
  isTerminalConsumptionOutcome,
  type PrintConsumptionEvent,
  type PerPrinterThresholdConfig,
  type ThresholdIncident,
} from './print-queue.consumption';

export {
  type PrintQueueJobQueuedEvent,
  type PrintQueueJobStartedEvent,
  type PrintQueueJobRetryingEvent,
  type PrintQueueJobFailedEvent,
  type PrintQueueJobCompletedEvent,
  type ConsumableThresholdTriggeredEvent,
  type ConsumableThresholdRecoveredEvent,
  type TransactionReceiptStatusChangedEvent,
  type PrintQueueStatsEvent,
  type PrintQueueStatusSnapshot,
  type PrintQueueSocketIOEvent,
} from './print-queue.socket-events';

export {
  type AdminQueueJobRecord,
  type AdminQueueAttemptRecord,
  type AdminTransactionSupervisionRecord,
  type AdminOperatorAction,
  type AdminQueueJobFilters,
  type AdminQueueJobQueryResult,
  type AdminQueueDashboardData,
} from './print-queue.admin-supervision';
