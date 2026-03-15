import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type { SessionStore } from '@/services/session';
import { adminService } from '@/services/admin';

interface RegisterUploadPortalRoutesDeps {
  portalDir: string;
  portalAssets: Set<string>;
  renderUploadPortal: (token: string, portalHtmlPath: string) => string;
  sessionStore: SessionStore;
}

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
<p>This upload link is no longer valid.</p>
<p>Please go back to the kiosk and start a new print session to get a fresh QR code.</p>
</div></body></html>`;

export function registerUploadPortalRoutes(
  app: Express,
  deps: RegisterUploadPortalRoutesDeps,
) {
  app.get('/upload/:token', (req: Request, res: Response) => {
    try {
      const { token } = req.params as { token: string };

      // Validate token before rendering the upload page
      if (!deps.sessionStore.isTokenValid(token)) {
        void adminService.appendAdminLog(
          'upload_page_rejected',
          'Upload page hit with invalid/expired token.',
          {
            tokenPrefix: token.slice(0, 8),
          },
        );
        res.status(410).type('html').send(EXPIRED_HTML);
        return;
      }

      const html = deps.renderUploadPortal(
        token,
        path.join(deps.portalDir, 'index.html'),
      );
      res.send(html);
    } catch (error) {
      console.error('Error rendering upload portal:', error);
      res.status(500).send('Error loading upload portal');
    }
  });

  app.get('/upload/:token/:asset', (req: Request, res: Response) => {
    const { asset } = req.params as { asset: string };

    if (!deps.portalAssets.has(asset)) {
      return res.status(404).send('Not found.');
    }

    const filePath = path.join(deps.portalDir, asset);
    res.sendFile(filePath, (err) => {
      if (err) res.status(404).send('Asset not found.');
    });
  });
}
