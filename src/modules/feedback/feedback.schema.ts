/**
 * Feedback module schemas and types.
 */
import type { LogMeta } from '@/core/database/shared.schema';

export type { LogMeta };

export type FeedbackCategory =
  | 'service'
  | 'hardware'
  | 'software'
  | 'print'
  | 'scan'
  | 'copy'
  | 'payment'
  | 'other';

export type FeedbackStatus =
  | 'new'
  | 'reviewed'
  | 'archived'
  | 'open'
  | 'resolved';

export type AdminQueueView = 'active' | 'archived' | 'all';

export interface FeedbackEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  comment: string;
  category: FeedbackCategory | null;
  rating: number | null;
  status: FeedbackStatus;
  resolvedAt?: string | null;
  transactionRef?: string | null;
  needsAction: boolean;
  archivedAt?: string | null;
  meta?: LogMeta;
}

export interface FeedbackSessionEntry {
  id: string;
  token: string;
  feedbackUrl: string;
  createdAt: string;
  expiresAt: string;
  submittedAt: string | null;
}
