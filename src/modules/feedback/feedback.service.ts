import { randomUUID } from 'node:crypto';
import { adminService } from '@/services/admin';
import { feedbackStore } from '@/core/database/sqlite-storage';
import type {
  FeedbackStatus,
  AdminQueueView,
  FeedbackCategory,
  FeedbackEntry,
  FeedbackSessionEntry,
  LogMeta,
} from './feedback.schema';

const FEEDBACK_SESSION_TTL_MS = 15 * 60 * 1000;
const FEEDBACK_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_COMMENT_LENGTH = 1200;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 1000;

export interface CreateSessionResult {
  sessionId: string;
  token: string;
  feedbackUrl: string;
  expiresAt: string;
}

export interface SubmitFeedbackInput {
  sessionId?: string;
  token?: string;
  comment: string;
  category?: string | null;
  rating?: number | null;
  transactionRef?: string | null;
  meta?: LogMeta;
}

export interface ListFeedbackOptions {
  status?: FeedbackStatus;
  view?: AdminQueueView;
  limit?: number;
  offset?: number;
}

export interface ListFeedbackResult {
  total: number;
  items: FeedbackEntry[];
}

export class FeedbackService {
  async createSession(publicBaseUrl: URL): Promise<CreateSessionResult> {
    await this.cleanupExpiredSessions();

    const token = randomUUID();
    const sessionId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + FEEDBACK_SESSION_TTL_MS);
    const feedbackUrl = this.buildFeedbackUrl(publicBaseUrl, token);

    const session: FeedbackSessionEntry = {
      id: sessionId,
      token,
      feedbackUrl,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      submittedAt: null,
    };

    feedbackStore.createSession(session);

    return {
      sessionId,
      token,
      feedbackUrl,
      expiresAt: session.expiresAt,
    };
  }

  async getSessionByToken(token: string): Promise<FeedbackSessionEntry | null> {
    await this.cleanupExpiredSessions();

    const normalizedToken = token.trim();
    if (!normalizedToken) return null;

    const session = feedbackStore.getSessionByToken(normalizedToken);
    if (!session) return null;
    if (this.isExpired(session.expiresAt)) return null;

    return session;
  }

  async submitFeedback(input: SubmitFeedbackInput): Promise<FeedbackEntry> {
    await this.cleanupExpiredSessions();

    const comment = this.sanitizeComment(input.comment);
    if (!comment) throw new Error('Comment is required');

    const category = this.normalizeCategory(input.category);
    const rating = this.normalizeRating(input.rating);

    let sessionId = input.sessionId;
    if (input.sessionId && input.token) {
      const session = feedbackStore.findSessionByIdAndToken(
        input.sessionId,
        input.token,
      );
      if (!session) throw new Error('Invalid session');
      if (this.isExpired(session.expiresAt))
        throw new Error('Session has expired');
      sessionId = session.id;
    } else {
      sessionId = sessionId || 'direct';
    }

    const entry: FeedbackEntry = {
      id: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      comment,
      category,
      rating,
      status: 'new',
      resolvedAt: null,
      transactionRef: input.transactionRef ?? null,
      needsAction: false,
      archivedAt: null,
      meta: input.meta,
    };

    if (input.sessionId && input.token) {
      feedbackStore.createFeedbackSubmission(entry);
    } else {
      feedbackStore.insertFeedback(entry);
    }

    await adminService.appendAdminLog(
      'feedback_submitted',
      'User feedback submitted',
      {
        feedbackId: entry.id,
        sessionId: entry.sessionId,
        category: entry.category,
        rating: entry.rating,
      },
    );

    return entry;
  }

  listFeedback(options: ListFeedbackOptions = {}): ListFeedbackResult {
    const status = options.status;
    const view = options.view;
    const limit = this.clampLimit(options.limit);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    return feedbackStore.listFeedback({ status, view, limit, offset });
  }

  async toggleResolved(
    feedbackId: string,
    resolved: boolean,
  ): Promise<FeedbackEntry | null> {
    const entry = feedbackStore.updateFeedbackResolved(feedbackId, resolved);
    if (!entry) return null;

    await adminService.appendAdminLog(
      resolved ? 'feedback_resolved' : 'feedback_reopened',
      resolved ? 'Feedback marked as resolved' : 'Feedback reopened',
      { feedbackId: entry.id },
    );

    return entry;
  }

  archiveFeedback(id: string): FeedbackEntry | null {
    const entry = feedbackStore.archiveFeedback(id);
    if (entry) {
      void adminService.appendAdminLog(
        'feedback_archived',
        'Feedback entry archived by admin.',
        { feedbackId: id },
      );
    }
    return entry;
  }

  archiveAllReviewedFeedback(): number {
    const count = feedbackStore.archiveAllReviewedFeedback();
    if (count > 0) {
      void adminService.appendAdminLog(
        'feedback_archived_all_reviewed',
        'All reviewed feedback entries archived',
        { count },
      );
    }
    return count;
  }

  setNeedsAction(id: string, needsAction: boolean): FeedbackEntry | null {
    const entry = feedbackStore.setNeedsAction(id, needsAction);
    if (entry) {
      void adminService.appendAdminLog(
        'feedback_needs_action_updated',
        `Feedback needsAction updated to ${needsAction}`,
        { feedbackId: id, needsAction },
      );
    }
    return entry;
  }

  purgeFeedback(id: string, confirm: string): boolean {
    const purged = feedbackStore.purgeFeedback(id, confirm);
    if (purged) {
      void adminService.appendAdminLog(
        'feedback_purged',
        'Feedback entry permanently purged.',
        { feedbackId: id },
      );
    }
    return purged;
  }

  purgeAllFeedback(confirm: string): number {
    const count = feedbackStore.purgeAllFeedback(confirm);
    if (count > 0) {
      void adminService.appendAdminLog(
        'feedback_purged_all',
        'All feedback entries permanently purged.',
        { count },
      );
    }
    return count;
  }

  findFeedbackById(id: string): FeedbackEntry | null {
    return feedbackStore.findFeedbackById(id);
  }

  updateFeedbackStatus(
    id: string,
    status: FeedbackStatus,
  ): FeedbackEntry | null {
    if (status === 'reviewed') {
      const entry = feedbackStore.updateFeedbackResolved(id, true);
      if (entry) {
        void adminService.appendAdminLog(
          'feedback_resolved',
          'Feedback marked as resolved',
          { feedbackId: id },
        );
      }
      return entry;
    }
    if (status === 'new' || status === 'open') {
      const entry = feedbackStore.updateFeedbackResolved(id, false);
      if (entry) {
        void adminService.appendAdminLog(
          'feedback_reopened',
          'Feedback reopened',
          { feedbackId: id },
        );
      }
      return entry;
    }
    if (status === 'archived') {
      return this.archiveFeedback(id);
    }
    return feedbackStore.findFeedbackById(id);
  }

  async deleteFeedback(feedbackId: string): Promise<boolean> {
    const deleted = feedbackStore.deleteFeedback(feedbackId);
    if (!deleted) return false;

    await adminService.appendAdminLog(
      'feedback_deleted',
      'Feedback entry deleted by admin.',
      { feedbackId },
    );

    return true;
  }

  async clearFeedback(): Promise<number> {
    const removed = feedbackStore.clearFeedback();
    if (removed === 0) return 0;

    await adminService.appendAdminLog(
      'feedback_cleared',
      'All feedback entries cleared',
      { removedCount: removed },
    );

    return removed;
  }

  listAllFeedback(): FeedbackEntry[] {
    return feedbackStore.listAllFeedback();
  }

  feedbackToCsv(entries: FeedbackEntry[]): string {
    const escapeCsv = (value: unknown): string => {
      const text = value === null ? '' : String(value);
      const escaped = text.replace(/"/g, '""');
      return `"${escaped}"`;
    };

    const header = [
      'timestamp',
      'status',
      'category',
      'rating',
      'comment',
      'id',
      'sessionId',
      'resolvedAt',
      'meta',
    ].join(',');

    const rows = entries.map((entry) => {
      const metaText = entry.meta ? JSON.stringify(entry.meta) : '';
      return [
        escapeCsv(entry.timestamp),
        escapeCsv(entry.status),
        escapeCsv(entry.category),
        escapeCsv(entry.rating),
        escapeCsv(entry.comment),
        escapeCsv(entry.id),
        escapeCsv(entry.sessionId),
        escapeCsv(entry.resolvedAt),
        escapeCsv(metaText),
      ].join(',');
    });

    return [header, ...rows].join('\n');
  }

  async cleanupExpiredSessions(now = new Date()): Promise<void> {
    feedbackStore.cleanupExpiredSessions(now, FEEDBACK_SESSION_RETENTION_MS);
  }

  private buildFeedbackUrl(publicBaseUrl: URL, token: string): string {
    return new URL(
      `/feedback/${encodeURIComponent(token)}`,
      publicBaseUrl,
    ).toString();
  }

  private sanitizeComment(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';

    if (trimmed.length <= MAX_COMMENT_LENGTH) return trimmed;

    return trimmed.slice(0, MAX_COMMENT_LENGTH);
  }

  private normalizeCategory(input?: string | null): FeedbackCategory | null {
    if (typeof input !== 'string') return null;
    const normalized = input.trim().toLowerCase();
    if (!normalized) return null;

    if (
      normalized === 'service' ||
      normalized === 'hardware' ||
      normalized === 'software' ||
      normalized === 'print' ||
      normalized === 'copy' ||
      normalized === 'scan' ||
      normalized === 'payment' ||
      normalized === 'other'
    ) {
      return normalized;
    }

    return 'other';
  }

  private normalizeRating(input?: number | null): number | null {
    if (typeof input !== 'number' || !Number.isFinite(input)) return null;

    const rounded = Math.round(input);
    if (rounded < 1 || rounded > 5) return null;
    return rounded;
  }

  private clampLimit(limit?: number): number {
    const number = Math.floor(limit ?? DEFAULT_LIST_LIMIT);
    if (number < 1) return 1;
    if (number > MAX_LIST_LIMIT) return MAX_LIST_LIMIT;
    return number;
  }

  private isExpired(expiresAtIso: string): boolean {
    const expiresAtMs = Date.parse(expiresAtIso);
    if (!Number.isFinite(expiresAtMs)) return true;
    return Date.now() > expiresAtMs;
  }
}
