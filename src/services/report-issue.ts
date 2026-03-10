import { randomUUID } from 'node:crypto';
import {
  db,
  type LogMeta,
  type ReportIssueAttachmentEntry,
  type ReportIssueCategory,
  type ReportIssueEntry,
  type ReportIssueSessionEntry,
  type ReportIssueStatus,
} from './db';
import { adminService } from './admin';

const REPORT_SESSION_TTL_MS = 15 * 60 * 1000;
const REPORT_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 1000;

interface CreateSessionResult {
  sessionId: string;
  token: string;
  reportUrl: string;
  expiresAt: string;
}

interface RegisterAttachmentInput {
  sessionId: string;
  token: string;
  originalName: string;
  storedName: string;
  contentType: string;
  sizeBytes: number;
  filePath: string;
}

interface SubmitReportIssueInput {
  sessionId: string;
  token: string;
  title: string;
  description: string;
  category?: string | null;
  attachmentIds?: string[] | null;
  meta?: LogMeta;
}

interface CreateAdminReportIssueInput {
  title: string;
  description: string;
  category?: string | null;
  attachmentIds?: string[];
  meta?: LogMeta;
}

interface ListReportIssueOptions {
  status?: ReportIssueStatus;
  category?: ReportIssueCategory;
  limit?: number;
  offset?: number;
}

interface ListReportIssueResult {
  total: number;
  items: ReportIssueEntry[];
}

class ReportIssueService {
  async createSession(publicBaseUrl: URL): Promise<CreateSessionResult> {
    await this.cleanupExpiredSessions();

    const token = randomUUID();
    const sessionId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + REPORT_SESSION_TTL_MS);
    const reportUrl = this.buildReportUrl(publicBaseUrl, token);

    const session: ReportIssueSessionEntry = {
      id: sessionId,
      token,
      reportUrl,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      submittedAt: null,
    };

    db.data!.reportIssueSessions.unshift(session);
    await db.write();

    return { sessionId, token, reportUrl, expiresAt: session.expiresAt };
  }

  async getSessionByToken(
    token: string,
  ): Promise<ReportIssueSessionEntry | null> {
    await this.cleanupExpiredSessions();

    const normalizedToken = token.trim();
    if (!normalizedToken) return null;

    const session =
      db.data!.reportIssueSessions.find((s) => s.token === normalizedToken) ??
      null;
    if (!session) return null;
    if (this.isExpired(session.expiresAt)) return null;

    return session;
  }

  async registerAttachment(
    input: RegisterAttachmentInput,
  ): Promise<ReportIssueAttachmentEntry> {
    const session = this.findSession(input.sessionId, input.token);
    if (!session) throw new Error('Invalid session');
    if (this.isExpired(session.expiresAt))
      throw new Error('Session has expired');

    const attachment: ReportIssueAttachmentEntry = {
      id: randomUUID(),
      sessionId: session.id,
      reportIssueId: null,
      timestamp: new Date().toISOString(),
      originalName: input.originalName.trim(),
      storedName: input.storedName.trim(),
      contentType: input.contentType.trim().toLowerCase(),
      sizeBytes: Math.max(0, Math.floor(input.sizeBytes)),
      filePath: input.filePath,
    };

    db.data!.reportIssueAttachments.unshift(attachment);
    await db.write();

    await adminService.appendAdminLog(
      'report_issue_attachment_uploaded',
      'Report issue image uploaded',
      {
        sessionId: session.id,
        attachmentId: attachment.id,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
      },
    );

    return attachment;
  }

  async submitReportIssue(
    input: SubmitReportIssueInput,
  ): Promise<ReportIssueEntry> {
    await this.cleanupExpiredSessions();

    const session = this.findSession(input.sessionId, input.token);
    if (!session) throw new Error('Invalid session');
    if (this.isExpired(session.expiresAt))
      throw new Error('Session has expired');

    const title = this.sanitizeTitle(input.title);
    if (!title) throw new Error('Title is required');

    const description = this.sanitizeDescription(input.description);
    if (!description) throw new Error('Description is required');

    const category = this.normalizeCategory(input.category);
    const attachmentIds = this.resolveAttachmentIds(
      input.attachmentIds ?? [],
      session.id,
    );

    const entry: ReportIssueEntry = {
      id: randomUUID(),
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      title,
      description,
      category,
      status: 'open',
      attachmentIds,
      acknowledgedAt: null,
      resolvedAt: null,
      meta: input.meta,
    };

    db.data!.reportIssues.unshift(entry);

    for (const attachment of db.data!.reportIssueAttachments) {
      if (attachmentIds.includes(attachment.id)) {
        attachment.reportIssueId = entry.id;
      }
    }

    session.submittedAt = entry.timestamp;
    await db.write();

    await adminService.appendAdminLog(
      'report_issue_submitted',
      'User submitted an issue report',
      {
        reportIssueId: entry.id,
        category: entry.category,
        attachmentCount: entry.attachmentIds.length,
      },
    );

    return entry;
  }

  async createByAdmin(
    input: CreateAdminReportIssueInput,
  ): Promise<ReportIssueEntry> {
    const title = this.sanitizeTitle(input.title);
    if (!title) throw new Error('Title is required');

    const description = this.sanitizeDescription(input.description);
    if (!description) throw new Error('Description is required');

    const category = this.normalizeCategory(input.category);
    const attachmentIds = Array.isArray(input.attachmentIds)
      ? input.attachmentIds.filter((id) => typeof id === 'string' && id.trim())
      : [];

    const entry: ReportIssueEntry = {
      id: randomUUID(),
      sessionId: 'admin-manual',
      timestamp: new Date().toISOString(),
      title,
      description,
      category,
      status: 'open',
      attachmentIds,
      acknowledgedAt: null,
      resolvedAt: null,
      meta: input.meta,
    };

    db.data!.reportIssues.unshift(entry);
    await db.write();

    await adminService.appendAdminLog(
      'report_issue_created_admin',
      'Admin manually created an issue report',
      { reportIssueId: entry.id },
    );

    return entry;
  }

  listReportIssues(
    options: ListReportIssueOptions = {},
  ): ListReportIssueResult {
    const { status, category } = options;
    const limit = this.clampLimit(options.limit);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));

    const filtered = db.data!.reportIssues.filter((entry) => {
      if (status && entry.status !== status) return false;
      if (category && entry.category !== category) return false;
      return true;
    });

    return {
      total: filtered.length,
      items: filtered.slice(offset, offset + limit),
    };
  }

  getReportIssueById(id: string): ReportIssueEntry | null {
    return db.data!.reportIssues.find((r) => r.id === id) ?? null;
  }

  listAttachmentsForReport(
    reportIssueId: string,
  ): ReportIssueAttachmentEntry[] {
    return db.data!.reportIssueAttachments.filter(
      (a) => a.reportIssueId === reportIssueId,
    );
  }

  findAttachmentById(attachmentId: string): ReportIssueAttachmentEntry | null {
    return (
      db.data!.reportIssueAttachments.find((a) => a.id === attachmentId) ?? null
    );
  }

  async updateStatus(
    id: string,
    status: ReportIssueStatus,
  ): Promise<ReportIssueEntry | null> {
    const entry = this.getReportIssueById(id);
    if (!entry) return null;

    entry.status = status;
    if (status === 'acknowledged' && !entry.acknowledgedAt) {
      entry.acknowledgedAt = new Date().toISOString();
    }
    if (status === 'resolved') {
      if (!entry.acknowledgedAt)
        entry.acknowledgedAt = new Date().toISOString();
      entry.resolvedAt = new Date().toISOString();
    }
    if (status === 'open') {
      entry.acknowledgedAt = null;
      entry.resolvedAt = null;
    }

    await db.write();

    await adminService.appendAdminLog(
      'report_issue_status_changed',
      'Report issue status updated',
      { reportIssueId: entry.id, status: entry.status },
    );

    return entry;
  }

  async cleanupExpiredSessions(now = new Date()): Promise<void> {
    const nowMs = now.getTime();
    const retentionCutoff = nowMs - REPORT_SESSION_RETENTION_MS;
    const before = db.data!.reportIssueSessions.length;

    db.data!.reportIssueSessions = db.data!.reportIssueSessions.filter(
      (session) => {
        const expiresAtMs = Date.parse(session.expiresAt);
        const createdAtMs = Date.parse(session.createdAt);

        if (!Number.isFinite(expiresAtMs)) return false;
        if (expiresAtMs >= nowMs) return true;
        if (!Number.isFinite(createdAtMs)) return false;
        return createdAtMs >= retentionCutoff;
      },
    );

    if (before !== db.data!.reportIssueSessions.length) {
      await db.write();
    }
  }

  private findSession(
    sessionId: string,
    token: string,
  ): ReportIssueSessionEntry | null {
    return (
      db.data!.reportIssueSessions.find(
        (s) => s.id === sessionId && s.token === token,
      ) ?? null
    );
  }

  private resolveAttachmentIds(ids: string[], sessionId: string): string[] {
    const unique = [
      ...new Set(ids.filter((id) => typeof id === 'string' && id.trim())),
    ];
    const valid = db
      .data!.reportIssueAttachments.filter(
        (a) => a.sessionId === sessionId && a.reportIssueId === null,
      )
      .map((a) => a.id);
    return unique.filter((id) => valid.includes(id));
  }

  private sanitizeTitle(value: string): string {
    const trimmed = value.trim();
    return trimmed.length <= MAX_TITLE_LENGTH
      ? trimmed
      : trimmed.slice(0, MAX_TITLE_LENGTH);
  }

  private sanitizeDescription(value: string): string {
    const trimmed = value.trim();
    return trimmed.length <= MAX_DESCRIPTION_LENGTH
      ? trimmed
      : trimmed.slice(0, MAX_DESCRIPTION_LENGTH);
  }

  private normalizeCategory(input?: string | null): ReportIssueCategory {
    const norm = typeof input === 'string' ? input.trim().toLowerCase() : '';
    const valid: ReportIssueCategory[] = [
      'hardware',
      'software',
      'print',
      'copy',
      'scan',
      'payment',
      'other',
    ];
    return (
      valid.includes(norm as ReportIssueCategory) ? norm : 'other'
    ) as ReportIssueCategory;
  }

  private clampLimit(limit?: number): number {
    const n = Math.floor(limit ?? DEFAULT_LIMIT);
    return Math.max(1, Math.min(n, MAX_LIMIT));
  }

  private buildReportUrl(publicBaseUrl: URL, token: string): string {
    return (
      publicBaseUrl.toString().replace(/\/$/, '') +
      '/report/' +
      encodeURIComponent(token)
    );
  }

  private isExpired(expiresAtIso: string): boolean {
    const ms = Date.parse(expiresAtIso);
    return !Number.isFinite(ms) || Date.now() > ms;
  }
}

export const reportIssueService = new ReportIssueService();
