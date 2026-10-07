/**
 * Report module schemas and types.
 */
import type { LogMeta } from '@/core/database/shared.schema';

export type { LogMeta };

export type ReportIssueCategory =
  | 'hardware'
  | 'software'
  | 'print'
  | 'copy'
  | 'scan'
  | 'payment'
  | 'network'
  | 'other';

export type ReportIssueStatus = 'open' | 'acknowledged' | 'resolved';

export {
  type ReportResolutionReason,
  REPORT_RESOLUTION_REASONS,
  isReportResolutionReason,
} from '@/core/database/models/report-issue.model';

export type AdminQueueView = 'active' | 'archived' | 'all';

export interface ReportIssueSessionEntry {
  id: string;
  token: string;
  reportUrl: string;
  createdAt: string;
  expiresAt: string;
  submittedAt: string | null;
}

export interface ReportIssueAttachmentEntry {
  id: string;
  sessionId: string;
  reportIssueId: string | null;
  timestamp: string;
  originalName: string;
  storedName: string;
  contentType: string;
  sizeBytes: number;
  filePath: string;
}

export interface ReportIssueEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  title: string;
  description: string;
  category: ReportIssueCategory;
  status: ReportIssueStatus;
  attachmentIds: string[];
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  transactionRef?: string | null;
  resolutionReason?: import('@/core/database/models/report-issue.model').ReportResolutionReason | null;
  resolutionNote?: string | null;
  meta?: LogMeta;
}
