import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { adminService } from './admin';
import {
  stagingQuotaManager,
  QUARANTINE_RETENTION_MS,
  MAX_QUARANTINE_BYTES,
  isPathContained,
} from './upload-staging';

const DEFAULT_QUARANTINE_DIR = path.resolve('uploads', 'quarantine');

export type QuarantineReason =
  | 'UNSUPPORTED_TYPE'
  | 'MAGIC_BYTE_MISMATCH'
  | 'OOXML_STRUCTURE_INVALID'
  | 'MACRO_DETECTED'
  | 'ACTIVE_CONTENT_DETECTED'
  | 'ZIP_BOMB_DETECTED'
  | 'FILE_INFECTED';

export interface QuarantineRecord {
  timestamp: string;
  originalName: string;
  sizeBytes: number;
  reason: QuarantineReason;
  savedAs: string;
  detectionName?: string | null;
}

export async function quarantineStagedUpload(
  file: Express.Multer.File | { path: string; originalname?: string; size?: number },
  reason: QuarantineReason,
  detectionName: string | null = null,
  customQuarantineDir?: string,
): Promise<void> {
  const targetDir = customQuarantineDir || DEFAULT_QUARANTINE_DIR;
  try {
    await fs.promises.mkdir(targetDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeFileId = randomUUID();
    const savedAs = `${timestamp}__${safeFileId}.quarantine`;
    const destinationPath = path.join(targetDir, savedAs);

    if (file.path && fs.existsSync(file.path)) {
      try {
        await fs.promises.rename(file.path, destinationPath);
      } catch {
        // Fallback for cross-device moves
        await fs.promises.copyFile(file.path, destinationPath);
        await fs.promises.unlink(file.path).catch(() => {});
      }
      stagingQuotaManager.release(file.path);
    }

    let sizeBytes = file.size ?? 0;
    if (sizeBytes === 0 && fs.existsSync(destinationPath)) {
      try {
        const stats = await fs.promises.stat(destinationPath);
        sizeBytes = stats.size;
      } catch {
        // ignore stat error
      }
    }

    const originalName = file.originalname ?? 'unknown';

    const record: QuarantineRecord = {
      timestamp: new Date().toISOString(),
      originalName,
      sizeBytes,
      reason,
      savedAs,
      detectionName: detectionName ?? null,
    };

    await adminService.appendAdminLog(
      'file_quarantined',
      `File quarantined: ${reason}${detectionName ? ` (${detectionName})` : ''}`,
      { record: JSON.stringify(record) },
    );

    // Bounded purge of quarantine directory
    await purgeQuarantine(targetDir);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[QUARANTINE] Failed to quarantine file: ${errorMsg}`);
  }
}

export async function quarantineBuffer(
  buffer: Buffer,
  originalName: string,
  sizeBytes: number,
  reason: QuarantineReason,
): Promise<void> {
  try {
    await fs.promises.mkdir(DEFAULT_QUARANTINE_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeFileId = randomUUID();
    const savedAs = `${timestamp}__${safeFileId}.quarantine`;
    const filePath = path.join(DEFAULT_QUARANTINE_DIR, savedAs);

    await fs.promises.writeFile(filePath, buffer);

    const record: QuarantineRecord = {
      timestamp: new Date().toISOString(),
      originalName,
      sizeBytes,
      reason,
      savedAs,
    };

    await adminService.appendAdminLog(
      'file_quarantined',
      `File quarantined: ${reason}`,
      { record: JSON.stringify(record) },
    );

    await purgeQuarantine(DEFAULT_QUARANTINE_DIR);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[QUARANTINE] Failed to quarantine buffer: ${errorMsg}`);
  }
}

export async function purgeQuarantine(
  quarantineDir = DEFAULT_QUARANTINE_DIR,
  retentionMs = QUARANTINE_RETENTION_MS,
  maxBytes = MAX_QUARANTINE_BYTES,
): Promise<number> {
  let purgedCount = 0;
  try {
    const exists = await fs.promises
      .access(quarantineDir)
      .then(() => true)
      .catch(() => false);
    if (!exists) return 0;

    const entries = await fs.promises.readdir(quarantineDir);
    const cutoff = Date.now() - retentionMs;

    interface FileInfo {
      path: string;
      mtimeMs: number;
      size: number;
    }

    const remainingFiles: FileInfo[] = [];

    // Phase 1: delete expired entries based on retention window
    for (const entry of entries) {
      const fullPath = path.join(quarantineDir, entry);
      if (!isPathContained(quarantineDir, fullPath)) continue;

      try {
        const stats = await fs.promises.stat(fullPath);
        if (stats.mtimeMs < cutoff) {
          await fs.promises.unlink(fullPath);
          purgedCount += 1;
        } else {
          remainingFiles.push({
            path: fullPath,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
          });
        }
      } catch {
        // ignore stat/unlink errors
      }
    }

    // Phase 2: if total size exceeds maxBytes, delete oldest entries first
    let totalBytes = remainingFiles.reduce((acc, f) => acc + f.size, 0);
    if (totalBytes > maxBytes) {
      remainingFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const file of remainingFiles) {
        if (totalBytes <= maxBytes) break;
        try {
          await fs.promises.unlink(file.path);
          totalBytes -= file.size;
          purgedCount += 1;
        } catch {
          // ignore unlink error
        }
      }
    }
  } catch {
    // ignore directory read errors
  }
  return purgedCount;
}

export async function listQuarantineRecords(
  quarantineDir = DEFAULT_QUARANTINE_DIR,
): Promise<string[]> {
  try {
    const exists = await fs.promises
      .access(quarantineDir)
      .then(() => true)
      .catch(() => false);
    if (!exists) return [];
    return await fs.promises.readdir(quarantineDir);
  } catch {
    return [];
  }
}
