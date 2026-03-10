import { randomUUID } from 'node:crypto';
import {
  db,
  type FeedbackStatus,
  type FeedbackCategory,
  type FeedbackEntry,
  type FeedbackSessionEntry,
  type LogMeta,
} from './db';
import { adminService } from './admin';

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

interface SubmitFeedbackInput {
  sessionId: string;
  token: string;
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

    db.data!.feedbackSessions.unshift(session);
    await db.write();

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

    const session =
      db.data!.feedbackSessions.find((s) => s.token === normalizedToken) ??
      null;
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

    const session = db.data!.feedbackSessions.find(
      (s) => s.id === input.sessionId && s.token === input.token,
    );
    if (!session) throw new Error('Invalid session');
    if (this.isExpired(session.expiresAt))
      throw new Error('Session has expired');

    const entry: FeedbackEntry = {
      id: randomUUID(),
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      comment,
      category,
      rating,
      status: 'open',
      resolvedAt: null,
      meta: input.meta,
    };

    db.data!.feedback.unshift(entry);
    session.submittedAt = entry.timestamp;
    await db.write();

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

    const filtered =
      status == null
        ? db.data!.feedback
        : db.data!.feedback.filter((entry) => entry.status === status);

    const items = filtered.slice(offset, offset + limit);

    return {
      total: filtered.length,
      items,
    };
  }

  async toggleResolved(
    feedbackId: string,
    resolved: boolean,
  ): Promise<FeedbackEntry | null> {
    const entry = db.data!.feedback.find((f) => f.id === feedbackId) ?? null;
    if (!entry) return null;

    entry.status = resolved ? 'resolved' : 'open';
    entry.resolvedAt = resolved ? new Date().toISOString() : null;
    await db.write();

    await adminService.appendAdminLog(
      resolved ? 'feedback_resolved' : 'feedback_reopened',
      resolved ? 'Feedback marked as resolved' : 'Feedback reopened',
      { feedbackId: entry.id },
    );

    return entry;
  }

  async deleteFeedback(feedbackId: string): Promise<boolean> {
    const before = db.data!.feedback.length;
    db.data!.feedback = db.data!.feedback.filter((f) => f.id !== feedbackId);
    if (db.data!.feedback.length === before) return false;

    await db.write();

    await adminService.appendAdminLog(
      'feedback_deleted',
      'Feedback entry deleted by admin.',
      { feedbackId },
    );

    return true;
  }

  async clearFeedback(): Promise<number> {
    const removed = db.data!.feedback.length;
    if (removed === 0) return 0;

    db.data!.feedback = [];
    await db.write();

    await adminService.appendAdminLog(
      'feedback_cleared',
      'All feedback entries cleared',
      { removedCount: removed },
    );

    return removed;
  }

  listAllFeedback(): FeedbackEntry[] {
    return db.data!.feedback.slice();
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
    const nowMs = now.getTime();
    const retentionCutoff = nowMs - FEEDBACK_SESSION_RETENTION_MS;
    const before = db.data!.feedbackSessions.length;

    db.data!.feedbackSessions = db.data!.feedbackSessions.filter((session) => {
      const expiresAtMs = Date.parse(session.expiresAt);
      const createdAtMs = Date.parse(session.createdAt);

      if (!Number.isFinite(expiresAtMs)) return false;
      if (expiresAtMs >= nowMs) return true;

      if (!Number.isFinite(createdAtMs)) return false;
      return createdAtMs >= retentionCutoff;
    });

    if (db.data!.feedbackSessions.length !== before) {
      await db.write();
    }
  }

  private buildFeedbackUrl(publicBaseUrl: URL, token: string): string {
    const base = publicBaseUrl.toString().replace(/$/, '');
    return base + 'feedback/' + encodeURIComponent(token);
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