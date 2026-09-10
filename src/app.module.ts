import type { Express } from 'express';
import type { Request } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import type { Namespace } from 'socket.io';
import type { SessionStore } from '@/services/session';
import {
  PUBLIC_PAGE_ROUTES,
  PORTAL_ASSETS,
  PORTAL_DIR,
  UPLOAD_DIR,
} from '@/config';
import { getHotspotConfig } from '@/services/hotspot';
import { powerSafetyService } from '@/services/power-safety';
import {
  createKioskAccessMiddleware,
  registerStaticAssets,
} from '@/middleware';
import { registerAdminModule } from '@/modules/admin';
import { registerFinancialModule } from '@/modules/financial';
import { registerPrinterModule } from '@/modules/printer';
import { registerScannerModule } from '@/modules/scanner';
import { registerCopyModule } from '@/modules/copy';
import { registerWirelessSessionModule } from '@/modules/wireless-session';
import { registerFeedbackModule } from '@/modules/feedback';
import { registerReportModule } from '@/modules/report';
import { registerReceiptModule } from '@/modules/receipt';
import { registerHotspotModule } from '@/modules/hotspot';
import { registerWatchdogModule } from '@/modules/watchdog';
import { registerHopperModule } from '@/modules/hopper';
import { registerAnomalyModule } from '@/modules/anomaly';
import { registerLanguageModule } from '@/modules/language';
import { registerUploadPortalModule } from '@/modules/upload-portal';
import { registerPageModule } from '@/modules/page';

export interface AppModuleDeps {
  io: SocketIOServer;
  sessionIo: Namespace;
  sessionStore: SessionStore;
  uploadDir?: string;
  getSerialStatus: () => {
    connected: boolean;
    portPath: string | null;
    lastError: string | null;
  };
  getHopperStatus: () => {
    connected: boolean;
    pending: boolean;
    portPath: string | null;
    lastError: string | null;
    lastSuccessAt: string | null;
  };
  runHopperSelfTest: () => Promise<{
    ok: boolean;
    amount: number;
    message: string;
    attempts: number;
    owedChangeId?: string;
  }>;
  resolvePublicBaseUrl: (req: Request) => URL;
  convertToPdfArtifact: (
    sourcePath: string,
    artifactPath: string,
  ) => Promise<string>;
}

/**
 * Register all application modules with the Express app.
 * This function is called from server.ts during startup.
 */
export function registerAppModules(app: Express, deps: AppModuleDeps): void {
  const requireKiosk = createKioskAccessMiddleware();
  app.use(
    [
      '/api/scanner',
      '/api/scan',
      '/api/copy',
      // Write-only printer endpoints require the kiosk cookie.
      // GET /api/printer/status is intentionally excluded — it is a
      // read-only probe called by kiosk pages (confirm, print, copy, scan)
      // on page load, before any coin interaction.  Guarding it causes a 403
      // on every non-bootstrapped browser, making the UI report "Printer not
      // ready" even when the printer is perfectly healthy.
      '/api/printer/preflight',
      '/api/printer/pause',
      '/api/printer/resume',
      '/api/printer/cancel-remaining',
      '/api/confirm-payment',
      '/api/balance/reset',
      '/api/balance/add-test-coin',
      '/api/hotspot/start',
      '/api/hotspot/stop',
      '/api/language',
      '/api/accessibility',
      '/print',
    ],
    requireKiosk,
  );
  // The tokenized GET /upload/:token portal is public. Only the legacy
  // upload API is kiosk-only, so protect it with a method-specific guard.
  app.post('/upload', requireKiosk);
  registerPageModule(app, {
    io: deps.io,
    sessionStore: deps.sessionStore,
    publicPageRoutes: PUBLIC_PAGE_ROUTES,
    resolvePublicBaseUrl: deps.resolvePublicBaseUrl,
  });

  registerAdminModule(app, {
    io: deps.io,
    uploadDir: deps.uploadDir ?? UPLOAD_DIR,
    getSerialStatus: deps.getSerialStatus,
    getHopperStatus: deps.getHopperStatus,
    runHopperSelfTest: deps.runHopperSelfTest,
  });
  registerFeedbackModule(app, {
    io: deps.io,
    resolvePublicBaseUrl: deps.resolvePublicBaseUrl,
  });
  registerReportModule(app, {
    io: deps.io,
    resolvePublicBaseUrl: deps.resolvePublicBaseUrl,
  });
  registerFinancialModule(app, {
    io: deps.io,
    sessionStore: deps.sessionStore,
    resolvePublicBaseUrl: deps.resolvePublicBaseUrl,
    powerSafetyService,
  });
  registerReceiptModule(app);
  registerUploadPortalModule(app, {
    io: deps.io,
    portalDir: PORTAL_DIR,
    portalAssets: PORTAL_ASSETS,
    sessionStore: deps.sessionStore,
  });
  registerWirelessSessionModule(app, {
    io: deps.io,
    sessionIo: deps.sessionIo,
    sessionStore: deps.sessionStore,
    resolvePublicBaseUrl: deps.resolvePublicBaseUrl,
    convertToPdfArtifact: deps.convertToPdfArtifact,
    powerSafetyService,
  });
  registerScannerModule(app, {
    io: deps.io,
    resolvePublicBaseUrl: deps.resolvePublicBaseUrl,
    powerSafetyService,
  });
  registerCopyModule(app, {
    io: deps.io,
    resolvePublicBaseUrl: deps.resolvePublicBaseUrl,
    powerSafetyService,
  });
  registerPrinterModule(app, {
    io: deps.io,
    sessionStore: deps.sessionStore,
  });
  registerLanguageModule(app, { io: deps.io });

  registerHotspotModule(app);
  registerWatchdogModule(app);
  registerHopperModule(app, { io: deps.io });
  registerAnomalyModule(app, { io: deps.io });

  // Page and API routes must run before static-file lookup. In particular,
  // this prevents a public directory index from serving a kiosk-only page
  // before its authorization middleware. Tokenized upload pages are explicit
  // routes registered above and remain public by design.
  registerStaticAssets(app);

  // Keep legacy endpoint contract: /api/config/hotspot
  app.get('/api/config/hotspot', (_req, res) => {
    res.json(getHotspotConfig());
  });
}
