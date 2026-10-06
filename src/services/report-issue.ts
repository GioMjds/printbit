import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  type LogMeta,
  type ReportIssueAttachmentEntry,
  type ReportIssueCategory,
  type ReportIssueEntry,
  type ReportIssueSessionEntry,
  type ReportIssueStatus,
} from './db';
import type { AdminQueueView } from '@/modules/report/report.schema';
import { adminService } from './admin';
import { reportIssueStore } from '@/core/database/sqlite-storage';

const REPORT_SESSION_TTL_MS = 15 * 60 * 1000;
const REPORT_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1200;
const MAX_ATTACHMENTS_PER_SESSION = 5;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 1000;

interface CreateSessionResult {
  sessionId: string;
  token: string;
  reportUrl: string;
  expiresAt: string;
}

export interface RegisterAttachmentInput {
  sessionId?: string;
  token?: string;
  originalName: string;
  storedName: string;
  contentType: string;
  sizeBytes: number;
  filePath: string;
}

export interface SubmitReportIssueInput {
  sessionId?: string;
  token?: string;
  title: string;
  description: string;
  category?: string | null;
  attachmentIds?: string[] | null;
  transactionRef?: string | null;
  meta?: LogMeta;
}

export interface CreateAdminReportIssueInput {
  title: string;
  description: string;
  category?: string | null;
  attachmentIds?: string[];
  meta?: LogMeta;
}

export interface ListReportIssueOptions {
  status?: ReportIssueStatus;
  category?: ReportIssueCategory;
  view?: AdminQueueView;
  limit?: number;
  offset?: number;
}

export interface ListReportIssueResult {
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

    reportIssueStore.createSession(session);

    return { sessionId, token, reportUrl, expiresAt: session.expiresAt };
  }

  async getSessionByToken(
    token: string,
  ): Promise<ReportIssueSessionEntry | null> {
    await this.cleanupExpiredSessions();

    const normalizedToken = token.trim();
    if (!normalizedToken) return null;

    const session = reportIssueStore.getSessionByToken(normalizedToken);
    if (!session) return null;
    if (this.isExpired(session.expiresAt)) return null;

    return session;
  }

  async registerAttachment(
    input: RegisterAttachmentInput,
  ): Promise<ReportIssueAttachmentEntry> {
    let sessionId = input.sessionId;
    if (input.sessionId && input.token) {
      const session = this.findSession(input.sessionId, input.token);
      if (!session) throw new Error('Invalid session');
      if (this.isExpired(session.expiresAt))
        throw new Error('Session has expired');
      if (session.submittedAt) throw new Error('Session already submitted');

      const existingCount = reportIssueStore.countSessionAttachments(
        session.id,
      );
      if (existingCount >= MAX_ATTACHMENTS_PER_SESSION)
        throw new Error('Attachment limit reached');
      sessionId = session.id;
    } else {
      sessionId = sessionId || 'direct';
    }

    const attachment: ReportIssueAttachmentEntry = {
      id: randomUUID(),
      sessionId,
      reportIssueId: null,
      timestamp: new Date().toISOString(),
      originalName: input.originalName.trim(),
      storedName: input.storedName.trim(),
      contentType: input.contentType.trim().toLowerCase(),
      sizeBytes: Math.max(0, Math.floor(input.sizeBytes)),
      filePath: input.filePath,
    };

    reportIssueStore.registerAttachment(attachment);

    await adminService.appendAdminLog(
      'report_issue_attachment_uploaded',
      'Report issue image uploaded',
      {
        sessionId: attachment.sessionId,
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

    let sessionId = input.sessionId;
    let attachmentIds: string[] = [];

    if (input.sessionId && input.token) {
      const session = this.findSession(input.sessionId, input.token);
      if (!session) throw new Error('Invalid session');
      if (this.isExpired(session.expiresAt))
        throw new Error('Session has expired');
      if (session.submittedAt) throw new Error('Session already submitted');
      sessionId = session.id;
      attachmentIds = this.resolveAttachmentIds(
        input.attachmentIds ?? [],
        session.id,
      );
    } else {
      sessionId = sessionId || 'direct';
      attachmentIds = this.resolveDirectAttachmentIds(
        input.attachmentIds ?? [],
      );
    }

    const title = this.sanitizeTitle(input.title);
    if (!title) throw new Error('Title is required');

    const description = this.sanitizeDescription(input.description);
    if (!description) throw new Error('Description is required');

    const category = this.normalizeCategory(input.category);

    const entry: ReportIssueEntry = {
      id: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      title,
      description,
      category,
      status: 'open',
      attachmentIds,
      acknowledgedAt: null,
      resolvedAt: null,
      transactionRef: input.transactionRef ?? null,
      meta: input.meta,
    };

    if (input.sessionId && input.token) {
      reportIssueStore.createSessionIssueWithAttachments(entry);
    } else {
      reportIssueStore.createDirectIssueWithAttachments(entry);
    }

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

    reportIssueStore.createReportIssue(entry);

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
    const { status, category, view } = options;
    const limit = this.clampLimit(options.limit);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));

    return reportIssueStore.listReportIssues({
      status,
      category,
      view,
      limit,
      offset,
    });
  }

  getReportIssueById(id: string): ReportIssueEntry | null {
    return reportIssueStore.getReportIssueById(id);
  }

  listAttachmentsForReport(
    reportIssueId: string,
  ): ReportIssueAttachmentEntry[] {
    return reportIssueStore.listAttachmentsForReport(reportIssueId);
  }

  findAttachmentById(attachmentId: string): ReportIssueAttachmentEntry | null {
    return reportIssueStore.findAttachmentById(attachmentId);
  }

  async updateStatus(
    id: string,
    status: ReportIssueStatus,
  ): Promise<ReportIssueEntry | null> {
    const entry = this.getReportIssueById(id);
    if (!entry) return null;

    const nowIso = new Date().toISOString();
    let acknowledgedAt = entry.acknowledgedAt;
    let resolvedAt = entry.resolvedAt;
    if (status === 'acknowledged' && !entry.acknowledgedAt) {
      acknowledgedAt = nowIso;
    }
    if (status === 'resolved') {
      if (!acknowledgedAt) acknowledgedAt = nowIso;
      resolvedAt = nowIso;
    }
    if (status === 'open') {
      acknowledgedAt = null;
      resolvedAt = null;
    }
    const updated = reportIssueStore.updateIssueStatus(
      id,
      status,
      acknowledgedAt,
      resolvedAt,
    );
    if (!updated) return null;

    await adminService.appendAdminLog(
      'report_issue_status_changed',
      'Report issue status updated',
      { reportIssueId: updated.id, status: updated.status },
    );

    return updated;
  }

  async cleanupExpiredSessions(now = new Date()): Promise<void> {
    const cleanup = reportIssueStore.cleanupExpiredSessions(
      now,
      REPORT_SESSION_RETENTION_MS,
    );
    if (cleanup.orphanedAttachments.length > 0) {
      for (const att of cleanup.orphanedAttachments) {
        try {
          fs.unlinkSync(att.filePath);
        } catch {
          // Ignore file deletion errors, but log them for admin review
        }
      }
    }
  }

  private findSession(
    sessionId: string,
    token: string,
  ): ReportIssueSessionEntry | null {
    return reportIssueStore.findSessionByIdAndToken(sessionId, token);
  }

  private resolveAttachmentIds(ids: string[], sessionId: string): string[] {
    const unique = [
      ...new Set(ids.filter((id) => typeof id === 'string' && id.trim())),
    ];
    const valid = reportIssueStore
      .listUnlinkedSessionAttachments(sessionId)
      .map((a) => a.id);
    return unique.filter((id) => valid.includes(id));
  }

  private resolveDirectAttachmentIds(ids: string[]): string[] {
    const unique = [
      ...new Set(ids.filter((id) => typeof id === 'string' && id.trim())),
    ];
    return unique.filter((id) => {
      const att = reportIssueStore.findAttachmentById(id);
      return att !== null && att.reportIssueId === null;
    });
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
      'network',
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
    return new URL(
      `/report/${encodeURIComponent(token)}`,
      publicBaseUrl,
    ).toString();
  }

  private isExpired(expiresAtIso: string): boolean {
    const ms = Date.parse(expiresAtIso);
    return !Number.isFinite(ms) || Date.now() > ms;
  }
}

export const reportIssueService = new ReportIssueService();
