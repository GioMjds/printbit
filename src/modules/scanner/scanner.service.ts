import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  getAdapter,
  getScannerStatus,
  type ScannerCapabilities,
  type ScannerRuntimeStatus,
} from '@/services/scanner';
import {
  createScanDownloadLink,
  resolveScanDownload,
  type ScanDownloadLink,
} from '@/services/scan-delivery';
import {
  exportScanToUsbDrive,
  listRemovableDrives,
  type RemovableDrive,
} from '@/services/usb-drives';
import { analyzeDocument } from '@/services/document-analysis';
import { jobStore, type ScanJobSettings } from '@/services/job-store';
import { ReceiptService } from '@/modules/receipt/receipt.service';
import { adminService } from '@/services/admin';
import { db } from '@/services/db';
import { settlementService } from '@/services/settlement';
import { financialLedgerService } from '@/services/financial-ledger';
import {
  assertTrustedTimeForFinancialOperation,
  isTrustedTimeError,
} from '@/services/time-source';
import {
  deleteTransientScanFile,
  toSafeTransientScanFileName,
} from '@/services/transient-scan-file';
import {
  normalizeRotationDeg,
  parseRotationDeg,
  prepareScanRotationArtifact,
} from '@/services/document-rotation';
import type { Server as SocketIOServer } from 'socket.io';

const VALID_SOURCES = new Set(['adf', 'flatbed']);
const VALID_DPI = new Set([150, 300, 600]);
const VALID_COLOR_MODES = new Set(['colored', 'grayscale']);
const VALID_FORMATS = new Set(['pdf', 'jpg', 'png']);
const VALID_PAPER_SIZES = new Set(['A4', 'Letter', 'Legal']);

const FORMAT_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

const CHARGED_SCAN_TTL_MS = 30 * 60 * 1000;
const SCAN_RELEASE_TOKEN_TTL_MS = 45 * 60 * 1000;

type ScannerPageSource = 'feeder' | 'glass';
type ScannerPageColor = 'color' | 'grayscale';
type ScannerPaperSize = 'A4' | 'Letter' | 'Legal';

const toCopyPreviewSource = (
  paperSize: ScannerPaperSize,
): 'adf' | 'flatbed' =>
  paperSize === 'Legal' ? 'adf' : 'flatbed';

export interface ScannerStatusResponse {
  connected: boolean;
  name?: string;
  driver: string;
  preferredName: string;
  sources: string[];
  colorModes: string[];
  dpiOptions: number[];
  duplex: boolean;
  preflight: ScannerRuntimeStatus['preflight'];
  error?: string;
}

export interface InteractiveScanInput {
  source: ScannerPageSource;
  color: ScannerPageColor;
  dpi: string | number;
  paperSize: ScannerPaperSize;
  format?: 'pdf' | 'jpg' | 'png';
}

export interface InteractiveScanResult {
  pages: string[];
  filename: string;
  pageCount: number;
  releaseToken: string;
}

export interface SoftCopyChargeInput {
  filename: string;
  io: SocketIOServer;
  publicBaseUrl: string;
}

export interface SoftCopyChargeResult {
  ok: boolean;
  charged: boolean;
  alreadyPaid: boolean;
  requiredAmount: number;
  amount: number;
  balance: number;
  transactionId?: string;
  change?: {
    state: string;
    requested: number;
    dispensed: number;
  };
  receipt?: {
    viewUrl: string;
    expiresAt: string;
  };
  downloadLink?: ScanDownloadLink;
}

export interface UsbExportResult {
  ok: boolean;
  drive: string;
  exportPath: string;
}

export interface ScanJobInput {
  source: string;
  dpi: number;
  colorMode: string;
  duplex: boolean;
  format: string;
  paperSize: string;
}

export interface ColorAnalysisResult {
  hasColor: boolean;
  isGrayscale: boolean;
  sampledPages: number;
  coverage?: number;
  classification?: string;
}

export interface ScanFileReleaseResult {
  deleted: boolean;
  alreadyMissing: boolean;
  fileName: string;
}

interface ScanReleaseTokenRecord {
  filename: string;
  expiresAt: number;
}

interface ScanOutputTransformInput {
  orientation?: 'portrait' | 'landscape';
  rotationDeg?: number;
}

export class ScannerService {
  private readonly chargedScanFiles = new Map<string, number>();
  private readonly releaseTokens = new Map<string, ScanReleaseTokenRecord>();
  private readonly receiptService = new ReceiptService();

  toSafeScanFilename(raw: unknown): string | null {
    return toSafeTransientScanFileName(raw);
  }

  getContentType(ext: string): string {
    return (
      FORMAT_CONTENT_TYPES[ext.toLowerCase()] ?? 'application/octet-stream'
    );
  }

  private toScanSource(source: ScannerPageSource): 'flatbed' | 'adf' {
    return source === 'feeder' ? 'adf' : 'flatbed';
  }

  private toColorMode(color: ScannerPageColor): 'colored' | 'grayscale' {
    return color === 'grayscale' ? 'grayscale' : 'colored';
  }

  private markSoftCopyPaid(filename: string): void {
    this.chargedScanFiles.set(filename, Date.now() + CHARGED_SCAN_TTL_MS);
  }

  clearSoftCopyPaid(filename: string): void {
    this.chargedScanFiles.delete(filename);
  }

  private purgeExpiredReleaseTokens(now = Date.now()): void {
    for (const [token, record] of this.releaseTokens.entries()) {
      if (record.expiresAt <= now) {
        this.releaseTokens.delete(token);
      }
    }
  }

  private registerReleaseToken(filename: string): string {
    this.purgeExpiredReleaseTokens();
    const token = randomUUID();
    this.releaseTokens.set(token, {
      filename,
      expiresAt: Date.now() + SCAN_RELEASE_TOKEN_TTL_MS,
    });
    return token;
  }

  private consumeReleaseToken(
    releaseToken: string,
  ): ScanReleaseTokenRecord | null {
    this.purgeExpiredReleaseTokens();
    const record = this.releaseTokens.get(releaseToken);
    if (!record) {
      return null;
    }
    this.releaseTokens.delete(releaseToken);
    return record;
  }

  private invalidateReleaseTokensForFilename(filename: string): void {
    for (const [token, record] of this.releaseTokens.entries()) {
      if (record.filename === filename) {
        this.releaseTokens.delete(token);
      }
    }
  }

  private async applyScanOutputTransform(
    filename: string,
    transform?: ScanOutputTransformInput,
  ): Promise<string> {
    const sourcePath = path.resolve('uploads', 'scans', filename);
    if (!transform) return sourcePath;

    const orientation =
      transform.orientation === 'landscape' ? 'landscape' : 'portrait';

    if (
      typeof transform.rotationDeg !== 'undefined' &&
      parseRotationDeg(transform.rotationDeg) === null
    ) {
      throw new Error('Invalid rotation. Accepted values: 0, 90, 180, 270.');
    }
    const rotationDeg = normalizeRotationDeg(transform.rotationDeg, 0);

    const transformed = await prepareScanRotationArtifact({
      sourcePath,
      orientation,
      rotationDeg,
    });
    if (!transformed.transformed) return sourcePath;

    await fs.promises.copyFile(transformed.filePath, sourcePath);
    await fs.promises.unlink(transformed.filePath);
    return sourcePath;
  }

  private isSoftCopyPaid(filename: string): boolean {
    const expiresAt = this.chargedScanFiles.get(filename);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.chargedScanFiles.delete(filename);
      return false;
    }
    return true;
  }

  private mapCapabilitiesForUi(caps: ScannerCapabilities | null): {
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

  async getStatus(): Promise<ScannerStatusResponse> {
    const runtime = getScannerStatus();
    const probeCaps = await getAdapter()
      .probe()
      .catch(() => null);
    const capabilities = this.mapCapabilitiesForUi(
      probeCaps ?? runtime.capabilities,
    );

    const connected =
      (runtime.connected || runtime.usingStub) &&
      Boolean(probeCaps?.available ?? runtime.capabilities?.available);
    const error = connected
      ? undefined
      : (runtime.lastError ??
        'Scanner unavailable. Check Epson driver, NAPS2 installation, and USB connection.');

    return {
      connected,
      name: connected ? (runtime.deviceName ?? undefined) : undefined,
      driver: runtime.driver,
      preferredName: runtime.preferredName,
      sources: capabilities.sources,
      colorModes: capabilities.colorModes,
      dpiOptions: capabilities.dpiOptions,
      duplex: capabilities.duplex,
      preflight: runtime.preflight,
      error,
    };
  }

  async interactiveScan(
    input: InteractiveScanInput,
  ): Promise<InteractiveScanResult> {
    const { source, color, dpi, paperSize } = input;

    if (!source || (source !== 'feeder' && source !== 'glass')) {
      throw new Error('Invalid source. Accepted: "feeder", "glass"');
    }
    if (!color || (color !== 'color' && color !== 'grayscale')) {
      throw new Error('Invalid color. Accepted: "color", "grayscale"');
    }

    const safeDpi =
      typeof dpi === 'number'
        ? dpi
        : typeof dpi === 'string'
          ? Number(dpi)
          : NaN;
    if (!VALID_DPI.has(safeDpi)) {
      throw new Error('Invalid dpi. Accepted: 150, 300, 600');
    }
    if (!VALID_PAPER_SIZES.has(paperSize)) {
      throw new Error('Invalid paperSize. Accepted: "A4", "Letter", "Legal"');
    }

    const runtime = getScannerStatus();
    if (!runtime.connected && !runtime.usingStub) {
      throw new Error(
        runtime.lastError ??
          'No scanner device is currently available. Please check your Epson scanner connection.',
      );
    }

    if (input.format && !VALID_FORMATS.has(input.format)) {
      throw new Error('Invalid format. Accepted: "pdf", "jpg", "png"');
    }

    const scanFormat =
      input.format && VALID_FORMATS.has(input.format)
        ? (input.format as 'pdf' | 'jpg' | 'png')
        : 'pdf';

    const settings = {
      source: this.toScanSource(source),
      dpi: safeDpi,
      colorMode: this.toColorMode(color),
      duplex: false,
      format: scanFormat,
      paperSize,
    };

    const result = await getAdapter().scan(settings, 'uploads/scans');
    const filename = path.basename(result.outputPath);
    this.clearSoftCopyPaid(filename);

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

    return {
      pages: [`/api/scan/preview/${encodeURIComponent(filename)}`],
      filename,
      pageCount: result.pageCount,
      releaseToken: this.registerReleaseToken(filename),
    };
  }

  async chargeSoftCopy(
    input: SoftCopyChargeInput,
  ): Promise<SoftCopyChargeResult> {
    const { filename, io, publicBaseUrl } = input;

    const sourcePath = path.resolve('uploads', 'scans', filename);
    if (!fs.existsSync(sourcePath)) {
      throw new Error('Scanned file not found.');
    }

    const requiredAmount = adminService.getPricingSettings().scanDocument;

    if (requiredAmount <= 0 || this.isSoftCopyPaid(filename)) {
      let downloadLink: ScanDownloadLink | undefined;
      try {
        downloadLink = await this.createWirelessLink(
          filename,
          new URL(publicBaseUrl),
        );
      } catch {
        // Ignore link creation errors on already-paid path
      }
      return {
        ok: true,
        charged: false,
        alreadyPaid: true,
        requiredAmount,
        amount: 0,
        balance: db.data!.balance,
        downloadLink,
      };
    }

    try {
      assertTrustedTimeForFinancialOperation('scan_soft_copy_charge');
    } catch (error) {
      if (isTrustedTimeError(error)) {
        throw {
          code: error.code,
          error: `Scan soft-copy charging is temporarily unavailable: ${error.trustedTime.detail}`,
          trustedTime: {
            operation: error.operation,
            source: error.trustedTime.source,
            synced: error.trustedTime.synced,
            offsetMs: error.trustedTime.offsetMs,
            driftExceeded: error.trustedTime.driftExceeded,
            maxDriftMs: error.trustedTime.maxDriftMs,
            detail: error.trustedTime.detail,
            checkedAt: error.trustedTime.checkedAt,
            ntpSource: error.trustedTime.ntpSource,
          },
          isTrustedTimeError: true,
        };
      }
      throw {
        code: 'TRUSTED_TIME_UNAVAILABLE',
        error:
          'Scan soft-copy charging is temporarily unavailable because trusted time is not synchronized.',
        isTrustedTimeError: true,
      };
    }

    await financialLedgerService.append({
      eventType: 'job_started',
      amount: requiredAmount,
      referenceId: filename,
      meta: {
        mode: 'scan',
        filename,
      },
    });

    const settlement = await settlementService.settle({
      requiredAmount,
      io,
      jobContext: { mode: 'scan', filename },
    });

    if (!settlement.ok) {
      await adminService.appendAdminLog(
        'scan_soft_copy_charge_failed',
        'Failed to charge for soft copy access.',
        {
          filename,
          requiredAmount,
          balance: settlement.remainingBalance,
        },
      );

      const shortFall = Math.max(
        requiredAmount - settlement.remainingBalance,
        0,
      );

      throw {
        code: 'INSUFFICIENT_BALANCE',
        error: `Insufficient balance. Please add ₱${shortFall} to access this scan.`,
        requiredAmount,
        balance: settlement.remainingBalance,
      };
    }

    this.markSoftCopyPaid(filename);
    await financialLedgerService.append({
      eventType: 'job_completed',
      amount: settlement.chargedAmount,
      referenceId: filename,
      meta: {
        mode: 'scan',
        filename,
        changeState: settlement.change.state,
        changeRequested: settlement.change.requested,
        changeDispensed: settlement.change.dispensed,
      },
    });

    void adminService
      .appendAdminLog('scan_soft_copy_charged', 'Soft copy access charged.', {
        filename,
        amount: settlement.chargedAmount,
        requiredAmount,
        balance: settlement.remainingBalance,
        changeState: settlement.change.state,
        changeRequested: settlement.change.requested,
        changeDispensed: settlement.change.dispensed,
      })
      .catch(() => {});

    if (settlement.change.state === 'failed') {
      void adminService
        .appendAdminLog(
          'hopper_dispense_failed',
          'Coin change dispense failed after scan soft-copy charge.',
          {
            filename,
            requested: settlement.change.requested,
            dispensed: settlement.change.dispensed,
            attempts: settlement.change.attempts ?? 0,
            owedChangeId: settlement.change.owedChangeId ?? null,
            message: settlement.change.message ?? null,
          },
        )
        .catch(() => {});
    }

    // Generate receipt snapshot and mint token for scan charge
    const transactionId = `scan-${filename}-${randomUUID().slice(0, 8)}`;
    let receipt: { viewUrl: string; expiresAt: string } | undefined;
    try {
      this.receiptService.upsertReceiptSnapshot({
        transactionId,
        mode: 'print', // receipts use 'print' or 'copy'; scan uses 'print' as the closest mode
        chargedAmount: settlement.chargedAmount,
        coinsInserted: settlement.previousBalance,
        documentName: filename,
        printConfiguration: null,
        status: 'printed',
        change: {
          requested: settlement.change.requested,
          dispensed: settlement.change.dispensed,
          state:
            settlement.change.state === 'dispensed' ||
            settlement.change.state === 'failed'
              ? settlement.change.state
              : 'none',
          attempts: settlement.change.attempts ?? 0,
          owedChangeId: settlement.change.owedChangeId ?? null,
          message: settlement.change.message ?? null,
        },
        settledAt: new Date().toISOString(),
        terminalAt: new Date().toISOString(),
      });
      const tokenData = this.receiptService.mintToken(transactionId, {
        revokeExisting: true,
      });
      if (tokenData) {
        const encodedToken = encodeURIComponent(tokenData.token);
        receipt = {
          viewUrl: new URL(
            `/receipt/t/${encodedToken}`,
            publicBaseUrl,
          ).toString(),
          expiresAt: tokenData.expiresAt,
        };
      }
    } catch (receiptError) {
      console.error('[SCAN] Failed to generate receipt for scan charge.', {
        error:
          receiptError instanceof Error
            ? receiptError.message
            : String(receiptError),
        filename,
      });
    }

    let downloadLink: ScanDownloadLink | undefined;
    try {
      downloadLink = await this.createWirelessLink(
        filename,
        new URL(publicBaseUrl),
      );
    } catch (linkError) {
      console.error('[SCAN] Failed to generate download link for scan charge.', {
        error:
          linkError instanceof Error ? linkError.message : String(linkError),
        filename,
      });
    }

    return {
      ok: true,
      charged: true,
      alreadyPaid: false,
      requiredAmount,
      amount: settlement.chargedAmount,
      balance: settlement.remainingBalance,
      transactionId,
      change: settlement.change,
      receipt,
      downloadLink,
    };
  }

  async listRemovableDrives(): Promise<RemovableDrive[]> {
    return listRemovableDrives();
  }

  async exportToUsb(filename: string, drive: string): Promise<UsbExportResult> {
    const sourcePath = path.resolve('uploads', 'scans', filename);
    if (!fs.existsSync(sourcePath)) {
      throw new Error('Scanned file not found.');
    }

    const exported = await exportScanToUsbDrive(sourcePath, drive);
    await adminService.appendAdminLog(
      'scan_usb_exported',
      'Scanned file exported to USB.',
      {
        filename,
        drive: exported.drive,
        exportPath: exported.exportPath,
      },
    );

    return {
      ok: true,
      drive: exported.drive,
      exportPath: exported.exportPath,
    };
  }

  async createWirelessLink(
    filename: string,
    publicBaseUrl: URL,
    transform?: ScanOutputTransformInput,
  ): Promise<ScanDownloadLink> {
    const sourcePath = path.resolve('uploads', 'scans', filename);
    if (!fs.existsSync(sourcePath)) {
      throw new Error('Scanned file not found.');
    }

    await this.applyScanOutputTransform(filename, transform);
    const link = createScanDownloadLink(sourcePath, publicBaseUrl);
    void adminService.appendAdminLog(
      'scan_wireless_link_created',
      'Wireless scan download link created.',
      {
        filename,
        orientation:
          transform?.orientation === 'landscape' ? 'landscape' : 'portrait',
        rotationDeg: normalizeRotationDeg(transform?.rotationDeg, 0),
        expiresAt: link.expiresAt,
      },
    );
    return link;
  }

  resolveDownload(
    token: string,
  ): { filePath: string; filename: string } | null {
    const session = resolveScanDownload(token);
    if (!session) return null;
    return { filePath: session.filePath, filename: session.filename };
  }

  validateScanJobInput(input: ScanJobInput): ScanJobSettings {
    const { source, dpi, colorMode, duplex, format, paperSize } = input;

    if (!source || !VALID_SOURCES.has(source)) {
      throw new Error('Invalid source. Accepted: "adf", "flatbed"');
    }
    if (typeof dpi !== 'number' || !VALID_DPI.has(dpi)) {
      throw new Error('Invalid dpi. Accepted: 150, 300, 600');
    }
    if (!colorMode || !VALID_COLOR_MODES.has(colorMode)) {
      throw new Error('Invalid colorMode. Accepted: "colored", "grayscale"');
    }
    if (typeof duplex !== 'boolean') {
      throw new Error('duplex must be a boolean');
    }
    if (!format || !VALID_FORMATS.has(format)) {
      throw new Error('Invalid format. Accepted: "pdf", "jpg", "png"');
    }
    if (!VALID_PAPER_SIZES.has(paperSize)) {
      throw new Error('Invalid paperSize. Accepted: "A4", "Letter", "Legal"');
    }

    return {
      source: source as 'adf' | 'flatbed',
      dpi,
      colorMode: colorMode as 'colored' | 'grayscale',
      duplex,
      format: format as 'pdf' | 'jpg' | 'png',
      paperSize: paperSize as ScannerPaperSize,
    };
  }

  async createScanJob(settings: ScanJobSettings) {
    const job = jobStore.createScanJob(settings);

    void adminService.appendAdminLog('scan_job_created', 'Scan job created.', {
      jobId: job.id,
      source: settings.source,
      dpi: settings.dpi,
      colorMode: settings.colorMode,
      format: settings.format,
      paperSize: settings.paperSize,
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

    return job;
  }

  getJob(jobId: string) {
    return jobStore.getJob(jobId);
  }

  getJobResultPath(jobId: string): { absPath: string; format: string } | null {
    const job = jobStore.getJob(jobId);
    if (!job || job.type !== 'scan') return null;
    if (job.state !== 'succeeded' || !job.resultPath) return null;

    const absPath = path.resolve(job.resultPath);
    if (!fs.existsSync(absPath)) return null;

    return { absPath, format: job.settings.format };
  }

  async previewScan(paperSize: ScannerPaperSize): Promise<{
    detected: boolean;
    previewPath?: string;
    releaseToken?: string;
    pageCount?: number;
    error?: string;
  }> {
    if (!VALID_PAPER_SIZES.has(paperSize)) {
      throw new Error('Invalid paperSize. Accepted: "A4", "Letter", "Legal"');
    }

    console.log('[SCAN-PREVIEW] Starting copy pre-scan (300 DPI color)…');

    const previewSettings = {
      source: toCopyPreviewSource(paperSize),
      dpi: 300,
      colorMode: 'colored' as const,
      duplex: false,
      format: 'pdf' as const,
      paperSize,
    };

    try {
      const result = await getAdapter().scan(previewSettings, 'uploads/scans');

      const absPath = path.resolve(result.outputPath);
      const stat = fs.statSync(absPath);
      console.log(
        `[SCAN-PREVIEW] ✓ Preview scan complete: ${absPath} (${stat.size} bytes)`,
      );

      const filename = path.basename(result.outputPath);
      this.clearSoftCopyPaid(filename);

      return {
        detected: true,
        previewPath: filename,
        releaseToken: this.registerReleaseToken(filename),
        pageCount: result.pageCount,
      };
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

      return {
        detected: false,
        error:
          'No document detected. Place your document face-down on the scanner glass and try again.',
      };
    }
  }

  getPreviewPath(filename: string): string | null {
    const absPath = path.resolve('uploads', 'scans', filename);
    if (!fs.existsSync(absPath)) return null;
    return absPath;
  }

  async releaseScanFileByToken(
    releaseToken: string,
  ): Promise<ScanFileReleaseResult> {
    const token = typeof releaseToken === 'string' ? releaseToken.trim() : '';
    if (!token) {
      throw new Error('Invalid release token.');
    }

    const record = this.consumeReleaseToken(token);
    if (!record) {
      throw new Error('Invalid release token.');
    }

    const released = await deleteTransientScanFile(record.filename);
    this.clearSoftCopyPaid(record.filename);
    this.invalidateReleaseTokensForFilename(record.filename);
    return released;
  }

  async analyzeColor(filename: string): Promise<ColorAnalysisResult> {
    const absPath = path.resolve('uploads', 'scans', filename);

    if (!fs.existsSync(absPath)) {
      return { hasColor: true, isGrayscale: false, sampledPages: 0 };
    }

    try {
      const result = await analyzeDocument({
        filePath: absPath,
        filename: filename,
        contentType: this.getContentType(
          path.basename(filename).slice(1).toLowerCase(),
        ), // Scans are usually PDFs in this system
      });

      const firstPage = result.pages[0];
      return {
        hasColor: result.colorPages > 0,
        isGrayscale: result.colorPages === 0,
        sampledPages: result.pageCount,
        coverage: firstPage?.coverage,
        classification: firstPage?.classification,
      };
    } catch (error) {
      console.error('[scanner-service] Analysis failed:', error);
      return { hasColor: true, isGrayscale: false, sampledPages: 0 };
    }
  }

  cancelJob(jobId: string): boolean {
    const job = jobStore.getJob(jobId);
    if (!job) return false;

    const cancelled = jobStore.requestCancel(job.id);
    if (!cancelled) return false;

    getAdapter().cancel();
    return true;
  }
}
