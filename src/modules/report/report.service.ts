import path from 'node:path';
import fs from 'node:fs';
import {
  reportIssueService,
} from '@/services/report-issue';
import type {
  LogMeta,
  ReportIssueAttachmentEntry,
  ReportIssueCategory,
  ReportIssueEntry,
  ReportIssueSessionEntry,
  ReportIssueStatus,
} from '@/services/db';
import type { AdminQueueView } from './report.schema';
import { serializeForInlineScript } from '@/utils/helpers';
import { promoteStagedUpload } from '@/services/upload-staging';

const REPORT_PORTAL_DIR = path.resolve('src', 'public', 'report');
const REPORT_PORTAL_ASSETS = new Set(['styles.css', 'app.js']);
const REPORT_IMAGE_DIR = path.resolve('uploads', 'report-issues');
const REPORT_ATTACHMENT_STAGING_DIR = path.resolve(
  'uploads',
  'staging',
  'report-issues',
);

const EXPIRED_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session Expired · PrintBit</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    display:flex;align-items:center;justify-content:center;
    min-height:100vh;background:#f0f2f5;margin:0;color:#333}
  .c{background:#fff;border-radius:16px;padding:2rem;max-width:380px;
    text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .icon{font-size:2.5rem;margin-bottom:.75rem}
  h2{margin-bottom:.5rem;font-size:1.2rem}
  p{color:#666;font-size:.9rem;line-height:1.5}
</style></head>
<body><div class="c">
  <div class="icon">⏰</div>
  <h2>Session Expired</h2>
  <p>This link is no longer valid.</p>
  <p>Please go back to the kiosk and scan a new QR code to report an issue.</p>
</div></body></html>`;

const REPORT_PORTAL_TEMPLATE = fs.readFileSync(
  path.join(REPORT_PORTAL_DIR, 'index.html'),
  'utf-8',
);

export interface CreateSessionResult {
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

export class ReportService {
  async createSession(publicBaseUrl: URL): Promise<CreateSessionResult> {
    return reportIssueService.createSession(publicBaseUrl);
  }

  async getSessionByToken(token: string): Promise<ReportIssueSessionEntry | null> {
    return reportIssueService.getSessionByToken(token);
  }

  resolveAttachmentExtension(originalName: string, mimeType: string): string {
    const fromName = path.extname(originalName).toLowerCase();
    if (fromName === '.jpg' || fromName === '.jpeg') return '.jpg';
    if (fromName === '.png') return '.png';
    if (fromName === '.webp') return '.webp';
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/webp') return '.webp';
    return '.jpg';
  }

  async persistAttachmentWithStaging(
    file: Express.Multer.File,
    storedName: string,
  ): Promise<string> {
    const resolvedReportDir = path.resolve(REPORT_IMAGE_DIR);
    const finalPath = path.resolve(resolvedReportDir, storedName);

    if (file.path) {
      return await promoteStagedUpload(file, finalPath);
    }

    if (file.buffer) {
      await fs.promises.mkdir(resolvedReportDir, { recursive: true });
      await fs.promises.writeFile(finalPath, file.buffer);
      return finalPath;
    }

    throw new Error('Uploaded file is missing disk path and in-memory buffer.');
  }

  async removeAttachmentFile(filePath: string): Promise<void> {
    await fs.promises.unlink(filePath).catch(() => {});
  }

  async registerAttachment(
    input: RegisterAttachmentInput,
  ): Promise<ReportIssueAttachmentEntry> {
    return reportIssueService.registerAttachment(input);
  }

  async submitReportIssue(
    input: SubmitReportIssueInput,
  ): Promise<ReportIssueEntry> {
    return reportIssueService.submitReportIssue(input);
  }

  renderReportPortal(token?: string): string {
    if (!token) {
      return REPORT_PORTAL_TEMPLATE.replace(
        '</head>',
        `<base href="/report/"></head>`,
      );
    }
    const safeTokenForScript = serializeForInlineScript(token);
    return REPORT_PORTAL_TEMPLATE.replace(
      '</head>',
      `<base href="/report/${encodeURIComponent(token)}/"><script>window.reportIssueToken=${safeTokenForScript};</script></head>`,
    );
  }

  isReportPortalAssetAllowed(asset: string): boolean {
    return REPORT_PORTAL_ASSETS.has(asset);
  }

  getReportPortalAssetPath(asset: string): string {
    return path.join(REPORT_PORTAL_DIR, asset);
  }

  getExpiredHtml(): string {
    return EXPIRED_HTML;
  }

  listReportIssues(options: ListReportIssueOptions): ListReportIssueResult {
    return reportIssueService.listReportIssues(options);
  }

  getReportIssueById(id: string): ReportIssueEntry | null {
    return reportIssueService.getReportIssueById(id);
  }

  listAttachmentsForReport(reportIssueId: string): ReportIssueAttachmentEntry[] {
    return reportIssueService.listAttachmentsForReport(reportIssueId);
  }

  async updateStatus(
    id: string,
    status: ReportIssueStatus,
  ): Promise<ReportIssueEntry | null> {
    return reportIssueService.updateStatus(id, status);
  }

  async createByAdmin(input: CreateAdminReportIssueInput): Promise<ReportIssueEntry> {
    return reportIssueService.createByAdmin(input);
  }

  findAttachmentById(attachmentId: string): ReportIssueAttachmentEntry | null {
    return reportIssueService.findAttachmentById(attachmentId);
  }

  isAttachmentInReportDir(filePath: string): boolean {
    const absolute = path.resolve(filePath);
    const rel = path.relative(REPORT_IMAGE_DIR, absolute);
    return !(rel.startsWith('..') || path.isAbsolute(rel));
  }

  ensureStorageDirs(): void {
    fs.mkdirSync(REPORT_IMAGE_DIR, { recursive: true });
    fs.mkdirSync(REPORT_ATTACHMENT_STAGING_DIR, { recursive: true });
  }
}
