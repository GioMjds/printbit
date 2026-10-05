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

export interface PrintQueueJobStartedEvent {
  jobId: string | number;
  transactionId: string;
  attemptNumber: number;
  startedAt: string;
}

export interface PrintQueueJobRetryingEvent {
  jobId: string | number;
  transactionId: string;
  attemptNumber: number;
  nextAttemptIn: number;
  failureReason: string;
  failureClass: string;
  retryingAt: string;
}

export interface PrintQueueJobFailedEvent {
  jobId: string | number;
  transactionId: string;
  attemptNumber: number;
  failureReason: string;
  failureClass: string;
  isRetryable: boolean;
  failedAt: string;
}

export interface PrintQueueJobCompletedEvent {
  jobId: string | number;
  transactionId: string;
  spoolerCorrelationKey: string;
  stage: string;
  chargedAmount: number;
  durationMs: number;
  completedAt: string;
}

export interface ConsumableThresholdTriggeredEvent {
  printerName: string;
  supplyName: string | null;
  currentLevel: number;
  thresholdLevel: number;
  fingerprint: string;
  triggeredAt: string;
  action: 'alert' | 'block';
}

export interface ConsumableThresholdRecoveredEvent {
  printerName: string;
  supplyName: string | null;
  currentLevel: number;
  thresholdLevel: number;
  fingerprint: string;
  recoveredAt: string;
}

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

export interface PrintQueueStatsEvent {
  pending: number;
  active: number;
  completed: number;
  failed: number;
  statsUpdatedAt: string;
}

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
