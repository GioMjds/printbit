import path from 'node:path';
import fs from 'node:fs';
import { Router, Request, Response } from 'express';
import {
  requireAdminLocalAccess,
  requireAdminPin,
} from '@/middleware/admin-auth';
import { createRateLimit } from '@/middleware/rate-limit';
import { serializeForInlineScript } from '@/utils/helpers';
import { FeedbackService } from './feedback.service';
import type { FeedbackStatus, AdminQueueView } from './feedback.schema';

const FEEDBACK_PORTAL_DIR = path.resolve('src', 'public', 'feedback');
const FEEDBACK_PORTAL_ASSETS = new Set(['styles.css', 'app.js']);

const EXPIRED_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session Expired · PrintBit</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f2f5;margin:0;color:#333}
.c{background:#fff;border-radius:16px;padding:2rem;max-width:380px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.icon{font-size:2.5rem;margin-bottom:.75rem}h2{margin-bottom:.5rem;font-size:1.2rem}
p{color:#666;font-size:.9rem;line-height:1.5;margin-bottom:.25rem}</style></head>
<body><div class="c">
<div class="icon">⏰</div>
<h2>Session Expired</h2>
<p>This feedback link is no longer valid.</p>
<p>Please go back to the kiosk and scan a new QR code to leave your feedback.</p>
</div></body></html>`;

const FEEDBACK_PORTAL_TEMPLATE = fs.readFileSync(
  path.join(FEEDBACK_PORTAL_DIR, 'index.html'),
  'utf-8',
);

const feedbackPortalAssetRateLimit = createRateLimit({
  keyPrefix: 'feedback-portal-asset',
  windowMs: 60_000,
  max: 120,
  message: 'Too many requests. Please try again later.',
});

function renderFeedbackPortal(token?: string): string {
  if (!token) {
    return FEEDBACK_PORTAL_TEMPLATE.replace(
      '</head>',
      `<base href="/feedback/"></head>`,
    );
  }
  const safeTokenForScript = serializeForInlineScript(token);
  return FEEDBACK_PORTAL_TEMPLATE.replace(
    '</head>',
    `<base href="/feedback/${encodeURIComponent(token)}/"><script>window.feedbackToken=${safeTokenForScript};</script></head>`,
  );
}

export interface FeedbackControllerDeps {
  resolvePublicBaseUrl: (req: Request) => URL;
}

export class FeedbackController {
  public readonly router: Router;
  public readonly portalRouter: Router;

  constructor(
    private readonly feedbackService: FeedbackService,
    private readonly deps: FeedbackControllerDeps,
  ) {
    this.router = Router();
    this.portalRouter = Router();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    // API routes (mounted at /api/feedback)
    this.router.get('/qr-url', this.getFeedbackQrUrl);
    this.router.get('/url', this.getFeedbackQrUrl);
    this.router.post('/', this.submitDirectFeedback);
    this.router.post('/sessions', this.createSession);
    this.router.get('/sessions/by-token/:token', this.getSessionByToken);
    this.router.post('/sessions/:sessionId/submit', this.submitFeedback);

    // Portal routes (mounted at /feedback)
    this.portalRouter.get('/', this.serveDirectFeedbackPortal);
    this.portalRouter.get('/styles.css', this.serveDirectFeedbackAsset);
    this.portalRouter.get('/app.js', this.serveDirectFeedbackAsset);
    this.portalRouter.get('/:token', this.serveFeedbackPortal);
    this.portalRouter.get('/:token/:asset', feedbackPortalAssetRateLimit, this.serveFeedbackAsset);
  }

  // Public API routes
  private submitDirectFeedback = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const body = req.body as {
      comment?: unknown;
      category?: unknown;
      rating?: unknown;
      transactionRef?: unknown;
    };

    const comment = typeof body.comment === 'string' ? body.comment : '';
    const category = typeof body.category === 'string' ? body.category : null;
    const rating = typeof body.rating === 'number' ? body.rating : null;
    const rawTx = body.transactionRef ?? req.query.transactionRef;
    const transactionRef =
      typeof rawTx === 'string' && rawTx.trim() ? rawTx.trim() : null;

    try {
      const entry = await this.feedbackService.submitFeedback({
        comment,
        category,
        rating,
        transactionRef,
      });
      res.status(201).json({ ok: true, feedbackId: entry.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  };

  private getFeedbackQrUrl = (req: Request, res: Response): void => {
    try {
      const baseUrl = this.deps.resolvePublicBaseUrl(req);
      const url = new URL('/feedback', baseUrl).toString();
      res.json({ url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  };

  private createSession = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const baseUrl = this.deps.resolvePublicBaseUrl(req);
      const session = await this.feedbackService.createSession(baseUrl);
      res.json(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  };

  private getSessionByToken = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const { token } = req.params as { token: string };
    const session = await this.feedbackService.getSessionByToken(token);
    if (!session) {
      res.status(404).json({ error: 'Session not found or expired.' });
      return;
    }
    res.json({ sessionId: session.id, feedbackUrl: session.feedbackUrl });
  };

  private submitFeedback = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const { sessionId } = req.params as { sessionId: string };
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const body = req.body as {
      comment?: unknown;
      category?: unknown;
      rating?: unknown;
      transactionRef?: unknown;
    };

    const comment = typeof body.comment === 'string' ? body.comment : '';
    const category = typeof body.category === 'string' ? body.category : null;
    const rating = typeof body.rating === 'number' ? body.rating : null;
    const rawTx = body.transactionRef ?? req.query.transactionRef;
    const transactionRef =
      typeof rawTx === 'string' && rawTx.trim() ? rawTx.trim() : null;

    try {
      const entry = await this.feedbackService.submitFeedback({
        sessionId,
        token,
        comment,
        category,
        rating,
        transactionRef,
      });
      res.status(201).json({ ok: true, feedbackId: entry.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  };

  // Portal routes
  private serveDirectFeedbackPortal = (
    _req: Request,
    res: Response,
  ): void => {
    res.type('html').send(renderFeedbackPortal());
  };

  private serveFeedbackPortal = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const { token } = req.params as { token: string };
    const session = await this.feedbackService.getSessionByToken(token);
    if (!session) {
      res.status(410).type('html').send(EXPIRED_HTML);
      return;
    }
    try {
      const html = renderFeedbackPortal(token);
      res.send(html);
    } catch {
      res.status(500).send('Error loading feedback portal.');
    }
  };

  private serveDirectFeedbackAsset = (req: Request, res: Response): void => {
    const asset = req.path.replace(/^\//, '');
    this.sendAssetFile(asset, res);
  };

  private serveFeedbackAsset = (req: Request, res: Response): void => {
    const { asset } = req.params as { asset: string };
    this.sendAssetFile(asset, res);
  };

  private sendAssetFile = (asset: string, res: Response): void => {
    if (!FEEDBACK_PORTAL_ASSETS.has(asset)) {
      res.status(404).send('Not found.');
      return;
    }
    const filePath = path.join(FEEDBACK_PORTAL_DIR, asset);
    res.sendFile(filePath, (err) => {
      if (err) res.status(404).send('Asset not found.');
    });
  };

  // Admin routes - these are added to a separate router for /api/admin/feedback
  public createAdminRouter(): Router {
    const adminRouter = Router();

    adminRouter.get(
      '/',
      requireAdminLocalAccess,
      requireAdminPin,
      this.listFeedback,
    );

    adminRouter.patch(
      '/:id/resolve',
      requireAdminLocalAccess,
      requireAdminPin,
      this.toggleResolved,
    );

    adminRouter.patch(
      '/:id/status',
      requireAdminLocalAccess,
      requireAdminPin,
      this.patchFeedbackStatus,
    );

    adminRouter.post(
      '/archive-reviewed',
      requireAdminLocalAccess,
      requireAdminPin,
      this.archiveAllReviewedFeedback,
    );

    adminRouter.delete(
      '/:id',
      requireAdminLocalAccess,
      requireAdminPin,
      this.deleteFeedback,
    );

    adminRouter.delete(
      '/',
      requireAdminLocalAccess,
      requireAdminPin,
      this.clearFeedback,
    );

    adminRouter.get(
      '/export.csv',
      requireAdminLocalAccess,
      requireAdminPin,
      this.exportCsv,
    );

    return adminRouter;
  }

  // Admin handlers
  private listFeedback = (req: Request, res: Response): void => {
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

    const statusParam = req.query.status;
    const status: FeedbackStatus | undefined =
      statusParam === 'open' || statusParam === 'resolved'
        ? statusParam
        : undefined;

    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;

    const rawOffset = Number(req.query.offset ?? 0);
    const offset = Number.isFinite(rawOffset) ? rawOffset : 0;

    const result = this.feedbackService.listFeedback({
      status,
      view,
      limit,
      offset,
    });
    res.json(result);
  };

  private toggleResolved = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const { id } = req.params as { id: string };
    const body = req.body as { resolved?: unknown };
    const resolved = typeof body.resolved === 'boolean' ? body.resolved : true;

    const entry = await this.feedbackService.toggleResolved(id, resolved);
    if (!entry) {
      res.status(404).json({ error: 'Feedback entry not found.' });
      return;
    }
    res.json({ ok: true, entry });
  };

  private patchFeedbackStatus = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      status?: unknown;
      needsAction?: unknown;
      action?: unknown;
    };

    let entry = this.feedbackService.findFeedbackById(id);
    if (!entry) {
      res.status(404).json({ error: 'Feedback entry not found.' });
      return;
    }

    // 1. Validate action parameter
    if (body.action !== undefined) {
      if (typeof body.action !== 'string' || body.action !== 'archive') {
        res
          .status(400)
          .json({ error: 'Invalid action. Only "archive" is supported.' });
        return;
      }
    }

    // 2. Validate status parameter
    if (body.status !== undefined) {
      if (body.status !== 'new' && body.status !== 'reviewed') {
        res
          .status(400)
          .json({ error: 'Valid status required: new | reviewed' });
        return;
      }
    }

    // 3. Mutually exclusive check: action === 'archive' and status cannot be provided together
    if (body.action === 'archive' && body.status !== undefined) {
      res.status(400).json({
        error: 'Cannot set both action="archive" and status simultaneously.',
      });
      return;
    }

    // 4. Validate needsAction parameter if provided
    if (body.needsAction !== undefined && typeof body.needsAction !== 'boolean') {
      res.status(400).json({ error: 'needsAction must be a boolean.' });
      return;
    }

    // All validation passed. Apply mutations safely.
    if (body.action === 'archive') {
      entry = this.feedbackService.archiveFeedback(id);
    } else if (body.status !== undefined) {
      entry = this.feedbackService.updateFeedbackStatus(
        id,
        body.status as FeedbackStatus,
      );
    }

    if (body.needsAction !== undefined) {
      entry = this.feedbackService.setNeedsAction(
        id,
        Boolean(body.needsAction),
      );
    }

    if (!entry) {
      res.status(404).json({ error: 'Feedback entry not found.' });
      return;
    }

    res.json({ ok: true, entry, feedback: entry, ...entry });
  };

  private archiveAllReviewedFeedback = async (
    _req: Request,
    res: Response,
  ): Promise<void> => {
    const count = this.feedbackService.archiveAllReviewedFeedback();
    res.json({ ok: true, count });
  };

  private deleteFeedback = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const { id } = req.params as { id: string };
    const confirm = req.body?.confirm;
    if (confirm !== 'PURGE') {
      res.status(400).json({ error: 'Typed confirmation PURGE required.' });
      return;
    }

    const deleted = this.feedbackService.purgeFeedback(id, 'PURGE');
    if (!deleted) {
      res.status(404).json({ error: 'Feedback entry not found.' });
      return;
    }
    res.json({ ok: true });
  };

  private clearFeedback = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const confirm = req.body?.confirm;
    if (confirm !== 'PURGE') {
      res.status(400).json({ error: 'Typed confirmation PURGE required.' });
      return;
    }

    const count = this.feedbackService.purgeAllFeedback('PURGE');
    res.json({ ok: true, count });
  };

  private exportCsv = (req: Request, res: Response): void => {
    const items = this.feedbackService.listAllFeedback();
    const csv = this.feedbackService.feedbackToCsv(items);
    const date = new Date().toISOString().slice(0, 10);
    res
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="printbit-feedback-${date}.csv"`,
      )
      .send(csv);
  };
}
