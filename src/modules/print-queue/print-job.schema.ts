import type { PageSelection } from '@/public/shared/page-selection';
import type { PrintScaling } from '@/shared/print-configuration';

export const PRINT_JOB_PAYLOAD_VERSION = 1;

export interface PrintJobCorrelation {
  transactionId: string;
  spoolerCorrelationKey: string;
  idempotencyKey: string;
  sessionId: string | null;
  documentId: string | null;
}

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
  scaling?: PrintScaling;
}

export interface PrintJobRequest {
  mode: 'print' | 'copy';
  copies: number;
  colorMode: 'colored' | 'grayscale';
  orientation: 'portrait' | 'landscape';
  rotationDeg: number;
  paperSize: 'A4' | 'Short' | 'Long';
  duplex: boolean;
  pageRange: string | null;
  pageSelection?: PageSelection | null;
  serverFilename: string;
  printerName: string | null;
  quality?: 'standard' | 'high';
  scaling?: PrintScaling;
  settings?: PrintJobSettings;
}

export interface PrintJobFinancialContext {
  requiredAmount: number;
  chargedAmount?: number;
  billedColorPages: number;
  billedBwPages: number;
  quoteId?: string;
}

export interface PrintJobDispatchContext {
  enqueuedAt: string;
  jobDispatchedAt?: string;
  dispatchEngine?: string;
  dispatchMode?: string;
  dispatchMimeType?: string;
  colorPages?: number | null;
  bwPages?: number | null;
}

export interface PrintJobAttempt {
  attemptNumber: number;
  timestamp: string;
  result: 'success' | 'retryable_failure' | 'non_retryable_failure' | 'manual_review';
  failureClass?: string;
  failureReason?: string;
  engine?: string;
  durationMs?: number;
}

export interface PrintJobEnqueuePayload {
  schemaVersion: typeof PRINT_JOB_PAYLOAD_VERSION;
  correlation: PrintJobCorrelation;
  request: PrintJobRequest;
  financial: PrintJobFinancialContext;
  dispatch: PrintJobDispatchContext;
  attempts?: PrintJobAttempt[];
}

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

export interface PrintJob {
  id: string;
  data: PrintJobEnqueuePayload;
  attemptsMade: number;
}
