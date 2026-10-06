import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  Router,
  type Request,
  type Response,
} from 'express';
import {
  requireAdminLocalAccess,
  requireAdminPin,
} from '@/middleware/admin-auth';
import {
  reportIssueAttachmentUploadMiddleware,
  validateReportIssueAttachmentMagicBytes,
  scanReportIssueAttachmentForMalware,
  handleMulterError,
} from '@/middleware/file-validation';
import { createRateLimit } from '@/middleware/rate-limit';
import { ReportService } from './report.service';
import {
  type LogMeta,
  type ReportIssueCategory,
  type ReportIssueStatus,
  type AdminQueueView,
  type ReportResolutionReason,
  REPORT_RESOLUTION_REASONS,
} from './report.schema';

export interface ReportControllerDeps {
  resolvePublicBaseUrl: (req: Request) => URL;
}

type ReportBody = {
  title?: unknown;
  description?: unknown;
  category?: unknown;
  attachmentIds?: unknown;
  meta?: unknown;
  transactionRef?: unknown;
};

const reportPortalAssetRateLimit = createRateLimit({
  keyPrefix: 'report-portal-asset',
  windowMs: 60_000,
  max: 120,
  message: 'Too many requests. Please try again later.',
});

const adminReportAttachmentRateLimit = createRateLimit({
  keyPrefix: 'admin-report-attachment-file',
  windowMs: 60_000,
  max: 60,
});

function parseLogMeta(input: unknown): { value?: LogMeta; error?: string } {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'meta must be an object with primitive values.' };
  }

  const output: LogMeta = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    if (value === null) {
      output[normalizedKey] = null;
      continue;
    }
    if (typeof value === 'string') {
      output[normalizedKey] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      output[normalizedKey] = value;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return { error: `meta.${normalizedKey} must be a finite number.` };
      }
      output[normalizedKey] = value;
      continue;
    }
    return {
      error:
        `meta.${normalizedKey} must be string, number, boolean, or null.`,
    };
  }

  return { value: output };
}

export class ReportController {
  public readonly router: Router;
  private readonly service: ReportService;
  private readonly deps: ReportControllerDeps;

  constructor(service: ReportService, deps: ReportControllerDeps) {
    this.service = service;
    this.deps = deps;
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.service.ensureStorageDirs();

    this.router.get(
      '/api/report-issues/qr-url',
      this.getReportQrUrl,
    );
    this.router.get(
      '/api/report-issues/url',
      this.getReportQrUrl,
    );

    this.router.post(
      '/api/report-issues/sessions',
      this.createSession.bind(this),
    );
    this.router.get(
      '/api/report-issues/sessions/by-token/:token',
      this.getSessionByToken.bind(this),
    );

    this.router.post(
      '/api/report-issues/attachments',
      reportIssueAttachmentUploadMiddleware.single('file'),
      validateReportIssueAttachmentMagicBytes,
      scanReportIssueAttachmentForMalware,
      this.uploadDirectAttachment.bind(this),
    );
    this.router.use(
      '/api/report-issues/attachments',
      handleMulterError,
    );

    this.router.post(
      '/api/report-issues/sessions/:sessionId/attachments',
      reportIssueAttachmentUploadMiddleware.single('file'),
      validateReportIssueAttachmentMagicBytes,
      scanReportIssueAttachmentForMalware,
      this.uploadAttachment.bind(this),
    );
    this.router.use(
      '/api/report-issues/sessions/:sessionId/attachments',
      handleMulterError,
    );

    this.router.post(
      '/api/report-issues',
      this.submitDirectReportIssue.bind(this),
    );

    this.router.post(
      '/api/report-issues/sessions/:sessionId/submit',
      this.submitReportIssue.bind(this),
    );

    this.router.get('/report', this.serveDirectReportPortal.bind(this));
    this.router.get('/report/styles.css', this.serveDirectReportAsset.bind(this));
    this.router.get('/report/app.js', this.serveDirectReportAsset.bind(this));
    this.router.get('/report/:token', this.serveReportPortal.bind(this));
    this.router.get('/report/:token/:asset', reportPortalAssetRateLimit, this.serveReportAsset.bind(this));

    this.router.get(
      '/api/admin/report-issues',
      requireAdminLocalAccess,
      requireAdminPin,
      this.listAdminReportIssues.bind(this),
    );
    this.router.get(
      '/api/admin/report-issues/:id',
      requireAdminLocalAccess,
      requireAdminPin,
      this.getAdminReportIssueDetail.bind(this),
    );
    this.router.patch(
      '/api/admin/report-issues/:id/status',
      requireAdminLocalAccess,
      requireAdminPin,
      this.patchAdminReportIssueStatus.bind(this),
    );
    this.router.post(
      '/api/admin/report-issues',
      requireAdminLocalAccess,
      requireAdminPin,
      this.createAdminReportIssue.bind(this),
    );
    this.router.get(
      '/api/admin/report-issues/attachments/:attachmentId/file',
      requireAdminLocalAccess,
      requireAdminPin,
      adminReportAttachmentRateLimit,
      this.getAdminAttachmentFile.bind(this),
    );
  }

  private getReportQrUrl = (req: Request, res: Response): void => {
    try {
      const baseUrl = this.deps.resolvePublicBaseUrl(req);
      const url = new URL('/report', baseUrl).toString();
      res.json({ url });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  };

  private async createSession(req: Request, res: Response): Promise<void> {
    try {
      const baseUrl = this.deps.resolvePublicBaseUrl(req);
      const session = await this.service.createSession(baseUrl);
      res.status(201).json(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  }

  private async getSessionByToken(req: Request, res: Response): Promise<void> {
    const { token } = req.params as { token: string };
    const session = await this.service.getSessionByToken(token);
    if (!session) {
      res.status(404).json({ error: 'Session not found or expired.' });
      return;
    }
    res.json({ sessionId: session.id, reportUrl: session.reportUrl });
  }

  private async uploadAttachment(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params as { sessionId: string };
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: 'No file provided.' });
      return;
    }

    const extension = this.service.resolveAttachmentExtension(
      file.originalname,
      file.mimetype,
    );
    const storedName = `${randomUUID()}${extension}`;
    let finalPath = '';

    try {
      finalPath = await this.service.persistAttachmentWithStaging(
        file,
        storedName,
      );
      const attachment = await this.service.registerAttachment({
        sessionId,
        token,
        originalName: file.originalname,
        storedName,
        contentType: file.mimetype,
        sizeBytes: file.size,
        filePath: finalPath,
      });

      res.status(201).json({
        attachmentId: attachment.id,
        fileName: attachment.originalName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        uploadedAt: attachment.timestamp,
      });
    } catch (err) {
      if (finalPath) {
        await this.service.removeAttachmentFile(finalPath);
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  }

  private uploadDirectAttachment = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided.' });
      return;
    }

    const extension = this.service.resolveAttachmentExtension(
      file.originalname,
      file.mimetype,
    );
    const storedName = `${randomUUID()}${extension}`;
    let finalPath = '';

    try {
      finalPath = await this.service.persistAttachmentWithStaging(
        file,
        storedName,
      );
      const attachment = await this.service.registerAttachment({
        originalName: file.originalname,
        storedName,
        contentType: file.mimetype,
        sizeBytes: file.size,
        filePath: finalPath,
      });

      res.status(201).json({
        attachmentId: attachment.id,
        fileName: attachment.originalName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        uploadedAt: attachment.timestamp,
      });
    } catch (err) {
      if (finalPath) {
        await this.service.removeAttachmentFile(finalPath);
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  };

  private submitDirectReportIssue = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const body = req.body as ReportBody;

    const title = typeof body.title === 'string' ? body.title : '';
    const description = typeof body.description === 'string' ? body.description : '';
    const category = typeof body.category === 'string' ? body.category : null;
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((id): id is string => typeof id === 'string')
      : [];
    const rawTxRef = body.transactionRef ?? req.query.transactionRef;
    const transactionRef =
      typeof rawTxRef === 'string' && rawTxRef.trim()
        ? rawTxRef.trim()
        : null;

    try {
      const entry = await this.service.submitDirectReportIssue({
        title,
        description,
        category,
        attachmentIds,
        transactionRef,
      });
      res.status(201).json({ ok: true, reportIssueId: entry.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  };

  private submitReportIssue = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const { sessionId } = req.params as { sessionId: string };
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const body = req.body as ReportBody;

    const title = typeof body.title === 'string' ? body.title : '';
    const description = typeof body.description === 'string' ? body.description : '';
    const category = typeof body.category === 'string' ? body.category : null;
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((id): id is string => typeof id === 'string')
      : [];
    const rawTxRef = body.transactionRef ?? req.query.transactionRef;
    const transactionRef =
      typeof rawTxRef === 'string' && rawTxRef.trim()
        ? rawTxRef.trim()
        : null;

    try {
      const entry = await this.service.submitReportIssue({
        sessionId,
        token,
        title,
        description,
        category,
        attachmentIds,
        transactionRef,
      });
      res.status(201).json({ ok: true, reportIssueId: entry.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  };

  private serveDirectReportPortal = (
    _req: Request,
    res: Response,
  ): void => {
    try {
      res.type('html').send(this.service.renderReportPortal());
    } catch {
      res.status(500).send('Error loading report portal.');
    }
  };

  private async serveReportPortal(req: Request, res: Response): Promise<void> {
    const { token } = req.params as { token: string };
    const session = await this.service.getSessionByToken(token);
    if (!session) {
      res.status(410).type('html').send(this.service.getExpiredHtml());
      return;
    }
    try {
      res.type('html').send(this.service.renderReportPortal(token));
    } catch {
      res.status(500).send('Error loading report portal.');
    }
  }

  private serveDirectReportAsset(req: Request, res: Response): void {
    const asset = req.path.replace(/^\/report\//, '').replace(/^\//, '');
    if (!this.service.isReportPortalAssetAllowed(asset)) {
      res.status(404).send('Not found.');
      return;
    }
    const filePath = this.service.getReportPortalAssetPath(asset);
    res.sendFile(filePath, (err) => {
      if (err) res.status(404).send('Asset not found.');
    });
  }

  private serveReportAsset(req: Request, res: Response): void {
    const { asset } = req.params as { asset: string };
    if (!this.service.isReportPortalAssetAllowed(asset)) {
      res.status(404).send('Not found.');
      return;
    }
    const filePath = this.service.getReportPortalAssetPath(asset);
    res.sendFile(filePath, (err) => {
      if (err) res.status(404).send('Asset not found.');
    });
  }

  private listAdminReportIssues(req: Request, res: Response): void {
    const rawView = req.query.view;
    let view: AdminQueueView | undefined;

    if (rawView !== undefined) {
      if (rawView !== 'active' && rawView !== 'archived' && rawView !== 'all') {
        res
          .status(400)
          .json({ error: 'view must be active, archived, or all.' });
        return;
      }
      view = rawView as AdminQueueView;
    }

    const {
      status: rawStatus,
      category: rawCategory,
      limit: rawLimit,
      offset: rawOffset,
    } = req.query;

    const status: ReportIssueStatus | undefined =
      rawStatus === 'open' ||
      rawStatus === 'acknowledged' ||
      rawStatus === 'resolved'
        ? rawStatus
        : undefined;

    const validCategories: ReportIssueCategory[] = [
      'hardware',
      'software',
      'print',
      'copy',
      'scan',
      'payment',
      'network',
      'other',
    ];
    const category: ReportIssueCategory | undefined =
      validCategories.includes(rawCategory as ReportIssueCategory)
        ? (rawCategory as ReportIssueCategory)
        : undefined;

    const limit = Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : 100;
    const offset = Number.isFinite(Number(rawOffset)) ? Number(rawOffset) : 0;

    res.json(
      this.service.listReportIssues({
        status,
        category,
        view,
        limit,
        offset,
      }),
    );
  }

  private getAdminReportIssueDetail(req: Request, res: Response): void {
    const { id } = req.params as { id: string };
    const issue = this.service.getReportIssueById(id);
    if (!issue) {
      res.status(404).json({ error: 'Report issue not found.' });
      return;
    }

    const attachments = this.service.listAttachmentsForReport(id);
    res.json({ issue, attachments });
  }

  private async patchAdminReportIssueStatus(
    req: Request,
    res: Response,
  ): Promise<void> {
    const { id } = req.params as { id: string };
    const body = req.body as {
      status?: unknown;
      resolutionReason?: unknown;
      resolutionNote?: unknown;
    };
    const status =
      body.status === 'open' ||
      body.status === 'acknowledged' ||
      body.status === 'resolved'
        ? (body.status as ReportIssueStatus)
        : null;

    if (!status) {
      res.status(400).json({
        error: 'Valid status required: open | acknowledged | resolved',
      });
      return;
    }

    const rawReason = body.resolutionReason;
    const resolutionReason =
      typeof rawReason === 'string' && rawReason.trim()
        ? (rawReason.trim() as ReportResolutionReason)
        : undefined;

    const resolutionNote =
      typeof body.resolutionNote === 'string'
        ? body.resolutionNote.trim()
        : null;

    if (status === 'resolved') {
      if (!resolutionReason) {
        res.status(400).json({
          error: 'resolutionReason is required when resolving a report.',
        });
        return;
      }
      if (!REPORT_RESOLUTION_REASONS.includes(resolutionReason)) {
        res.status(400).json({
          error: 'Invalid resolutionReason.',
        });
        return;
      }
    } else if (rawReason !== undefined && rawReason !== null) {
      if (!resolutionReason || !REPORT_RESOLUTION_REASONS.includes(resolutionReason)) {
        res.status(400).json({
          error: 'Invalid resolutionReason.',
        });
        return;
      }
    }

    try {
      const updated = await this.service.updateReportStatus(id, status, {
        resolutionReason,
        resolutionNote,
      });
      if (!updated) {
        res.status(404).json({ error: 'Report issue not found.' });
        return;
      }

      res.status(200).json({ ok: true, issue: updated, entry: updated, ...updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  }

  private async createAdminReportIssue(
    req: Request,
    res: Response,
  ): Promise<void> {
    const body = req.body as ReportBody;

    const title = typeof body.title === 'string' ? body.title : '';
    const description = typeof body.description === 'string' ? body.description : '';
    const category = typeof body.category === 'string' ? body.category : null;
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((id): id is string => typeof id === 'string')
      : [];
    const parsedMeta = parseLogMeta(body.meta);
    if (parsedMeta.error) {
      res.status(400).json({ error: parsedMeta.error });
      return;
    }

    try {
      const entry = await this.service.createByAdmin({
        title,
        description,
        category,
        attachmentIds,
        meta: parsedMeta.value,
      });
      res.status(201).json({ ok: true, reportIssueId: entry.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  }

  private getAdminAttachmentFile(req: Request, res: Response): void {
    const { attachmentId } = req.params as { attachmentId: string };
    const attachment = this.service.findAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: 'Attachment not found.' });
      return;
    }

    if (!this.service.isAttachmentInReportDir(attachment.filePath)) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }

    const absolute = path.resolve(attachment.filePath);
    res.type(attachment.contentType);
    res.sendFile(absolute, (err) => {
      if (err) res.status(404).json({ error: 'Image file not found on disk.' });
    });
  }
}
