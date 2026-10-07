import { randomUUID } from 'node:crypto';
import { getSqliteDb, withTransaction } from '../sqlite-storage';

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
  meta?: Record<string, string | number | boolean | null>;
}

export interface CreateFeedbackInput {
  id?: string;
  sessionId?: string;
  timestamp?: string;
  comment: string;
  category?: FeedbackCategory | null;
  rating?: number | null;
  status?: FeedbackStatus;
  resolvedAt?: string | null;
  transactionRef?: string | null;
  needsAction?: boolean;
  archivedAt?: string | null;
  meta?: Record<string, string | number | boolean | null>;
}

export interface FeedbackSessionEntry {
  id: string;
  token: string;
  feedbackUrl: string;
  createdAt: string;
  expiresAt: string;
  submittedAt: string | null;
}

export type ListFeedbackOptions = {
  status?: FeedbackEntry['status'];
  view?: AdminQueueView;
  limit: number;
  offset: number;
};

function parseJsonValue<T>(value: unknown): T | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function normalizeLogMeta(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean' ||
      entry === null
    ) {
      out[key] = entry;
    }
  }
  return out;
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function toIsoDate(value: Date): string {
  return value.toISOString();
}

export class FeedbackSqliteStore {
  createSession(entry: FeedbackSessionEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT INTO feedback_sessions (
          id,
          token,
          feedback_url,
          created_at,
          expires_at,
          submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.token,
        entry.feedbackUrl,
        entry.createdAt,
        entry.expiresAt,
        entry.submittedAt,
      );
  }

  getSessionByToken(token: string): FeedbackSessionEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          id,
          token,
          feedback_url,
          created_at,
          expires_at,
          submitted_at
         FROM feedback_sessions
         WHERE token = ?
         LIMIT 1`,
      )
      .get(token) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toSessionEntry(row);
  }

  findSessionByIdAndToken(
    sessionId: string,
    token: string,
  ): FeedbackSessionEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          id,
          token,
          feedback_url,
          created_at,
          expires_at,
          submitted_at
         FROM feedback_sessions
         WHERE id = ? AND token = ?
         LIMIT 1`,
      )
      .get(sessionId, token) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toSessionEntry(row);
  }

  insertFeedback(entry: FeedbackEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT INTO feedback_entries (
          id,
          session_id,
          timestamp,
          comment,
          category,
          rating,
          status,
          resolved_at,
          meta_json,
          transaction_ref,
          needs_action,
          archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.sessionId,
        entry.timestamp,
        entry.comment,
        entry.category ?? null,
        entry.rating ?? null,
        entry.status ?? 'new',
        entry.resolvedAt ?? null,
        jsonOrNull(entry.meta),
        entry.transactionRef ?? null,
        entry.needsAction ? 1 : 0,
        entry.archivedAt ?? null,
      );
  }

  createFeedback(input: CreateFeedbackInput): FeedbackEntry {
    const entry: FeedbackEntry = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId ?? '',
      timestamp: input.timestamp ?? toIsoDate(new Date()),
      comment: input.comment,
      category: input.category ?? null,
      rating: input.rating ?? null,
      status: input.status ?? 'new',
      resolvedAt: input.resolvedAt ?? null,
      transactionRef: input.transactionRef ?? null,
      needsAction: Boolean(input.needsAction),
      archivedAt: input.archivedAt ?? null,
      meta: input.meta,
    };
    this.insertFeedback(entry);
    return entry;
  }

  createFeedbackSubmission(entry: FeedbackEntry): void {
    withTransaction(() => {
      const changes = this.markSessionSubmitted(entry.sessionId, entry.timestamp);
      if (changes !== 1) {
        throw new Error('Feedback session already submitted or does not exist.');
      }
      this.insertFeedback(entry);
    });
  }

  markSessionSubmitted(sessionId: string, submittedAt: string): number {
    const result = getSqliteDb()
      .prepare(
        'UPDATE feedback_sessions SET submitted_at = ? WHERE id = ? AND submitted_at IS NULL',
      )
      .run(submittedAt, sessionId) as { changes?: unknown };
    return Number(result.changes ?? 0);
  }

  listFeedback(options: ListFeedbackOptions): {
    total: number;
    items: FeedbackEntry[];
  } {
    const db = getSqliteDb();
    const limit = Math.max(1, Math.floor(options.limit));
    const offset = Math.max(0, Math.floor(options.offset));

    const where: string[] = [];
    const params: (string | number)[] = [];

    const view = options.view ?? (options.status ? undefined : 'active');

    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    } else if (view === 'active') {
      where.push("status IN ('new', 'open', 'reviewed')");
    } else if (view === 'archived') {
      where.push("status = 'archived'");
    }
    // view === 'all': no status filter

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS total FROM feedback_entries ${whereSql}`)
      .get(...params) as { total?: unknown };
    const rows = db
      .prepare(
        `SELECT
          id,
          session_id,
          timestamp,
          comment,
          category,
          rating,
          status,
          resolved_at,
          meta_json,
          transaction_ref,
          needs_action,
          archived_at
         FROM feedback_entries
         ${whereSql}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];

    return {
      total: Number(totalRow.total ?? 0),
      items: rows.map((row) => this.toFeedbackEntry(row)),
    };
  }

  countOpen(): number {
    const db = getSqliteDb();
    const row = db
      .prepare(
        "SELECT COUNT(*) AS total FROM feedback_entries WHERE status IN ('new', 'open')",
      )
      .get() as { total?: unknown };
    return Number(row?.total ?? 0);
  }

  getFeedbackStats(): {
    total: number;
    open: number;
    resolved: number;
    new: number;
    reviewed: number;
    archived: number;
  } {
    const db = getSqliteDb();
    const rows = db
      .prepare(
        'SELECT status, COUNT(*) AS count FROM feedback_entries GROUP BY status',
      )
      .all() as { status?: unknown; count?: unknown }[];
    let newCount = 0;
    let openCount = 0;
    let reviewedCount = 0;
    let resolvedCount = 0;
    let archivedCount = 0;
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      if (row.status === 'new') newCount += count;
      else if (row.status === 'open') openCount += count;
      else if (row.status === 'reviewed') reviewedCount += count;
      else if (row.status === 'resolved') resolvedCount += count;
      else if (row.status === 'archived') archivedCount += count;
    }
    const combinedOpen = newCount + openCount;
    const combinedResolved = reviewedCount + resolvedCount;
    return {
      total: combinedOpen + combinedResolved + archivedCount,
      open: combinedOpen,
      resolved: combinedResolved,
      new: newCount,
      reviewed: reviewedCount,
      archived: archivedCount,
    };
  }

  findFeedbackById(feedbackId: string): FeedbackEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          id,
          session_id,
          timestamp,
          comment,
          category,
          rating,
          status,
          resolved_at,
          meta_json,
          transaction_ref,
          needs_action,
          archived_at
         FROM feedback_entries
         WHERE id = ?
         LIMIT 1`,
      )
      .get(feedbackId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toFeedbackEntry(row);
  }

  updateFeedbackResolved(
    feedbackId: string,
    resolved: boolean,
  ): FeedbackEntry | null {
    const resolvedAt = resolved ? toIsoDate(new Date()) : null;
    const status: FeedbackEntry['status'] = resolved ? 'reviewed' : 'new';

    const result = getSqliteDb()
      .prepare(
        'UPDATE feedback_entries SET status = ?, resolved_at = ? WHERE id = ?',
      )
      .run(status, resolvedAt, feedbackId) as { changes?: unknown };
    if (Number(result.changes ?? 0) === 0) return null;
    return this.findFeedbackById(feedbackId);
  }

  archiveFeedback(id: string): FeedbackEntry | null {
    const nowIso = toIsoDate(new Date());
    const result = getSqliteDb()
      .prepare(
        "UPDATE feedback_entries SET status = 'archived', archived_at = ? WHERE id = ?",
      )
      .run(nowIso, id) as { changes?: unknown };
    if (Number(result.changes ?? 0) === 0) return null;
    return this.findFeedbackById(id);
  }

  archiveAllReviewedFeedback(): number {
    const nowIso = toIsoDate(new Date());
    const result = getSqliteDb()
      .prepare(
        "UPDATE feedback_entries SET status = 'archived', archived_at = ? WHERE status = 'reviewed'",
      )
      .run(nowIso) as { changes?: unknown };
    return Number(result.changes ?? 0);
  }

  setNeedsAction(id: string, needsAction: boolean): FeedbackEntry | null {
    const result = getSqliteDb()
      .prepare('UPDATE feedback_entries SET needs_action = ? WHERE id = ?')
      .run(needsAction ? 1 : 0, id) as { changes?: unknown };
    if (Number(result.changes ?? 0) === 0) return null;
    return this.findFeedbackById(id);
  }

  purgeFeedback(id: string, confirm: string): boolean {
    if (confirm !== 'PURGE') {
      throw new Error(
        'Typed confirmation PURGE required for permanent deletion.',
      );
    }
    const result = getSqliteDb()
      .prepare('DELETE FROM feedback_entries WHERE id = ?')
      .run(id) as { changes?: unknown };
    return Number(result.changes ?? 0) > 0;
  }

  purgeAllFeedback(confirm: string): number {
    if (confirm !== 'PURGE') {
      throw new Error(
        'Typed confirmation PURGE required for permanent deletion.',
      );
    }
    const result = getSqliteDb()
      .prepare('DELETE FROM feedback_entries')
      .run() as { changes?: unknown };
    return Number(result.changes ?? 0);
  }

  deleteFeedback(feedbackId: string): boolean {
    const result = getSqliteDb()
      .prepare('DELETE FROM feedback_entries WHERE id = ?')
      .run(feedbackId) as { changes?: unknown };
    return Number(result.changes ?? 0) > 0;
  }

  clearFeedback(): number {
    const result = getSqliteDb()
      .prepare('DELETE FROM feedback_entries')
      .run() as { changes?: unknown };
    return Number(result.changes ?? 0);
  }

  listAllFeedback(): FeedbackEntry[] {
    const rows = getSqliteDb()
      .prepare(
        `SELECT
          id,
          session_id,
          timestamp,
          comment,
          category,
          rating,
          status,
          resolved_at,
          meta_json,
          transaction_ref,
          needs_action,
          archived_at
         FROM feedback_entries
         ORDER BY timestamp DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.toFeedbackEntry(row));
  }

  cleanupExpiredSessions(now: Date, retentionMs: number): boolean {
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const retentionCutoff = nowMs - retentionMs;

    const invalidExpiresStmt = getSqliteDb().prepare(
      `DELETE FROM feedback_sessions 
       WHERE expires_at IS NULL OR expires_at = ''`,
    );
    const invalidExpiresResult = invalidExpiresStmt.run();

    const expiredStmt = getSqliteDb().prepare(
      `DELETE FROM feedback_sessions 
       WHERE expires_at < ?
         AND (created_at IS NULL OR created_at = '' OR created_at < ?)`,
    );
    const expiredResult = expiredStmt.run(
      nowIso,
      new Date(retentionCutoff).toISOString(),
    );

    const totalChanges =
      Number(invalidExpiresResult.changes) + Number(expiredResult.changes);
    return totalChanges > 0;
  }

  private toSessionEntry(row: Record<string, unknown>): FeedbackSessionEntry {
    return {
      id: String(row.id ?? ''),
      token: String(row.token ?? ''),
      feedbackUrl: String(row.feedback_url ?? ''),
      createdAt: String(row.created_at ?? ''),
      expiresAt: String(row.expires_at ?? ''),
      submittedAt:
        typeof row.submitted_at === 'string' ? row.submitted_at : null,
    };
  }

  private toFeedbackEntry(row: Record<string, unknown>): FeedbackEntry {
    return mapFeedbackEntry(row);
  }
}

export function mapFeedbackEntry(row: Record<string, unknown>): FeedbackEntry {
  const parsedMeta = normalizeLogMeta(parseJsonValue<unknown>(row.meta_json));
  const validCategories = new Set<string>([
    'service',
    'hardware',
    'software',
    'print',
    'scan',
    'copy',
    'payment',
    'other',
  ]);
  const categoryRaw = typeof row.category === 'string' ? row.category : null;
  const categoryValue =
    categoryRaw && validCategories.has(categoryRaw)
      ? (categoryRaw as FeedbackCategory)
      : null;
  const ratingValue =
    typeof row.rating === 'number' && Number.isFinite(row.rating)
      ? row.rating
      : null;
  const validStatuses = new Set<string>([
    'new',
    'reviewed',
    'archived',
    'open',
    'resolved',
  ]);
  const statusRaw = typeof row.status === 'string' ? row.status : '';
  const statusValue = validStatuses.has(statusRaw)
    ? (statusRaw as FeedbackStatus)
    : 'new';

  return {
    id: String(row.id ?? ''),
    sessionId: String(row.session_id ?? ''),
    timestamp: String(row.timestamp ?? ''),
    comment: String(row.comment ?? ''),
    category: categoryValue,
    rating: ratingValue,
    status: statusValue,
    resolvedAt: typeof row.resolved_at === 'string' ? row.resolved_at : null,
    transactionRef:
      typeof row.transaction_ref === 'string' ? row.transaction_ref : null,
    needsAction: Boolean(row.needs_action),
    archivedAt:
      typeof row.archived_at === 'string' ? row.archived_at : null,
    meta: parsedMeta,
  };
}

export const feedbackStore = new FeedbackSqliteStore();

export function createFeedback(input: CreateFeedbackInput): FeedbackEntry {
  return feedbackStore.createFeedback(input);
}

export function archiveFeedback(id: string): FeedbackEntry | null {
  return feedbackStore.archiveFeedback(id);
}

export function archiveAllReviewedFeedback(): number {
  return feedbackStore.archiveAllReviewedFeedback();
}

export function setNeedsAction(
  id: string,
  needsAction: boolean,
): FeedbackEntry | null {
  return feedbackStore.setNeedsAction(id, needsAction);
}

export function purgeFeedback(id: string, confirm: string): boolean {
  return feedbackStore.purgeFeedback(id, confirm);
}

export function purgeAllFeedback(confirm: string): number {
  return feedbackStore.purgeAllFeedback(confirm);
}
