import type { Express, Request, Response } from 'express';
import { Server } from 'socket.io';
import path from 'node:path';
import fs from 'node:fs';
import { settlementService } from '@/services';
import { jobStore } from '../services/job-store';
import { db } from '../services/db';
import { adminService } from '../services/admin';
import {
  getAdapter,
  getScannerStatus,
  type ScannerCapabilities,
} from '../services/scanner';
import {
  createScanDownloadLink,
  resolveScanDownload,
} from '../services/scan-delivery';
import {
  exportScanToUsbDrive,
  listRemovableDrives,
} from '../services/usb-drives';
import { detectPdfColorContent } from '@/services/config';

const VALID_SOURCES = new Set(['adf', 'flatbed']);
const VALID_DPI = new Set([150, 300, 600]);
const VALID_COLOR_MODES = new Set(['colored', 'grayscale']);
const VALID_FORMATS = new Set(['pdf', 'jpg', 'png']);

const FORMAT_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

const CHARGED_SCAN_TTL_MS = 30 * 60 * 1000;
const chargedScanFiles = new Map<string, number>();

interface RegisterScanRoutesDeps {
  io: Server;
  resolvePublicBaseUrl: (req: Request) => URL;
}

type ScannerPageSource = 'feeder' | 'glass';
type ScannerPageColor = 'color' | 'grayscale';

function toSafeScanFilename(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const safe = path.basename(trimmed);
  return safe === trimmed ? safe : null;
}

function toScanSource(source: ScannerPageSource): 'flatbed' | 'adf' {
  return source === 'feeder' ? 'adf' : 'flatbed';
}

function toColorMode(color: ScannerPageColor): 'colored' | 'grayscale' {
  return color === 'grayscale' ? 'grayscale' : 'colored';
}

function markSoftCopyPaid(filename: string): void {
  chargedScanFiles.set(filename, Date.now() + CHARGED_SCAN_TTL_MS);
}

function clearSoftCopyPaid(filename: string): void {
  chargedScanFiles.delete(filename);
}

function isSoftCopyPaid(filename: string): boolean {
  const expiresAt = chargedScanFiles.get(filename);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    chargedScanFiles.delete(filename);
    return false;
  }
  return true;
}

function mapCapabilitiesForUi(caps: ScannerCapabilities | null): {
  sources: string[];
  colorModes: string[];
  dpiOptions: number[];
  duplex: boolean;
} {
  if (!caps) {
    return {
      sources: [],
      colorModes: [],
      dpiOptions: [150, 300, 600],
      duplex: false,
    };
  }
  return {
    sources: caps.sources,
    colorModes: caps.colorModes,
    dpiOptions: caps.dpiOptions,
    duplex: caps.duplex,
  };
}

export function registerScanRoutes(
  app: Express,
  deps: RegisterScanRoutesDeps,
): void {
  // ── GET /api/scanner/status — UI compatibility status endpoint ──────
  app.get('/api/scanner/status', async (_req: Request, res: Response) => {
    const runtime = getScannerStatus();
    const probeCaps = await getAdapter()
      .probe()
      .catch(() => null);
    const capabilities = mapCapabilitiesForUi(
      probeCaps ?? runtime.capabilities,
    );

    const connected =
      runtime.adapter === 'naps2' && Boolean(probeCaps?.available);
    const error = connected
      ? undefined
      : (runtime.lastError ??
        'Scanner unavailable. Check Epson driver, NAPS2 installation, and USB connection.');

    res.json({
      connected,
      name: connected ? runtime.deviceName : undefined,
      driver: runtime.driver,
      preferredName: runtime.preferredName,
      sources: capabilities.sources,
      colorModes: capabilities.colorModes,
      dpiOptions: capabilities.dpiOptions,
      duplex: capabilities.duplex,
      preflight: runtime.preflight,
      error,
    });
  });

  // ── POST /api/scanner/scan — UI compatibility scan endpoint ────────
  app.post('/api/scanner/scan', async (req: Request, res: Response) => {
    const { source, color, dpi } = req.body as {
      source?: ScannerPageSource;
      color?: ScannerPageColor;
      dpi?: string | number;
    };

    const runtime = getScannerStatus();
    if (runtime.adapter !== 'naps2') {
      return res.status(409).json({
        error:
          runtime.lastError ??
          'No scanner device is currently available. Please check your Epson scanner connection.',
      });
    }

    if (!source || (source !== 'feeder' && source !== 'glass')) {
      return res
        .status(400)
        .json({ error: 'Invalid source. Accepted: "feeder", "glass"' });
    }
    if (!color || (color !== 'color' && color !== 'grayscale')) {
      return res
        .status(400)
        .json({ error: 'Invalid color. Accepted: "color", "grayscale"' });
    }

    const safeDpi =
      typeof dpi === 'number'
        ? dpi
        : typeof dpi === 'string'
          ? Number(dpi)
          : NaN;
    if (!VALID_DPI.has(safeDpi)) {
      return res
        .status(400)
        .json({ error: 'Invalid dpi. Accepted: 150, 300, 600' });
    }

    const settings = {
      source: toScanSource(source),
      dpi: safeDpi,
      colorMode: toColorMode(color),
      duplex: false,
      format: 'jpg' as const,
    };

    try {
      const result = await getAdapter().scan(settings, 'uploads/scans');
      const filename = path.basename(result.outputPath);
      clearSoftCopyPaid(filename);

      void adminService.appendAdminLog(
        'scan_completed',
        'Interactive scan completed.',
        {
          source: settings.source,
          dpi: settings.dpi,
          colorMode: settings.colorMode,
          filename,
        },
      );

      await adminService.incrementJobStats('scan');

      res.json({
        pages: [`/api/scan/preview/${encodeURIComponent(filename)}`],
        filename,
        pageCount: result.pageCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown scan error';
      void adminService.appendAdminLog(
        'scan_failed',
        'Interactive scan failed.',
        {
          error: message,
          source: settings.source,
          dpi: settings.dpi,
          colorMode: settings.colorMode,
        },
      );
      res.status(500).json({ error: message });
    }
  });

  // ── POST /api/scanner/soft-copy/charge — Charge for soft copy access ───
  app.post(
    '/api/scanner/soft-copy/charge',
    async (req: Request, res: Response) => {
      const safeFilename = toSafeScanFilename(req.body?.filename);
      if (!safeFilename) {
        return res.status(400).json({ error: 'Invalid filename.' });
      }

      const sourcePath = path.resolve('uploads', 'scans', safeFilename);
      if (!fs.existsSync(sourcePath)) {
        return res.status(404).json({ error: 'Scanned file not found.' });
      }

      const requiredAmount = adminService.getPricingSettings().scanDocument;

      if (requiredAmount <= 0 || isSoftCopyPaid(safeFilename)) {
        return res.json({
          ok: true,
          charged: false,
          alreadyPaid: true,
          requiredAmount,
          amount: 0,
          balance: db.data!.balance,
        });
      }

      // Route through settlementService so change is dispensed on overpayment,
      // the balance lock is held atomically, and earnings are recorded correctly.
      const settlement = await settlementService.settle({
        requiredAmount,
        io: deps.io,
        jobContext: { mode: 'scan', filename: safeFilename },
      });

      if (!settlement.ok) {
        await adminService.appendAdminLog(
          'scan_soft_copy_charge_failed',
          'Failed to charge for soft copy access.',
          {
            filename: safeFilename,
            requiredAmount,
            balance: settlement.remainingBalance,
          },
        );

        const shortFall = Math.max(
          requiredAmount - settlement.remainingBalance,
          0,
        );

        return res.status(402).json({
          error: `Insufficient balance. Please add ₱${shortFall} to access this scan.`,
          requiredAmount,
          balance: settlement.remainingBalance,
        });
      }

      markSoftCopyPaid(safeFilename);

      await adminService.appendAdminLog(
        'scan_soft_copy_charged',
        'Soft copy access charged.',
        {
          filename: safeFilename,
          amount: settlement.chargedAmount,
          requiredAmount,
          balance: settlement.remainingBalance,
          changeState: settlement.change.state,
          changeRequested: settlement.change.requested,
          changeDispensed: settlement.change.dispensed,
        },
      );

      if (settlement.change.state === 'failed') {
        await adminService.appendAdminLog(
          'hopper_dispense_failed',
          'Coin change dispense failed after scan soft-copy charge.',
          {
            filename: safeFilename,
            requested: settlement.change.requested,
            dispensed: settlement.change.dispensed,
            attempts: settlement.change.attempts ?? 0,
            owedChangeId: settlement.change.owedChangeId ?? null,
            message: settlement.change.message ?? null,
          },
        );
      }

      return res.json({
        ok: true,
        charged: true,
        alreadyPaid: false,
        requiredAmount,
        amount: settlement.chargedAmount,
        balance: settlement.remainingBalance,
        change: settlement.change,
      });
    },
  );

  // ── GET /api/scanner/wired/drives — Detect removable USB drives ─────
  app.get('/api/scanner/wired/drives', async (_req: Request, res: Response) => {
    try {
      const drives = await listRemovableDrives();
      res.json({ drives });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not list USB drives.';
      res.status(500).json({ error: message });
    }
  });

  // ── POST /api/scanner/wired/export — Copy scan to USB drive ─────────
  app.post('/api/scanner/wired/export', async (req: Request, res: Response) => {
    const safeFilename = toSafeScanFilename(req.body?.filename);
    const drive = typeof req.body?.drive === 'string' ? req.body.drive : '';

    if (!safeFilename) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }

    const sourcePath = path.resolve('uploads', 'scans', safeFilename);
    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Scanned file not found.' });
    }

    try {
      const exported = await exportScanToUsbDrive(sourcePath, drive);
      await adminService.appendAdminLog(
        'scan_usb_exported',
        'Scanned file exported to USB.',
        {
          filename: safeFilename,
          drive: exported.drive,
          exportPath: exported.exportPath,
        },
      );
      res.json({
        ok: true,
        drive: exported.drive,
        exportPath: exported.exportPath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'USB export failed.';
      res.status(400).json({ error: message });
    }
  });

  // ── POST /api/scanner/wireless-link — Create temporary download link ─
  app.post('/api/scanner/wireless-link', (req: Request, res: Response) => {
    const safeFilename = toSafeScanFilename(req.body?.filename);
    if (!safeFilename) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }

    const sourcePath = path.resolve('uploads', 'scans', safeFilename);
    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Scanned file not found.' });
    }

    try {
      const link = createScanDownloadLink(
        sourcePath,
        deps.resolvePublicBaseUrl(req),
      );
      void adminService.appendAdminLog(
        'scan_wireless_link_created',
        'Wireless scan download link created.',
        {
          filename: safeFilename,
          expiresAt: link.expiresAt,
        },
      );
      res.json(link);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create link.';
      res.status(500).json({ error: message });
    }
  });

  // ── GET /scan/download/:token — Download scanned file by token ──────
  app.get('/scan/download/:token', (req: Request, res: Response) => {
    const token = String(req.params.token ?? '');
    const session = resolveScanDownload(token);
    if (!session) {
      return res.status(410).send('This scan download link has expired.');
    }

    const ext = path.extname(session.filename).slice(1).toLowerCase();
    const contentType = FORMAT_CONTENT_TYPES[ext] ?? 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${session.filename}"`,
    );
    res.sendFile(path.resolve(session.filePath));
  });

  // ── POST /api/scan/jobs — Start a scan job ─────────────────────────
  app.post('/api/scan/jobs', async (req: Request, res: Response) => {
    const { source, dpi, colorMode, duplex, format } = req.body as {
      source?: string;
      dpi?: number;
      colorMode?: string;
      duplex?: boolean;
      format?: string;
    };

    if (!source || !VALID_SOURCES.has(source)) {
      return res
        .status(400)
        .json({ error: 'Invalid source. Accepted: "adf", "flatbed"' });
    }
    if (typeof dpi !== 'number' || !VALID_DPI.has(dpi)) {
      return res
        .status(400)
        .json({ error: 'Invalid dpi. Accepted: 150, 300, 600' });
    }
    if (!colorMode || !VALID_COLOR_MODES.has(colorMode)) {
      return res
        .status(400)
        .json({ error: 'Invalid colorMode. Accepted: "colored", "grayscale"' });
    }
    if (typeof duplex !== 'boolean') {
      return res.status(400).json({ error: 'duplex must be a boolean' });
    }
    if (!format || !VALID_FORMATS.has(format)) {
      return res
        .status(400)
        .json({ error: 'Invalid format. Accepted: "pdf", "jpg", "png"' });
    }

    const settings = {
      source: source as 'adf' | 'flatbed',
      dpi,
      colorMode: colorMode as 'colored' | 'grayscale',
      duplex,
      format: format as 'pdf' | 'jpg' | 'png',
    };

    const job = jobStore.createScanJob(settings);

    void adminService.appendAdminLog('scan_job_created', 'Scan job created.', {
      jobId: job.id,
      source,
      dpi,
      colorMode,
      format,
    });

    // Start scan asynchronously
    void (async () => {
      jobStore.updateJobState(job.id, 'running');
      try {
        const result = await getAdapter().scan(settings, 'uploads/scans');
        jobStore.updateJobState(job.id, 'succeeded', {
          resultPath: result.outputPath,
        });
        await adminService.incrementJobStats('scan');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        jobStore.updateJobState(job.id, 'failed', {
          failure: {
            code: 'SCAN_ERROR',
            message,
            retryable: true,
            stage: 'running',
          },
        });
      }
    })();

    res.status(201).json(job);
  });

  // ── GET /api/scan/jobs/:id — Get scan job status ───────────────────
  app.get('/api/scan/jobs/:id', (req: Request, res: Response) => {
    const job = jobStore.getJob(req.params.id as string);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  });

  // ── GET /api/scan/jobs/:id/result — Download scan result ───────────
  app.get('/api/scan/jobs/:id/result', (req: Request, res: Response) => {
    const job = jobStore.getJob(req.params.id as string);
    if (!job || job.type !== 'scan') {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.state !== 'succeeded' || !job.resultPath) {
      return res.status(409).json({ error: 'Scan result is not ready' });
    }

    const absPath = path.resolve(job.resultPath);
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'Result file not found on disk' });
    }

    const contentType =
      FORMAT_CONTENT_TYPES[job.settings.format] ?? 'application/octet-stream';
    const filename = path.basename(absPath);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(absPath).pipe(res);
  });

  // ── POST /api/scan/preview — Quick preview scan for document detection ──
  app.post('/api/scan/preview', async (_req: Request, res: Response) => {
    console.log('[SCAN-PREVIEW] Starting copy pre-scan (300 DPI color)…');

    const previewSettings = {
      source: 'flatbed' as const,
      dpi: 300,
      colorMode: 'colored' as const,
      duplex: false,
      format: 'pdf' as const,
    };

    try {
      const result = await getAdapter().scan(previewSettings, 'uploads/scans');

      // Check the output file has meaningful content (> 1 KB suggests a real scan)
      const absPath = path.resolve(result.outputPath);
      const stat = fs.statSync(absPath);
      console.log(
        `[SCAN-PREVIEW] ✓ Preview scan complete: ${absPath} (${stat.size} bytes)`,
      );

      const filename = path.basename(result.outputPath);
      clearSoftCopyPaid(filename);
      res.json({
        detected: true,
        previewPath: filename,
        pageCount: result.pageCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[SCAN-PREVIEW] ✗ Preview scan failed: ${message}`);

      void adminService.appendAdminLog(
        'scan_preview_failed',
        'Preview scan failed.',
        {
          error: message,
        },
      );
      res.json({
        detected: false,
        error:
          'No document detected. Place your document face-down on the scanner glass and try again.',
      });
    }
  });

  // ── GET /api/scan/preview/:filename — Serve preview scan files ─────
  app.get('/api/scan/preview/:filename', (req: Request, res: Response) => {
    const filename = path.basename(req.params.filename as string);
    const absPath = path.resolve('uploads', 'scans', filename);

    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'Preview file not found' });
    }

    const ext = path.extname(filename).toLowerCase().replace('.', '');
    const contentType = FORMAT_CONTENT_TYPES[ext] ?? 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    fs.createReadStream(absPath).pipe(res);
  });

  app.get(
    '/api/scan/color-analysis/:filename',
    async (req: Request, res: Response) => {
      const filename = path.basename(req.params.filename as string);
      const absPath = path.resolve('uploads', 'scans', filename);

      if (!fs.existsSync(absPath)) {
        return res.json({
          hasColor: true,
          isGrayscale: false,
          sampledPages: 0,
        });
      }

      try {
        const result = await detectPdfColorContent(absPath);
        res.json({
          hasColor: result.hasColor,
          isGrayscale: !result.hasColor,
          sampledPages: result.sampledPages,
        });
      } catch {
        res.json({ hasColor: true, isGrayscale: false, sampledPages: 0 });
      }
    },
  );

  // ── POST /api/scan/jobs/:id/cancel — Cancel a scan job ────────────
  app.post('/api/scan/jobs/:id/cancel', (req: Request, res: Response) => {
    const job = jobStore.getJob(req.params.id as string);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const cancelled = jobStore.requestCancel(job.id);
    if (!cancelled) {
      return res
        .status(409)
        .json({ error: 'Job is already in a terminal state' });
    }

    getAdapter().cancel();
    res.status(202).json({ ok: true, state: 'cancel_requested' });
  });
}
