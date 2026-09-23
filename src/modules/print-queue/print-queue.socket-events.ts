/**
 * Print Queue Socket.IO Events
 *
 * Standardized real-time event contracts for print queue, threshold, and transaction state changes:
 * - Queue lifecycle events (queued, started, retrying, failed, completed)
 * - Threshold trigger/recovery events
 * - Transaction and receipt status updates
 * - Prevents duplicate incident noise on retries
 *
 * Phase 4: Real-time operations dashboard via Socket.IO
 */

/**
 * Socket.IO event: Print job enqueued
 * Emitted when job added to queue
 */
export interface PrintQueueJobQueuedEvent {
  jobId: string | number;
  transactionId: string;
  spoolerCorrelationKey: string;
  mode: 'print' | 'copy';
  copies: number;
  colorMode: 'colored' | 'grayscale';
  requiredAmount: number;
  enqueuedAt: string;
  queueDepth: number;
}

/**
 * Socket.IO event: Print job started processing
 * Emitted when worker picks up job
 */
export interface PrintQueueJobStartedEvent {
  jobId: string | number;
  transactionId: string;
  attemptNumber: number;
  startedAt: string;
}

/**
 * Socket.IO event: Print job retrying after failure
 * Emitted when job failed but will retry
 */
export interface PrintQueueJobRetryingEvent {
  jobId: string | number;
  transactionId: string;
  attemptNumber: number;
  nextAttemptIn: number; // milliseconds
  failureReason: string;
  failureClass: string;
  retryingAt: string;
}

/**
 * Socket.IO event: Print job failed permanently
 * Emitted when job exhausted retries or hit non-retryable error
 */
export interface PrintQueueJobFailedEvent {
  jobId: string | number;
  transactionId: string;
  attemptNumber: number;
  failureReason: string;
  failureClass: string;
  isRetryable: boolean;
  failedAt: string;
}

/**
 * Socket.IO event: Print job completed successfully
 * Emitted when job terminal success path
 */
export interface PrintQueueJobCompletedEvent {
  jobId: string | number;
  transactionId: string;
  spoolerCorrelationKey: string;
  stage: string;
  chargedAmount: number;
  durationMs: number;
  completedAt: string;
}

/**
 * Socket.IO event: Consumable threshold triggered
 * Emitted when ink/toner/paper level crosses below threshold
 * Idempotent fingerprint prevents duplicate events on retries
 */
export interface ConsumableThresholdTriggeredEvent {
  printerName: string;
  supplyName: string | null; // null for paper
  currentLevel: number; // percentage
  thresholdLevel: number; // percentage
  fingerprint: string; // idempotency key
  triggeredAt: string;
  action: 'alert' | 'block'; // block if 0% or critical
}

/**
 * Socket.IO event: Consumable threshold recovered
 * Emitted when ink/toner/paper level crosses back above threshold
 * Idempotent fingerprint prevents duplicate events on retries
 */
export interface ConsumableThresholdRecoveredEvent {
  printerName: string;
  supplyName: string | null;
  currentLevel: number; // percentage
  thresholdLevel: number; // percentage
  fingerprint: string; // idempotency key
  recoveredAt: string;
}

/**
 * Socket.IO event: Transaction receipt status changed
 * Emitted when receipt transitions states (pending, printed, etc)
 */
export interface TransactionReceiptStatusChangedEvent {
  transactionId: string;
  mode: 'print' | 'copy';
  status:
    | 'pending'
    | 'settled_pending_terminal'
    | 'printed'
    | 'failed'
    | 'pending_refund';
  chargedAmount: number;
  change: {
    requested: number;
    dispensed: number;
    state: 'none' | 'dispensing' | 'dispensed' | 'failed';
  };
  statusChangedAt: string;
}

/**
 * Socket.IO event: Queue statistics snapshot
 * Emitted periodically for dashboard
 */
export interface PrintQueueStatsEvent {
  pending: number;
  active: number;
  completed: number;
  failed: number;
  statsUpdatedAt: string;
}

/**
 * Consolidated print queue status for admin dashboard
 * Combines multiple event streams into single view
 */
export interface PrintQueueStatusSnapshot {
  generatedAt: string;
  queueStats: PrintQueueStatsEvent;
  activeJobs: {
    jobId: string | number;
    transactionId: string;
    attemptNumber: number;
    stage: string;
    startedAt: string;
  }[];
  recentFailures: {
    jobId: string | number;
    transactionId: string;
    failureReason: string;
    failureClass: string;
    failedAt: string;
    isRetryable: boolean;
  }[];
  recentCompleted: {
    jobId: string | number;
    transactionId: string;
    durationMs: number;
    completedAt: string;
  }[];
  activeThresholdIncidents: {
    printerName: string;
    supplyName: string | null;
    currentLevel: number;
    thresholdLevel: number;
    triggeredAt: string;
  }[];
}

/**
 * Type for all print queue Socket.IO events
 */
export type PrintQueueSocketIOEvent =
  | { event: 'printQueueJobQueued'; data: PrintQueueJobQueuedEvent }
  | { event: 'printQueueJobStarted'; data: PrintQueueJobStartedEvent }
  | { event: 'printQueueJobRetrying'; data: PrintQueueJobRetryingEvent }
  | { event: 'printQueueJobFailed'; data: PrintQueueJobFailedEvent }
  | { event: 'printQueueJobCompleted'; data: PrintQueueJobCompletedEvent }
  | {
      event: 'consumableThresholdTriggered';
      data: ConsumableThresholdTriggeredEvent;
    }
  | {
      event: 'consumableThresholdRecovered';
      data: ConsumableThresholdRecoveredEvent;
    }
  | {
      event: 'transactionReceiptStatusChanged';
      data: TransactionReceiptStatusChangedEvent;
    }
  | { event: 'printQueueStats'; data: PrintQueueStatsEvent };
