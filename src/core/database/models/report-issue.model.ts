import { getSqliteDb, withTransaction } from '../sqlite-storage';

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

export type ReportResolutionReason =
  | 'refunded'
  | 'reprinted'
  | 'hardware_fix'
  | 'no_fault_found'
  | 'duplicate'
  | 'user_error'
  | 'other';

export const REPORT_RESOLUTION_REASONS: readonly ReportResolutionReason[] = [
  'refunded',
  'reprinted',
  'hardware_fix',
  'no_fault_found',
  'duplicate',
  'user_error',
  'other',
] as const;

export function isReportResolutionReason(
  value: unknown,
): value is ReportResolutionReason {
  return (
    typeof value === 'string' &&
    REPORT_RESOLUTION_REASONS.includes(value as ReportResolutionReason)
  );
}

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
  resolutionReason?: ReportResolutionReason | null;
  resolutionNote?: string | null;
  meta?: Record<string, string | number | boolean | null>;
}

export type ListReportIssueOptions = {
  status?: ReportIssueStatus;
  category?: ReportIssueCategory;
  view?: AdminQueueView;
  limit: number;
  offset: number;
};

type ReportSessionCleanupResult = {
  changed: boolean;
  orphanedAttachments: ReportIssueAttachmentEntry[];
};

function parseJsonValue<T>(value: unknown): T | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function normalizeLogMeta(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
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

function dateMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export class ReportIssueSqliteStore {
  createSession(entry: ReportIssueSessionEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT INTO report_issue_sessions (
          id,
          token,
          report_url,
          created_at,
          expires_at,
          submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.token,
        entry.reportUrl,
        entry.createdAt,
        entry.expiresAt,
        entry.submittedAt,
      );
  }

  getSessionByToken(token: string): ReportIssueSessionEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          id,
          token,
          report_url,
          created_at,
          expires_at,
          submitted_at
         FROM report_issue_sessions
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
  ): ReportIssueSessionEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          id,
          token,
          report_url,
          created_at,
          expires_at,
          submitted_at
         FROM report_issue_sessions
         WHERE id = ? AND token = ?
         LIMIT 1`,
      )
      .get(sessionId, token) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toSessionEntry(row);
  }

  countSessionAttachments(sessionId: string): number {
    const row = getSqliteDb()
      .prepare(
        'SELECT COUNT(*) AS total FROM report_issue_attachments WHERE session_id = ?',
      )
      .get(sessionId) as { total?: unknown };
    return Number(row.total ?? 0);
  }

  registerAttachment(entry: ReportIssueAttachmentEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT INTO report_issue_attachments (
          id,
          session_id,
          report_issue_id,
          timestamp,
          original_name,
          stored_name,
          content_type,
          size_bytes,
          file_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.sessionId,
        entry.reportIssueId,
        entry.timestamp,
        entry.originalName,
        entry.storedName,
        entry.contentType,
        entry.sizeBytes,
        entry.filePath,
      );
  }

  listUnlinkedSessionAttachments(
    sessionId: string,
  ): ReportIssueAttachmentEntry[] {
    const rows = getSqliteDb()
      .prepare(
        `SELECT
          id,
          session_id,
          report_issue_id,
          timestamp,
          original_name,
          stored_name,
          content_type,
          size_bytes,
          file_path
         FROM report_issue_attachments
         WHERE session_id = ? AND report_issue_id IS NULL`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.toAttachmentEntry(row));
  }

  createReportIssue(
    entry: Omit<
      ReportIssueEntry,
      'attachmentIds' | 'status' | 'acknowledgedAt' | 'resolvedAt'
    > & {
      attachmentIds?: string[];
      status?: ReportIssueStatus;
      acknowledgedAt?: string | null;
      resolvedAt?: string | null;
      transactionRef?: string | null;
      resolutionReason?: ReportResolutionReason | null;
      resolutionNote?: string | null;
    },
  ): void {
    const status = entry.status ?? 'open';
    const attachmentIds = entry.attachmentIds ?? [];
    const acknowledgedAt = entry.acknowledgedAt ?? null;
    const resolvedAt = entry.resolvedAt ?? null;
    const transactionRef = entry.transactionRef ?? null;
    const resolutionReason = entry.resolutionReason ?? null;
    const resolutionNote = entry.resolutionNote ?? null;

    getSqliteDb()
      .prepare(
        `INSERT INTO report_issue_entries (
          id,
          session_id,
          timestamp,
          title,
          description,
          category,
          status,
          attachment_ids_json,
          acknowledged_at,
          resolved_at,
          meta_json,
          transaction_ref,
          resolution_reason,
          resolution_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.sessionId,
        entry.timestamp,
        entry.title,
        entry.description,
        entry.category,
        status,
        JSON.stringify(attachmentIds),
        acknowledgedAt,
        resolvedAt,
        jsonOrNull(entry.meta),
        transactionRef,
        resolutionReason,
        resolutionNote,
      );
  }

  assignAttachmentsToIssue(
    attachmentIds: string[],
    reportIssueId: string,
    sessionId: string,
  ): void {
    if (attachmentIds.length === 0) return;
    const db = getSqliteDb();
    const stmt = db.prepare(
      `UPDATE report_issue_attachments
       SET report_issue_id = ?
       WHERE id = ? AND session_id = ? AND report_issue_id IS NULL`,
    );
    for (const attachmentId of attachmentIds) {
      const result = stmt.run(reportIssueId, attachmentId, sessionId) as {
        changes?: unknown;
      };

      if (Number(result.changes ?? 0) !== 1) {
        throw new Error('Attachment is not available for this report session.');
      }
    }
  }

  assignAttachmentsDirectly(
    attachmentIds: string[],
    reportIssueId: string,
  ): void {
    if (attachmentIds.length === 0) return;
    const db = getSqliteDb();
    const stmt = db.prepare(
      `UPDATE report_issue_attachments
       SET report_issue_id = ?
       WHERE id = ? AND report_issue_id IS NULL`,
    );
    for (const attachmentId of attachmentIds) {
      stmt.run(reportIssueId, attachmentId);
    }
  }

  markSessionSubmitted(sessionId: string, submittedAt: string): number {
    const result = getSqliteDb()
      .prepare(
        'UPDATE report_issue_sessions SET submitted_at = ? WHERE id = ? AND submitted_at IS NULL',
      )
      .run(submittedAt, sessionId) as { changes?: unknown };
    return Number(result.changes ?? 0);
  }

  createSessionIssueWithAttachments(entry: ReportIssueEntry): void {
    withTransaction(() => {
      const changes = this.markSessionSubmitted(
        entry.sessionId,
        entry.timestamp,
      );
      if (changes !== 1) {
        throw new Error(
          'Report issue session already submitted or does not exist.',
        );
      }
      this.createReportIssue(entry);
      this.assignAttachmentsToIssue(
        entry.attachmentIds,
        entry.id,
        entry.sessionId,
      );
    });
  }

  createDirectIssueWithAttachments(entry: ReportIssueEntry): void {
    withTransaction(() => {
      this.createReportIssue(entry);
      this.assignAttachmentsDirectly(entry.attachmentIds, entry.id);
    });
  }

  listReportIssues(options: ListReportIssueOptions): {
    total: number;
    items: ReportIssueEntry[];
  } {
    const db = getSqliteDb();
    const limit = Math.max(1, Math.floor(options.limit));
    const offset = Math.max(0, Math.floor(options.offset));

    const where: string[] = [];
    const params = [] as (string | number)[];
    if (options.view === 'active') {
      where.push('status != ?');
      params.push('resolved');
    } else if (options.view === 'archived') {
      where.push('status = ?');
      params.push('resolved');
    } else if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.category) {
      where.push('category = ?');
      params.push(options.category);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS total FROM report_issue_entries ${whereSql}`)
      .get(...params) as { total?: unknown };

    const rows = db
      .prepare(
        `SELECT
          id,
          session_id,
          timestamp,
          title,
          description,
          category,
          status,
          attachment_ids_json,
          acknowledged_at,
          resolved_at,
          meta_json,
          transaction_ref,
          resolution_reason,
          resolution_note
         FROM report_issue_entries
         ${whereSql}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];

    return {
      total: Number(totalRow.total ?? 0),
      items: rows.map((row) => this.toIssueEntry(row)),
    };
  }

  countOpen(): number {
    const db = getSqliteDb();
    const row = db
      .prepare(
        "SELECT COUNT(*) AS total FROM report_issue_entries WHERE status != 'resolved'",
      )
      .get() as { total?: unknown };
    return Number(row?.total ?? 0);
  }

  getReportIssueStats(): {
    total: number;
    open: number;
    acknowledged: number;
    resolved: number;
  } {
    const db = getSqliteDb();
    const rows = db
      .prepare(
        'SELECT status, COUNT(*) AS count FROM report_issue_entries GROUP BY status',
      )
      .all() as { status?: unknown; count?: unknown }[];
    let open = 0;
    let acknowledged = 0;
    let resolved = 0;
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      if (row.status === 'open') open += count;
      else if (row.status === 'acknowledged') acknowledged += count;
      else if (row.status === 'resolved') resolved += count;
    }
    return {
      total: open + acknowledged + resolved,
      open,
      acknowledged,
      resolved,
    };
  }

  getReportIssueById(id: string): ReportIssueEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          id,
          session_id,
          timestamp,
          title,
          description,
          category,
          status,
          attachment_ids_json,
          acknowledged_at,
          resolved_at,
          meta_json,
          transaction_ref,
          resolution_reason,
          resolution_note
         FROM report_issue_entries
         WHERE id = ?
         LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toIssueEntry(row);
  }

  listAttachmentsForReport(
    reportIssueId: string,
  ): ReportIssueAttachmentEntry[] {
    const rows = getSqliteDb()
      .prepare(
        `SELECT
          id,
          session_id,
          report_issue_id,
          timestamp,
          original_name,
          stored_name,
          content_type,
          size_bytes,
          file_path
         FROM report_issue_attachments
         WHERE report_issue_id = ?
         ORDER BY timestamp DESC`,
      )
      .all(reportIssueId) as Record<string, unknown>[];
    return rows.map((row) => this.toAttachmentEntry(row));
  }

  findAttachmentById(attachmentId: string): ReportIssueAttachmentEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          id,
          session_id,
          report_issue_id,
          timestamp,
          original_name,
          stored_name,
          content_type,
          size_bytes,
          file_path
         FROM report_issue_attachments
         WHERE id = ?
         LIMIT 1`,
      )
      .get(attachmentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toAttachmentEntry(row);
  }

  updateReportIssueStatus(
    id: string,
    status: ReportIssueStatus,
    options?: {
      resolutionReason?: ReportResolutionReason;
      resolutionNote?: string | null;
    },
  ): ReportIssueEntry | null {
    const nowIso = new Date().toISOString();

    if (status === 'resolved') {
      if (!options?.resolutionReason) {
        throw new Error('Resolution reason is required to resolve a report.');
      }
      if (!isReportResolutionReason(options.resolutionReason)) {
        throw new Error('Invalid resolution reason.');
      }
      const note = options.resolutionNote ?? null;
      const result = getSqliteDb()
        .prepare(
          `UPDATE report_issue_entries
           SET status = ?,
               acknowledged_at = COALESCE(acknowledged_at, ?),
               resolved_at = ?,
               resolution_reason = ?,
               resolution_note = ?
           WHERE id = ?`,
        )
        .run(status, nowIso, nowIso, options.resolutionReason, note, id) as {
        changes?: unknown;
      };
      if (Number(result.changes ?? 0) === 0) return null;
      return this.getReportIssueById(id);
    }

    if (status === 'acknowledged') {
      const result = getSqliteDb()
        .prepare(
          `UPDATE report_issue_entries
           SET status = ?,
               acknowledged_at = COALESCE(acknowledged_at, ?),
               resolved_at = NULL,
               resolution_reason = NULL,
               resolution_note = NULL
           WHERE id = ?`,
        )
        .run(status, nowIso, id) as {
        changes?: unknown;
      };
      if (Number(result.changes ?? 0) === 0) return null;
      return this.getReportIssueById(id);
    }

    const result = getSqliteDb()
      .prepare(
        `UPDATE report_issue_entries
         SET status = ?,
             acknowledged_at = NULL,
             resolved_at = NULL,
             resolution_reason = NULL,
             resolution_note = NULL
         WHERE id = ?`,
      )
      .run(status, id) as {
      changes?: unknown;
    };
    if (Number(result.changes ?? 0) === 0) return null;
    return this.getReportIssueById(id);
  }

  updateIssueStatus(
    issueId: string,
    status: ReportIssueStatus,
    acknowledgedAt: string | null,
    resolvedAt: string | null,
  ): ReportIssueEntry | null {
    const result = getSqliteDb()
      .prepare(
        `UPDATE report_issue_entries
         SET status = ?, acknowledged_at = ?, resolved_at = ?
         WHERE id = ?`,
      )
      .run(status, acknowledgedAt, resolvedAt, issueId) as {
      changes?: unknown;
    };
    if (Number(result.changes ?? 0) === 0) return null;
    return this.getReportIssueById(issueId);
  }

  cleanupExpiredSessions(
    now: Date,
    retentionMs: number,
  ): ReportSessionCleanupResult {
    const nowMs = now.getTime();
    const retentionCutoff = nowMs - retentionMs;
    const sessionRows = getSqliteDb()
      .prepare('SELECT id, created_at, expires_at FROM report_issue_sessions')
      .all() as Record<string, unknown>[];

    const removedSessionIds: string[] = [];
    for (const row of sessionRows) {
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) continue;
      const expiresAt =
        typeof row.expires_at === 'string' ? row.expires_at : '';
      const createdAt =
        typeof row.created_at === 'string' ? row.created_at : '';
      const expiresAtMs = dateMs(expiresAt);
      const createdAtMs = dateMs(createdAt);

      if (!Number.isFinite(expiresAtMs)) {
        removedSessionIds.push(id);
        continue;
      }
      if (expiresAtMs >= nowMs) continue;
      if (!Number.isFinite(createdAtMs) || createdAtMs < retentionCutoff) {
        removedSessionIds.push(id);
      }
    }

    if (removedSessionIds.length === 0) {
      return { changed: false, orphanedAttachments: [] };
    }

    const placeholders = removedSessionIds.map(() => '?').join(', ');
    const orphanedRows = getSqliteDb()
      .prepare(
        `SELECT
          id,
          session_id,
          report_issue_id,
          timestamp,
          original_name,
          stored_name,
          content_type,
          size_bytes,
          file_path
         FROM report_issue_attachments
         WHERE session_id IN (${placeholders}) AND report_issue_id IS NULL`,
      )
      .all(...removedSessionIds) as Record<string, unknown>[];

    withTransaction(() => {
      getSqliteDb()
        .prepare(
          `DELETE FROM report_issue_attachments
           WHERE session_id IN (${placeholders}) AND report_issue_id IS NULL`,
        )
        .run(...removedSessionIds);

      getSqliteDb()
        .prepare(
          `DELETE FROM report_issue_sessions WHERE id IN (${placeholders})`,
        )
        .run(...removedSessionIds);
    });

    return {
      changed: true,
      orphanedAttachments: orphanedRows.map((row) =>
        this.toAttachmentEntry(row),
      ),
    };
  }

  private toSessionEntry(
    row: Record<string, unknown>,
  ): ReportIssueSessionEntry {
    return {
      id: String(row.id ?? ''),
      token: String(row.token ?? ''),
      reportUrl: String(row.report_url ?? ''),
      createdAt: String(row.created_at ?? ''),
      expiresAt: String(row.expires_at ?? ''),
      submittedAt:
        typeof row.submitted_at === 'string' ? row.submitted_at : null,
    };
  }

  private toIssueEntry(row: Record<string, unknown>): ReportIssueEntry {
    return mapReportIssueEntry(row);
  }

  private toAttachmentEntry(
    row: Record<string, unknown>,
  ): ReportIssueAttachmentEntry {
    return {
      id: String(row.id ?? ''),
      sessionId: String(row.session_id ?? ''),
      reportIssueId:
        typeof row.report_issue_id === 'string' ? row.report_issue_id : null,
      timestamp: String(row.timestamp ?? ''),
      originalName: String(row.original_name ?? ''),
      storedName: String(row.stored_name ?? ''),
      contentType: String(row.content_type ?? ''),
      sizeBytes: Number(row.size_bytes ?? 0),
      filePath: String(row.file_path ?? ''),
    };
  }
}

export function mapReportIssueEntry(
  row: Record<string, unknown>,
): ReportIssueEntry {
  const parsedMeta = normalizeLogMeta(parseJsonValue<unknown>(row.meta_json));
  const parsedAttachmentIds =
    parseJsonValue<unknown>(row.attachment_ids_json) ?? [];
  const attachmentIds = Array.isArray(parsedAttachmentIds)
    ? parsedAttachmentIds.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];

  const validCategories = new Set<string>([
    'hardware',
    'software',
    'print',
    'copy',
    'scan',
    'payment',
    'network',
    'other',
  ]);
  const validStatuses = new Set<string>(['open', 'acknowledged', 'resolved']);

  const categoryRaw = typeof row.category === 'string' ? row.category : '';
  const categoryValue = validCategories.has(categoryRaw)
    ? (categoryRaw as ReportIssueCategory)
    : 'other';

  const statusRaw = typeof row.status === 'string' ? row.status : '';
  const statusValue = validStatuses.has(statusRaw)
    ? (statusRaw as ReportIssueStatus)
    : 'open';

  return {
    id: String(row.id ?? ''),
    sessionId: String(row.session_id ?? ''),
    timestamp: String(row.timestamp ?? ''),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    category: categoryValue,
    status: statusValue,
    attachmentIds,
    acknowledgedAt:
      typeof row.acknowledged_at === 'string' ? row.acknowledged_at : null,
    resolvedAt: typeof row.resolved_at === 'string' ? row.resolved_at : null,
    transactionRef:
      typeof row.transaction_ref === 'string' ? row.transaction_ref : null,
    resolutionReason:
      typeof row.resolution_reason === 'string' &&
      isReportResolutionReason(row.resolution_reason)
        ? row.resolution_reason
        : null,
    resolutionNote:
      typeof row.resolution_note === 'string' ? row.resolution_note : null,
    meta: parsedMeta,
  };
}

export const reportIssueStore = new ReportIssueSqliteStore();

export function createReportIssue(
  entry: Parameters<ReportIssueSqliteStore['createReportIssue']>[0],
): void {
  reportIssueStore.createReportIssue(entry);
}

export function updateReportIssueStatus(
  id: string,
  status: ReportIssueStatus,
  options?: {
    resolutionReason?: ReportResolutionReason;
    resolutionNote?: string | null;
  },
): ReportIssueEntry | null {
  return reportIssueStore.updateReportIssueStatus(id, status, options);
}
