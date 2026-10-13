import { randomUUID } from 'node:crypto';
import {
  type FeedbackStatus,
  type FeedbackCategory,
  type FeedbackEntry,
  type FeedbackSessionEntry,
  type LogMeta,
} from './db';
import { adminService } from './admin';
import { feedbackStore } from '@/core/database/sqlite-storage';

const FEEDBACK_SESSION_TTL_MS = 15 * 60 * 1000;
const FEEDBACK_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_COMMENT_LENGTH = 1200;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 1000;

interface CreateSessionResult {
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
  meta?: LogMeta;
}

interface ListFeedbackOptions {
  status?: FeedbackStatus;
  limit?: number;
  offset?: number;
}

interface ListFeedbackResult {
  total: number;
  items: FeedbackEntry[];
}

class FeedbackService {
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
      status: 'open',
      resolvedAt: null,
      needsAction: false,
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
    const limit = this.clampLimit(options.limit);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    return feedbackStore.listFeedback({ status, limit, offset });
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

export const feedbackService = new FeedbackService();
