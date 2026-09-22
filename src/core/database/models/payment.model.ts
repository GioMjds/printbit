import { LogMeta, TrustedTimestampMeta } from '../shared.schema';

export interface OwedChangeEntry {
  id: string;
  timestamp: string;
  timestampMeta?: TrustedTimestampMeta;
  amount: number;
  reason: string;
  status: 'open' | 'resolved';
  meta?: LogMeta;
}

export type FinancialEventType =
  | 'coin_inserted'
  | 'job_started'
  | 'job_completed'
  | 'refund_issued'
  | 'variance_alert';

export interface FinancialLedgerEntry {
  id: string;
  timestamp: string;
  timestampMeta: TrustedTimestampMeta;
  eventType: FinancialEventType;
  amount: number;
  referenceId: string | null;
  meta: LogMeta;
  previousHash: string | null;
  hash: string;
}

export interface PendingRefundEntry {
  id: string;
  timestamp: string;
  chargedAmount: number;
  reason: string;
  status: 'open' | 'refunded' | 'dismissed';
  closedAt: string | null;
  jobContext: Record<string, string | number | boolean | null>;
}
