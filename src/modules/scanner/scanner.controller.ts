import path from 'node:path';
import fs from 'node:fs';
import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { USB_EXPORT_ENABLED } from '@/config';
import { createRateLimit } from '@/middleware/rate-limit';
import { adminService } from '@/services/admin';
import {
  powerSafetyService,
  type PowerSafetyService,
} from '@/services/power-safety';
import { ScannerService } from './scanner.service';
import { db } from '@/core/database/db';
import { formatCustomerScanFilename } from '@/services/scan-filename';

interface ScannerControllerDeps {
  io: SocketIOServer;
  resolvePublicBaseUrl: (req: Request) => URL;
  powerSafetyService?: PowerSafetyService;
}

type InteractiveScanBody = {
  source?: 'feeder' | 'glass';
  color?: 'color' | 'grayscale';
  dpi?: string | number;
  paperSize?: 'A4' | 'Letter' | 'Legal';
  format?: 'pdf' | 'jpg' | 'png';
};

type ScanJobBody = {
  source?: string;
  dpi?: number;
  colorMode?: string;
  duplex?: boolean;
  format?: string;
  paperSize?: string;
};

type ReleaseScanBody = {
  releaseToken?: string;
  reason?: string;
};

type WirelessLinkBody = {
  filename?: string;
  orientation?: 'portrait' | 'landscape';
  rotationDeg?: number;
};

const scanDownloadRateLimit = createRateLimit({
  keyPrefix: 'scan-download',
  windowMs: 60_000,
  max: 20,
});

const scanJobResultRateLimit = createRateLimit({
  keyPrefix: 'scan-job-result',
  windowMs: 60_000,
  max: 120,
});

const scanPreviewFileRateLimit = createRateLimit({
  keyPrefix: 'scan-preview-file',
  windowMs: 60_000,
  max: 40,
});

export class ScannerController {
  public readonly router: Router;
  private readonly powerSafety: PowerSafetyService;

  constructor(
    private readonly scannerService: ScannerService,
    private readonly deps: ScannerControllerDeps,
  ) {
    this.powerSafety = deps.powerSafetyService ?? powerSafetyService;
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.get('/api/scanner/status', this.getStatus);
    this.router.post('/api/scanner/scan', this.interactiveScan);
    this.router.post('/api/scanner/soft-copy/charge', this.chargeSoftCopy);
    this.router.get('/api/scanner/wired/drives', this.listDrives);
    this.router.post('/api/scanner/wired/export', this.exportToUsb);
    this.router.post('/api/scanner/wireless-link', this.createWirelessLink);
    this.router.post('/api/scanner/release', this.releaseScanFile);
    this.router.get('/scan/download/:token', scanDownloadRateLimit, this.downloadByToken);

    this.router.post('/api/scan/jobs', this.createScanJob);
    this.router.get('/api/scan/jobs/:id', this.getScanJob);
    this.router.get('/api/scan/jobs/:id/result', scanJobResultRateLimit, this.getScanJobResult);
    this.router.post('/api/scan/preview', this.previewScan);
    this.router.get('/api/scan/preview/:filename', scanPreviewFileRateLimit, this.getPreviewFile);
    this.router.get('/api/scan/color-analysis/:filename', this.getColorAnalysis);
    this.router.post('/api/scan/jobs/:id/cancel', this.cancelScanJob);
  }

  private getStatus = async (_req: Request, res: Response): Promise<void> => {
    const status = await this.scannerService.getStatus();
    res.json(status);
  };

  private interactiveScan = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    const body = (req.body ?? {}) as InteractiveScanBody;
    try {
      const result = await this.scannerService.interactiveScan({
        source: body.source as 'feeder' | 'glass',
        color: body.color as 'color' | 'grayscale',
        dpi: body.dpi as string | number,
        paperSize: body.paperSize as 'A4' | 'Letter' | 'Legal',
        format: body.format as 'pdf' | 'jpg' | 'png' | undefined,
      });
      res.json(result);
    } catch (error) {
      const message = this.getErrorMessage(error, 'Unknown scan error');

      if (message.includes('No scanner device is currently available')) {
        res.status(409).json({ error: message });
        return;
      }

      if (
        message.startsWith('Invalid source') ||
        message.startsWith('Invalid color') ||
        message.startsWith('Invalid dpi') ||
        message.startsWith('Invalid paperSize') ||
        message.startsWith('Invalid format')
      ) {
        res.status(400).json({ error: message });
        return;
      }

      void adminService.appendAdminLog('scan_failed', 'Interactive scan failed.', {
        error: message,
        source: body.source ?? null,
        dpi: body.dpi ?? null,
        colorMode: body.color === 'color' ? 'colored' : body.color ?? null,
      });

      res.status(500).json({ error: message });
    }
  };

  private chargeSoftCopy = async (req: Request, res: Response): Promise<void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    const safeFilename = this.scannerService.toSafeScanFilename(req.body?.filename);
    if (!safeFilename) {
      res.status(400).json({ error: 'Invalid filename.' });
      return;
    }

    try {
      const result = await this.scannerService.chargeSoftCopy({
        filename: safeFilename,
        io: this.deps.io,
        publicBaseUrl: this.deps.resolvePublicBaseUrl(req).toString(),
      });
      res.json(result);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'isTrustedTimeError' in error &&
        error.isTrustedTimeError
      ) {
        const payload =
          typeof error === 'object' && error !== null
            ? {
                code: 'code' in error ? error.code : 'TRUSTED_TIME_UNAVAILABLE',
                error:
                  'error' in error
                    ? error.error
                    : 'Scan soft-copy charging is temporarily unavailable because trusted time is not synchronized.',
                ...('trustedTime' in error ? { trustedTime: error.trustedTime } : {}),
              }
            : {
                code: 'TRUSTED_TIME_UNAVAILABLE',
                error:
                  'Scan soft-copy charging is temporarily unavailable because trusted time is not synchronized.',
              };

        await adminService.appendAdminLog(
          'trusted_time_unsynced',
          'Scan soft-copy charge blocked because trusted time is unavailable.',
          {
            detail: String(payload.error),
            mode: 'scan',
          },
        );
        res.status(503).json(payload);
        return;
      }

      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'INSUFFICIENT_BALANCE'
      ) {
        res.status(402).json({
          error: 'error' in error ? error.error : 'Insufficient balance.',
          requiredAmount:
            'requiredAmount' in error ? error.requiredAmount : undefined,
          balance: 'balance' in error ? error.balance : undefined,
        });
        return;
      }

      const message = this.getErrorMessage(error, 'Charging failed.');
      if (message === 'Scanned file not found.') {
        res.status(404).json({ error: message });
        return;
      }

      res.status(500).json({ error: message });
    }
  };

  private listDrives = async (_req: Request, res: Response): Promise<void> => {
    if (!USB_EXPORT_ENABLED) {
      this.sendUsbExportDisabled(res);
      return;
    }

    try {
      const drives = await this.scannerService.listRemovableDrives();
      res.json({ drives });
    } catch (error) {
      const message = this.getErrorMessage(error, 'Could not list USB drives.');
      res.status(500).json({ error: message });
    }
  };

  private exportToUsb = async (req: Request, res: Response): Promise<void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    if (!USB_EXPORT_ENABLED) {
      this.sendUsbExportDisabled(res);
      return;
    }

    const safeFilename = this.scannerService.toSafeScanFilename(req.body?.filename);
    const drive = typeof req.body?.drive === 'string' ? req.body.drive : '';

    if (!safeFilename) {
      res.status(400).json({ error: 'Invalid filename.' });
      return;
    }

    try {
      const exported = await this.scannerService.exportToUsb(safeFilename, drive);
      res.json(exported);
    } catch (error) {
      const message = this.getErrorMessage(error, 'USB export failed.');
      if (message === 'Scanned file not found.') {
        res.status(404).json({ error: message });
        return;
      }
      res.status(400).json({ error: message });
    }
  };

  private createWirelessLink = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    const body = req.body as WirelessLinkBody;
    const safeFilename = this.scannerService.toSafeScanFilename(body?.filename);
    if (!safeFilename) {
      res.status(400).json({ error: 'Invalid filename.' });
      return;
    }

    try {
      const link = await this.scannerService.createWirelessLink(
        safeFilename,
        this.deps.resolvePublicBaseUrl(req),
        {
          orientation: body?.orientation,
          rotationDeg: body?.rotationDeg,
        },
      );
      res.json(link);
    } catch (error) {
      const message = this.getErrorMessage(error, 'Failed to create link.');
      if (message === 'Scanned file not found.') {
        res.status(404).json({ error: message });
        return;
      }
      if (message.startsWith('Invalid rotation')) {
        res.status(400).json({ error: message });
        return;
      }
      if (message.startsWith('Rotation is not supported')) {
        res.status(409).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  };

  private releaseScanFile = async (req: Request, res: Response): Promise<void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    const body = req.body as ReleaseScanBody;
    const releaseToken =
      typeof body?.releaseToken === 'string' ? body.releaseToken.trim() : '';
    if (!releaseToken) {
      res.status(400).json({ error: 'Invalid release token.' });
      return;
    }

    const reason =
      typeof body?.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim()
        : null;

    try {
      const released = await this.scannerService.releaseScanFileByToken(
        releaseToken,
      );
      void adminService.appendAdminLog(
        'scan_file_released',
        'Transient scan file released.',
        {
          filename: released.fileName,
          reason,
          alreadyMissing: released.alreadyMissing,
        },
      );
      res.json({
        ok: true,
        deleted: released.deleted,
        alreadyMissing: released.alreadyMissing,
      });
    } catch (error) {
      const message = this.getErrorMessage(error, 'Failed to release scan file.');
      const invalidToken = message === 'Invalid release token.';
      const logCode = invalidToken ? 'scan_file_release_rejected' : 'scan_file_release_failed';
      const logMessage = invalidToken
        ? 'Rejected transient scan file release request.'
        : 'Failed to release transient scan file.';
      void adminService.appendAdminLog(
        logCode,
        logMessage,
        {
          reason,
          error: message,
        },
      );
      res.status(invalidToken ? 403 : 500).json({ error: message });
    }
  };

  private downloadByToken = (req: Request, res: Response): void => {
    const token = String(req.params.token ?? '');
    const session = this.scannerService.resolveDownload(token);
    if (!session) {
      res.status(410).send('This scan download link has expired.');
      return;
    }

    const ext = path.extname(session.filename).slice(1).toLowerCase();
    const contentType = this.scannerService.getContentType(ext);
    const customerFilename = formatCustomerScanFilename(
      db.data?.settings?.scanFilenameFormat,
      ext,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${customerFilename}"`,
    );
    res.sendFile(path.resolve(session.filePath));
  };

  private createScanJob = async (req: Request, res: Response): Promise<void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    const body = req.body as ScanJobBody;
    try {
      const settings = this.scannerService.validateScanJobInput({
        source: body.source ?? '',
        dpi: body.dpi as number,
        colorMode: body.colorMode ?? '',
        duplex: body.duplex as boolean,
        format: body.format ?? '',
        paperSize: body.paperSize ?? '',
      });
      const job = await this.scannerService.createScanJob(settings);
      res.status(201).json(job);
    } catch (error) {
      const message = this.getErrorMessage(error, 'Invalid scan job payload.');
      res.status(400).json({ error: message });
    }
  };

  private getScanJob = (req: Request, res: Response): void => {
    const jobId = String(req.params.id ?? '');
    const job = this.scannerService.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  };

  private getScanJobResult = (req: Request, res: Response): void => {
    const jobId = String(req.params.id ?? '');
    const job = this.scannerService.getJob(jobId);
    if (!job || job.type !== 'scan') {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (job.state !== 'succeeded' || !job.resultPath) {
      res.status(409).json({ error: 'Scan result is not ready' });
      return;
    }

    const result = this.scannerService.getJobResultPath(job.id);
    if (!result) {
      res.status(404).json({ error: 'Result file not found on disk' });
      return;
    }

    const contentType = this.scannerService.getContentType(job.settings.format);
    const filename = path.basename(result.absPath);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(result.absPath).pipe(res);
  };

  private previewScan = async (req: Request, res: Response): Promise<void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    const body = (req.body ?? {}) as {
      paperSize?: 'A4' | 'Letter' | 'Legal';
    };
    try {
      const preview = await this.scannerService.previewScan(
        body.paperSize as 'A4' | 'Letter' | 'Legal',
      );
      res.json(preview);
    } catch (error) {
      const message = this.getErrorMessage(error, 'Unknown scan preview error');
      if (message.startsWith('Invalid paperSize')) {
        res.status(400).json({ error: message });
        return;
      }
      throw error;
    }
  };

  private getPreviewFile = (req: Request, res: Response): void => {
    const filename = path.basename(String(req.params.filename ?? ''));
    const absPath = this.scannerService.getPreviewPath(filename);
    if (!absPath) {
      res.status(404).json({ error: 'Preview file not found' });
      return;
    }

    const ext = path.extname(filename).slice(1).toLowerCase();
    const contentType = this.scannerService.getContentType(ext);
    res.setHeader('Content-Type', contentType);
    fs.createReadStream(absPath).pipe(res);
  };

  private getColorAnalysis = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const filename = path.basename(String(req.params.filename ?? ''));
    const analysis = await this.scannerService.analyzeColor(filename);
    res.json(analysis);
  };

  private cancelScanJob = (req: Request, res: Response): void => {
    const jobId = String(req.params.id ?? '');
    const job = this.scannerService.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const cancelled = this.scannerService.cancelJob(job.id);
    if (!cancelled) {
      res.status(409).json({ error: 'Job is already in a terminal state' });
      return;
    }

    res.status(202).json({ ok: true, state: 'cancel_requested' });
  };

  private sendUsbExportDisabled(res: Response): void {
    res.status(423).json({
      code: 'USB_EXPORT_DISABLED',
      error:
        'USB export is disabled in kiosk lockdown mode. Use wireless QR download instead.',
    });
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }
}
