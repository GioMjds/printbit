import fs from 'node:fs';
import path from 'node:path';
import { adminService } from './admin';

const QUARANTINE_DIR = path.resolve('uploads', 'quarantine');

async function ensureQuarantineDir(): Promise<void> {
  await fs.promises.mkdir(QUARANTINE_DIR, { recursive: true });
}

export interface QuarantineRecord {
  timestamp: string;
  originalName: string;
  sizeBytes: number;
  reason:
    | 'UNSUPPORTED_TYPE'
    | 'MAGIC_BYTE_MISMATCH'
    | 'FILE_INFECTED'
    | 'SCAN_ERROR';
  virusName?: string;
  savedAs: string;
}

export async function quarantineBuffer(
  buffer: Buffer,
  originalName: string,
  sizeBytes: number,
  reason: QuarantineRecord['reason'],
  virusName?: string,
): Promise<void> {
  try {
    await ensureQuarantineDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = path
      .basename(originalName)
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const savedAs = `${timestamp}__${safeName}`;
    const filePath = path.join(QUARANTINE_DIR, savedAs);

    // Write the raw buffer to quarantine — never process it further
    await fs.promises.writeFile(filePath, buffer);

    const record: QuarantineRecord = {
      timestamp: new Date().toISOString(),
      originalName,
      sizeBytes,
      reason,
      ...(virusName ? { virusName } : {}),
      savedAs,
    };

    await adminService.appendAdminLog(
      'file_quarantined',
      `File quarantined: ${reason}`,
      { record: JSON.stringify(record) },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[QUARANTINE] Failed to quarantine file: ${reason}`);
  }
}
