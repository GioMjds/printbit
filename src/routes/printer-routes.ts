import type { Express, Request, Response } from 'express';
import { getPrinterTelemetry } from '@/services';
import { BLOCKED_STATUSES } from '@/utils';

/**
 * Registers public (no-auth) printer status endpoints consumed by the kiosk
 * client UI. These are intentionally unauthenticated — the kiosk screen itself
 * is local-only and needs to check printer readiness before accepting coins.
 *
 * Socket.IO events (`printerMalfunction`, `printerRecovered`,
 * `printerStatusChanged`) handle real-time updates; this REST endpoint is used
 * for the initial page-load check and for manual re-polls after a page refresh.
 */
export function registerPrinterRoutes(app: Express) {
  app.get('/api/printer/status', async (req: Request, res: Response) => {
    const telemetry = getPrinterTelemetry();

    const blocked =
      !telemetry.connected || BLOCKED_STATUSES.has(telemetry.status);
    const ready = !blocked;

    res.set('Cache-Control', 'no-store');
    res.json({
      ready,
      blocked,
      connected: telemetry.connected,
      status: telemetry.status,
      statusFlags: telemetry.statusFlags,
      printerName: telemetry.name,
      lastCheckedAt: telemetry.lastCheckedAt,
    });
  });
}
