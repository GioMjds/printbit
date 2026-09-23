/**
 * Print Queue Admin Supervision APIs
 *
 * Admin operator surfaces for:
 * - Queue job tracking with filtering and search
 * - Attempt history diagnostics
 * - Transaction ledger, receipt, and print lifecycle linking
 * - Manual operator actions with immutable audit logs
 *
 * Phase 5: Admin supervision expansion (tracking, transactions, receipts)
 */

/**
 * Queue job record for admin supervision view
 */
export interface AdminQueueJobRecord {
  /**
   * Job processor ID
   */
  jobId: string | number;

  /**
   * Transaction ID from financial system
   */
  transactionId: string;

  /**
   * Printer correlation key
   */
  spoolerCorrelationKey: string;

  /**
   * Print mode
   */
  mode: 'print' | 'copy';

  /**
   * Current job state in queue
   */
  state: 'pending' | 'active' | 'failed' | 'completed' | 'stalled';

  /**
   * Number of attempts made
   */
  attemptsMade: number;

  /**
   * Current failure reason if in failed state
   */
  failureReason?: string;

  /**
   * Failure classification
   */
  failureClass?: string;

  /**
   * Is failure retryable
   */
  isRetryable?: boolean;

  /**
   * When job was enqueued
   */
  enqueuedAt: string;

  /**
   * When job was last attempted
   */
  lastAttemptAt?: string;
}

/**
 * Queue attempt record for diagnostics
 */
export interface AdminQueueAttemptRecord {
  /**
   * Attempt sequence number
   */
  attemptNumber: number;

  /**
   * Timestamp of attempt
   */
  timestamp: string;

  /**
   * Attempt outcome
   */
  result:
    | 'success'
    | 'retryable_failure'
    | 'non_retryable_failure'
    | 'manual_review';

  /**
   * Failure reason if not success
   */
  failureReason?: string;

  /**
   * Failure classification
   */
  failureClass?: string;

  /**
   * Engine used (ghostscript, libreoffice, pdftopdf, etc)
   */
  engine?: string;

  /**
   * Duration in milliseconds
   */
  durationMs?: number;
}

/**
 * Unified transaction supervision record
 * Links queue job, financial ledger, receipt, and print lifecycle
 */
export interface AdminTransactionSupervisionRecord {
  /**
   * Transaction ID
   */
  transactionId: string;

  /**
   * Financial state
   */
  financial: {
    mode: 'print' | 'copy';
    requiredAmount: number;
    chargedAmount: number;
    balance: number;
    ledgerEntries: number; // count of events in ledger
  };

  /**
   * Queue state
   */
  queue: {
    jobId: string | number;
    state: 'pending' | 'active' | 'failed' | 'completed' | 'stalled';
    attemptsMade: number;
    lastFailure?: string;
  };

  /**
   * Receipt state
   */
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

  /**
   * Print lifecycle if print mode
   */
  printLifecycle?: {
    currentState: 'queued' | 'processing' | 'printed' | 'failed' | null;
    reason?: string;
    dispatchedAt?: string;
    completedAt?: string;
  };

  /**
   * Timeline of all events
   */
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

/**
 * Manual operator action record
 * Immutable audit log with operator ID
 */
export interface AdminOperatorAction {
  /**
   * Unique action ID
   */
  id: string;

  /**
   * Target transaction ID
   */
  transactionId: string;

  /**
   * Action type
   */
  action: 'retry_job' | 'mark_resolved' | 'attach_note';

  /**
   * Operator user ID
   */
  operatorId: string;

  /**
   * When action performed
   */
  performedAt: string;

  /**
   * Action details (job ID for retry, resolution code, etc)
   */
  details: Record<string, unknown>;

  /**
   * Optional note for refund/review context
   */
  note?: string;

  /**
   * Result of action
   */
  result: 'success' | 'failed' | 'pending';

  /**
   * Error message if failed
   */
  resultError?: string;
}

/**
 * Admin query filters for queue jobs
 */
export interface AdminQueueJobFilters {
  /**
   * Filter by job state
   */
  state?: 'pending' | 'active' | 'failed' | 'completed' | 'stalled';

  /**
   * Filter by printer name
   */
  printerName?: string;

  /**
   * Filter by failure class
   */
  failureClass?: string;

  /**
   * Filter by attempt count (e.g., >= 2 for retries)
   */
  minAttempts?: number;

  /**
   * Filter by time range
   */
  timeRange?: {
    start: string; // ISO8601
    end: string; // ISO8601
  };

  /**
   * Filter by transaction ID (search)
   */
  transactionId?: string;

  /**
   * Pagination
   */
  limit?: number;
  offset?: number;
}

/**
 * Admin query response for queue jobs
 */
export interface AdminQueueJobQueryResult {
  jobs: AdminQueueJobRecord[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Admin dashboard widget data
 */
export interface AdminQueueDashboardData {
  /**
   * Queue depth snapshot
   */
  queueDepth: {
    pending: number;
    active: number;
    failed: number;
  };

  /**
   * Recent failures (last 24h)
   */
  recentFailures: {
    transactionId: string;
    failureClass: string;
    attemptNumber: number;
    timestamp: string;
  }[];

  /**
   * Top failure reasons (last 7 days)
   */
  topFailureReasons: {
    reason: string;
    count: number;
    failureClass: string;
  }[];

  /**
   * Retry success rate (last 7 days)
   */
  retrySuccessRate: number; // percentage

  /**
   * Average time to completion
   */
  avgCompletionTimeMs: number;
}
