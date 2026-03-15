import path from 'node:path';
import fs from 'node:fs';
import type { Express, Request, Response } from 'express';
import {
  requireAdminLocalAccess,
  requireAdminPin,
} from '@/middleware/admin-auth';
import { feedbackService } from '@/services/feedback';
import type { FeedbackStatus } from '@/services/db';

const FEEDBACK_PORTAL_DIR = path.resolve('src/public/feedback');
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

function renderFeedbackPortal(token: string): string {
  return FEEDBACK_PORTAL_TEMPLATE.replace(
    '</head>',
    `<base href="/feedback/${encodeURIComponent(token)}/"><script>window.feedbackToken="${token}";</script></head>`,
  );
}

export function registerFeedbackRoutes(
  app: Express,
  deps: { resolvePublicBaseUrl: (req: Request) => URL },
) {
  app.post('/api/feedback/sessions', async (req: Request, res: Response) => {
    try {
      const baseUrl = deps.resolvePublicBaseUrl(req);
      const session = await feedbackService.createSession(baseUrl);
      res.json(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get(
    '/api/feedback/sessions/by-token/:token',
    async (req: Request, res: Response) => {
      const { token } = req.params as { token: string };
      const session = await feedbackService.getSessionByToken(token);
      if (!session) {
        return res.status(404).json({ error: 'Session not found or expired.' });
      }
      res.json({ sessionId: session.id, feedbackUrl: session.feedbackUrl });
    },
  );

  app.post(
    '/api/feedback/sessions/:sessionId/submit',
    async (req: Request, res: Response) => {
      const { sessionId } = req.params as { sessionId: string };
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const body = req.body as {
        comment?: unknown;
        category?: unknown;
        rating?: unknown;
      };

      const comment = typeof body.comment === 'string' ? body.comment : '';
      const category = typeof body.category === 'string' ? body.category : null;
      const rating = typeof body.rating === 'number' ? body.rating : null;

      try {
        const entry = await feedbackService.submitFeedback({
          sessionId,
          token,
          comment,
          category,
          rating,
        });
        res.status(201).json({ ok: true, feedbackId: entry.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: msg });
      }
    },
  );

  app.get('/feedback/:token', async (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    const session = await feedbackService.getSessionByToken(token);
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
  });

  app.get('/feedback/:token/:asset', (req: Request, res: Response) => {
    const { asset } = req.params as { asset: string };
    if (!FEEDBACK_PORTAL_ASSETS.has(asset)) {
      return res.status(404).send('Not found.');
    }
    const filePath = path.join(FEEDBACK_PORTAL_DIR, asset);
    res.sendFile(filePath, (err) => {
      if (err) res.status(404).send('Asset not found.');
    });
  });

  app.get(
    '/api/admin/feedback',
    requireAdminLocalAccess,
    requireAdminPin,
    (req: Request, res: Response) => {
      const statusParam = req.query.status;
      const status: FeedbackStatus | undefined =
        statusParam === 'open' || statusParam === 'resolved'
          ? statusParam
          : undefined;

      const rawLimit = Number(req.query.limit ?? 100);
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;

      const rawOffset = Number(req.query.offset ?? 0);
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;

      const result = feedbackService.listFeedback({ status, limit, offset });
      res.json(result);
    },
  );

  app.patch(
    '/api/admin/feedback/:id/resolve',
    requireAdminLocalAccess,
    requireAdminPin,
    async (req: Request, res: Response) => {
      const { id } = req.params as { id: string };
      const body = req.body as { resolved?: unknown };
      const resolved =
        typeof body.resolved === 'boolean' ? body.resolved : true;

      const entry = await feedbackService.toggleResolved(id, resolved);
      if (!entry) {
        return res.status(404).json({ error: 'Feedback entry not found.' });
      }
      res.json({ ok: true, entry });
    },
  );

  app.delete(
    '/api/admin/feedback/:id',
    requireAdminLocalAccess,
    requireAdminPin,
    async (req: Request, res: Response) => {
      const { id } = req.params as { id: string };
      const deleted = await feedbackService.deleteFeedback(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Feedback entry not found.' });
      }
      res.json({ ok: true });
    },
  );

  app.delete(
    '/api/admin/feedback',
    requireAdminLocalAccess,
    requireAdminPin,
    async (_req: Request, res: Response) => {
      const removed = await feedbackService.clearFeedback();
      res.json({ ok: true, removed });
    },
  );

  app.get(
    '/api/admin/feedback/export.csv',
    requireAdminLocalAccess,
    requireAdminPin,
    (req: Request, res: Response) => {
      const items = feedbackService.listAllFeedback();
      const csv = feedbackService.feedbackToCsv(items);
      const date = new Date().toISOString().slice(0, 10);
      res
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="printbit-feedback-${date}.csv"`,
        )
        .send(csv);
    },
  );
}
