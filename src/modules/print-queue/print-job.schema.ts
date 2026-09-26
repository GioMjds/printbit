/**
 * Print Queue Job Payload Schema
 *
 * Defines the structure of print jobs enqueued to the local JobProcessor with:
 * - Correlation tracking (transactionId, spoolerCorrelationKey)
 * - Versioning for backward compatibility
 * - Idempotency support (idempotencyKey)
 * - Print options and context
 *
 * Phase 1: Queue platform foundation
 */

import type { PageSelection } from '@/public/shared/page-selection';

/**
 * Payload version for schema migration/compatibility
 * Increment when adding required fields or changing behavior
 */
export const PRINT_JOB_PAYLOAD_VERSION = 1;

/**
 * Correlation keys for linking jobs across retries and failures
 * Enables idempotency and audit tracing
 */
export interface PrintJobCorrelation {
  /**
   * Unique transaction identifier from financial system
   * Links to ledger entries, receipts, and settlement records
   */
  transactionId: string;

  /**
   * Printer-local correlation key generated per dispatch attempt
   * Links to spooler monitor records and lifecycle state
   */
  spoolerCorrelationKey: string;

  /**
   * Idempotency key from HTTP request
   * Ensures duplicate enqueue requests map to same job outcome
   * Pattern: POST:/api/confirm-payment::{request-hash}
   */
  idempotencyKey: string;

  /**
   * Session that initiated the print (nullable for legacy flows)
   */
  sessionId: string | null;

  /**
   * Document/upload identifier (nullable for file-based copy mode)
   */
  documentId: string | null;
}

/**
 * Print job settings configuration
 */
export interface PrintJobSettings {
  quality?: 'standard' | 'high';
  copies?: number;
  colorMode?: 'colored' | 'grayscale';
  orientation?: 'portrait' | 'landscape';
  rotationDeg?: number;
  paperSize?: 'A4' | 'Short' | 'Long';
  duplex?: boolean;
  pageRange?: string | null;
  pageSelection?: PageSelection | null;
}

/**
 * Core print job request details
 * Mirrors PrintJobOptions from printer service
 */
export interface PrintJobRequest {
  /**
   * Mode: print from upload or copy from scanner
   */
  mode: 'print' | 'copy';

  /**
   * Number of copies
   */
  copies: number;

  /**
   * Color mode: colored or grayscale
   */
  colorMode: 'colored' | 'grayscale';

  /**
   * Paper orientation: portrait or landscape
   */
  orientation: 'portrait' | 'landscape';

  /**
   * Rotation in degrees (0, 90, 180, 270)
   */
  rotationDeg: number;

  /**
   * Paper size: A4, Short, Long
   */
  paperSize: 'A4' | 'Short' | 'Long';

  /**
   * Duplex (double-sided) printing
   */
  duplex: boolean;

  /**
   * Page range string (e.g., "1-5,7,9-")
   * null means all pages
   */
  pageRange: string | null;
  pageSelection?: PageSelection | null;

  /**
   * Server-side filename for the document
   * For print mode: points to uploaded file in uploads/
   * For copy mode: generated on-demand from scanner
   */
  serverFilename: string;

  /**
   * Printer name to target (e.g., "Default" or hardware name)
   */
  printerName: string | null;

  /**
   * Optional print quality setting
   */
  quality?: 'standard' | 'high';

  /**
   * Optional print settings container
   */
  settings?: PrintJobSettings;
}

/**
 * Financial context and payment details
 */
export interface PrintJobFinancialContext {
  /**
   * Amount required from balance (in smallest currency unit, e.g., piso cents)
   */
  requiredAmount: number;

  /**
   * Amount actually charged after settlement
   */
  chargedAmount?: number;

  /**
   * Consumed pages: breakdown of billable color/BW consumption
   */
  billedColorPages: number;
  billedBwPages: number;

  /**
   * Quote ID from print-quote service for traceability
   * Links to quote snapshot in admin/forensics
   */
  quoteId?: string;
}

/**
 * Printer and dispatch context
 */
export interface PrintJobDispatchContext {
  /**
   * Trusted timestamp when job enqueued (ISO8601)
   * Ensures timestamp-based ordering and financial safety
   */
  enqueuedAt: string;

  /**
   * Timestamp when job was dispatched to printer (set by worker)
   */
  jobDispatchedAt?: string;

  /**
   * Engine selected by print dispatcher (e.g., "ghostscript", "libreoffice", "pdftopdf")
   */
  dispatchEngine?: string;

  /**
   * Dispatch mode from result (e.g., "native", "converted")
   */
  dispatchMode?: string;

  /**
   * MIME type of document sent to printer
   */
  dispatchMimeType?: string;

  /**
   * Optional persisted counts of color and BW pages for this dispatch (nullable when unknown)
   */
  colorPages?: number | null;
  bwPages?: number | null;
}

/**
 * Attempt tracking for retries
 */
export interface PrintJobAttempt {
  /**
   * Attempt sequence number (1, 2, 3)
   */
  attemptNumber: number;

  /**
   * Timestamp of attempt (ISO8601)
   */
  timestamp: string;

  /**
   * Result: success, retryable_failure, non_retryable_failure, manual_review
   */
  result: 'success' | 'retryable_failure' | 'non_retryable_failure' | 'manual_review';

  /**
   * Failure classification if failed (null if success)
   */
  failureClass?: string;

  /**
   * Human-readable failure reason
   */
  failureReason?: string;

  /**
   * Engine used in this attempt (may differ per retry if printer state changed)
   */
  engine?: string;

  /**
   * Duration of attempt in milliseconds
   */
  durationMs?: number;
}

/**
 * Complete print job enqueue payload
 * Versioned for future schema evolution
 */
export interface PrintJobEnqueuePayload {
  /**
   * Schema version for migration/compatibility
   */
  schemaVersion: typeof PRINT_JOB_PAYLOAD_VERSION;

  /**
   * Correlation identifiers for tracing and idempotency
   */
  correlation: PrintJobCorrelation;

  /**
   * Print request details (options, filename, etc)
   */
  request: PrintJobRequest;

  /**
   * Financial context (required amount, billable pages)
   */
  financial: PrintJobFinancialContext;

  /**
   * Printer and dispatch context
   */
  dispatch: PrintJobDispatchContext;

  /**
   * Attempt history (populated after worker processing)
   * Not part of initial enqueue, but updated by worker
   */
  attempts?: PrintJobAttempt[];
}

/**
 * Job context passed through worker processing
 * Subset of payload used for Socket.IO emissions and logging
 */
export interface PrintJobContext {
  transactionId: string;
  mode: 'print' | 'copy';
  copies: number;
  colorMode: 'colored' | 'grayscale';
  spoolerCorrelationKey: string;
  sessionId: string | null;
  documentId: string | null;
  filename: string | null;
  dispatchEngine: string | null;
}

/**
 * Generic Print Job interface for local JobProcessor
 */
export interface PrintJob {
  id: string;
  data: PrintJobEnqueuePayload;
  attemptsMade: number;
}
