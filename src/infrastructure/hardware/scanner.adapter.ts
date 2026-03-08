import path from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  IScannerPort,
  ScanOptions,
  ScannerInfo,
} from '@/application/ports';
import { detectScanner, getAdapter, getScannerStatus } from '@/services';
import type { ScanJobSettings } from '@/services/job-store';

@Injectable()
export class ScannerAdapter implements IScannerPort {
  async probe(): Promise<ScannerInfo> {
    await detectScanner();
    const status = getScannerStatus();
    return {
      isAvailable: status.connected,
      deviceName: status.deviceName ?? undefined,
      error: status.lastError ?? undefined,
    };
  }

  async scan(options: ScanOptions): Promise<string> {
    const adapter = getAdapter();
    const outputDir = options.outputPath
      ? path.dirname(options.outputPath)
      : path.resolve('uploads', 'scans');

    const settings: ScanJobSettings = {
      source: options.source,
      dpi: options.dpi,
      colorMode: options.colorMode,
      duplex: false,
      format: options.format,
    };

    const result = await adapter.scan(settings, outputDir);
    return result.outputPath;
  }
}
