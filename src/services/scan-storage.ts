import fs from 'node:fs';
import path from 'node:path';

const SCAN_DIR = path.resolve('uploads', 'scans');
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const parsedRetention = Number(process.env.PRINTBIT_SCAN_FILE_RETENTION_MS);
const RETENTION_MS =
  Number.isFinite(parsedRetention) && parsedRetention > 0
    ? parsedRetention
    : DEFAULT_RETENTION_MS;

class ScanStorageService {
  private async cleanup(): Promise<void> {
    await fs.promises.mkdir(SCAN_DIR, { recursive: true });
    const entries = await fs.promises.readdir(SCAN_DIR, {
      withFileTypes: true,
    });
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(SCAN_DIR, entry.name);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (now - stat.mtimeMs <= RETENTION_MS) continue;
        await fs.promises.unlink(fullPath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[SCAN-STORAGE] Failed cleanup for ${fullPath}: ${message}`,
        );
      }
    }
  }

  startCleanup(): void {
    void this.cleanup();
    const timer = setInterval(() => {
      void this.cleanup();
    }, CLEANUP_INTERVAL_MS);
    timer.unref?.();
  }
}

export const scanStorageService = new ScanStorageService();

export function startScanStorageCleanup(): void {
  scanStorageService.startCleanup();
}
