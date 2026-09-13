import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { WORKER_QUEUE_DIR } from '@/config';
import { handoffToWorker } from './worker-handoff';
import { printerStateProjection } from './printer-state-projection';
import type { RotationDeg } from './document-rotation';
import type { PrintQuality } from '@/core/database/shared.schema';
import {
  DEFAULT_PRINT_SCALING,
  type PrintScaling,
  type PaperSize,
  type Orientation,
} from '../shared/print-configuration';

export class PrintDispatchError extends Error {
  readonly result: {
    failureCode?: string | null;
    message?: string;
    requiredCapabilities?: string[];
    requestedOptions?: any;
    [key: string]: any;
  };
  constructor(
    message: string,
    result: {
      failureCode?: string | null;
      message?: string;
      requiredCapabilities?: string[];
      requestedOptions?: any;
      [key: string]: any;
    } = {},
  ) {
    super(message);
    this.name = 'PrintDispatchError';
    this.result = result;
  }
}

export function assertPrintDispatcherReady(): void {}

export interface PrintDispatchContext {
  transactionId?: string | null;
  sessionId?: string | null;
  documentId?: string | null;
  spoolerCorrelationKey?: string | null;
  mode?: 'print' | 'copy' | 'admin-test' | 'legacy-print';
  source?: string | null;
}

export interface PrintDispatchResult {
  success: boolean;
  selectedEngine?: any;
  mode?: any;
  requestedMode?: any;
  fileExtension?: string;
  mimeType?: string;
  requestedOptions?: any;
  requiredCapabilities?: any;
  attempts?: any[];
  durationMs?: number;
  failureCode?: string | null;
  fileName?: string;
}

export type ColorMode = 'colored' | 'grayscale';
export type { Orientation, PaperSize } from '../shared/print-configuration';

export interface PrintJobOptions {
  copies: number;
  colorMode: ColorMode;
  orientation: Orientation;
  rotationDeg?: RotationDeg;
  paperSize: PaperSize;
  pageRange?: string;
  duplex?: boolean;
  printerName?: string;
  quality?: PrintQuality;
  scaling?: PrintScaling;
}

export class PrinterService {
  async detectDefaultPrinter(): Promise<void> {
    console.log(
      '[PRINTER] -- Detecting default printer ------------------------',
    );

    const snapshot = printerStateProjection.getSnapshot();
    if (snapshot.name) {
      console.log('[PRINTER] Default printer from worker projection:');
      console.log(`[PRINTER]   Name: ${snapshot.name}`);
      console.log(`[PRINTER]   Status: ${snapshot.status}`);
      console.log(`[PRINTER]   Connected: ${snapshot.connected}`);
    } else {
      console.log('[PRINTER] No printer connected in worker projection.');
    }
  }

  async printFile(
    filename: string,
    options: PrintJobOptions,
    context: PrintDispatchContext = {},
  ): Promise<PrintDispatchResult> {
    const uploadsDir = path.resolve('uploads');
    const normalizedFilename = filename.trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(normalizedFilename)) {
      throw new Error('Invalid filename');
    }
    const VALID_UPLOAD_FILENAME =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/i;

    if (!VALID_UPLOAD_FILENAME.test(normalizedFilename)) {
      throw new Error('Invalid filename');
    }

    if (path.basename(normalizedFilename) !== normalizedFilename) {
      throw new Error('Invalid filename');
    }
    const safeFilename = path.basename(normalizedFilename);
    const filePath = path.join(uploadsDir, safeFilename);
    const relativePath = path.relative(uploadsDir, filePath);
    const outsideUploads =
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath);
    if (outsideUploads) {
      throw new Error('Invalid filename');
    }

    const fileExists = fs.existsSync(filePath);
    if (fileExists && !fs.statSync(filePath).isFile()) {
      throw new Error('Invalid filename');
    }
    if (fileExists) {
      const realUploadsDir = fs.realpathSync(uploadsDir);
      const realFilePath = fs.realpathSync(filePath);
      const realRelative = path.relative(realUploadsDir, realFilePath);
      const realOutsideUploads =
        realRelative === '..' ||
        realRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelative);
      if (realOutsideUploads) {
        throw new Error('Invalid filename');
      }
    }
    if (!fileExists) {
      throw new Error(`File not found: ${filePath}`);
    }

    const spoolerCorrelationKey = context.spoolerCorrelationKey || randomUUID();
    const transactionId = context.transactionId || randomUUID();
    const queueDir =
      WORKER_QUEUE_DIR || path.resolve('../printbit-worker/queue');

    const handoffResult = await handoffToWorker({
      sourcePath: filePath,
      queueDir,
      transactionId,
      spoolerCorrelationKey,
      printSettings: {
        copies: options.copies,
        color: options.colorMode === 'colored',
        orientation: options.orientation,
        rotationDeg: options.rotationDeg ?? 0,
        paperSize: options.paperSize,
        pageRange: options.pageRange,
        duplex: options.duplex,
        quality: options.quality,
        scaling: options.scaling ?? DEFAULT_PRINT_SCALING,
      },
    });

    return {
      success: true,
      fileName: handoffResult.fileName,
    } as unknown as PrintDispatchResult;
  }
}

export const printerService = new PrinterService();
export const detectDefaultPrinter =
  printerService.detectDefaultPrinter.bind(printerService);
export const printFile = printerService.printFile.bind(printerService);
