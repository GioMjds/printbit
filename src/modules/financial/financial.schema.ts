/**
 * Financial module schemas and types.
 */
import type { LogMeta, TrustedTimestampMeta } from '@/core/database/shared.schema';

export type { LogMeta, TrustedTimestampMeta };

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
  payoutType?: 'cash' | 'balance' | null;
  jobContext: Record<string, string | number | boolean | null>;
}
