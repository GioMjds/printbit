export interface AdminQueueJobRecord {
  jobId: string | number;
  transactionId: string;
  spoolerCorrelationKey: string;
  mode: 'print' | 'copy';
  state: 'pending' | 'active' | 'failed' | 'completed' | 'stalled';
  attemptsMade: number;
  failureReason?: string;
  failureClass?: string;
  isRetryable?: boolean;
  enqueuedAt: string;
  lastAttemptAt?: string;
}

export interface AdminQueueAttemptRecord {
  attemptNumber: number;
  timestamp: string;
  result:
    | 'success'
    | 'retryable_failure'
    | 'non_retryable_failure'
    | 'manual_review';
  failureReason?: string;
  failureClass?: string;
  engine?: string;
  durationMs?: number;
}

export interface AdminTransactionSupervisionRecord {
  transactionId: string;
  financial: {
    mode: 'print' | 'copy';
    requiredAmount: number;
    chargedAmount: number;
    balance: number;
    ledgerEntries: number;
  };
  queue: {
    jobId: string | number;
    state: 'pending' | 'active' | 'failed' | 'completed' | 'stalled';
    attemptsMade: number;
    lastFailure?: string;
  };
  receipt: {
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
  };
  printLifecycle?: {
    currentState: 'queued' | 'processing' | 'printed' | 'failed' | null;
    reason?: string;
    dispatchedAt?: string;
    completedAt?: string;
  };
  timeline: {
    timestamp: string;
    event:
      | 'transaction_created'
      | 'job_enqueued'
      | 'job_started'
      | 'job_failed'
      | 'job_completed'
      | 'receipt_generated'
      | 'receipt_printed'
      | 'change_dispensed';
    details: Record<string, unknown>;
  }[];
}

export interface AdminOperatorAction {
  id: string;
  transactionId: string;
  action: 'retry_job' | 'mark_resolved' | 'attach_note';
  operatorId: string;
  performedAt: string;
  details: Record<string, unknown>;
  note?: string;
  result: 'success' | 'failed' | 'pending';
  resultError?: string;
}

export interface AdminQueueJobFilters {
  state?: 'pending' | 'active' | 'failed' | 'completed' | 'stalled';
  printerName?: string;
  failureClass?: string;
  minAttempts?: number;
  timeRange?: {
    start: string;
    end: string;
  };
  transactionId?: string;
  limit?: number;
  offset?: number;
}

export interface AdminQueueJobQueryResult {
  jobs: AdminQueueJobRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminQueueDashboardData {
  queueDepth: {
    pending: number;
    active: number;
    failed: number;
  };
  recentFailures: {
    transactionId: string;
    failureClass: string;
    attemptNumber: number;
    timestamp: string;
  }[];
  topFailureReasons: {
    reason: string;
    count: number;
    failureClass: string;
  }[];
  retrySuccessRate: number;
  avgCompletionTimeMs: number;
}
