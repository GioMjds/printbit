import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_PRINT_SCALING,
  type PrintScaling,
} from '../shared/print-configuration';

export type WorkerHandoffErrorCode =
  | 'WORKER_QUEUE_UNAVAILABLE'
  | 'WORKER_HANDOFF_FAILED';

export class WorkerHandoffError extends Error {
  constructor(
    public code: WorkerHandoffErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkerHandoffError';
  }
}

export async function handoffToWorker(input: {
  sourcePath: string;
  queueDir: string;
  transactionId: string;
  spoolerCorrelationKey: string;
  printSettings?: {
    copies?: number;
    color?: boolean;
    pageRange?: string | null;
    duplex?: boolean;
    orientation?: string | null;
    rotationDeg?: number;
    paperSize?: 'A4' | 'Letter' | 'Legal';
    quality?: 'standard' | 'high';
    scaling?: PrintScaling;
  };
}): Promise<{ targetPath: string; fileName: string }> {
  if (!input.queueDir || input.queueDir.trim().length === 0) {
    throw new WorkerHandoffError(
      'WORKER_QUEUE_UNAVAILABLE',
      'Worker queue directory is not configured',
    );
  }

  try {
    const stat = await fs.stat(input.queueDir);
    if (!stat.isDirectory()) {
      throw new WorkerHandoffError(
        'WORKER_QUEUE_UNAVAILABLE',
        'Worker queue path is not a directory',
        { queueDir: input.queueDir },
      );
    }
  } catch (error) {
    if (error instanceof WorkerHandoffError) {
      throw error;
    }

    throw new WorkerHandoffError(
      'WORKER_QUEUE_UNAVAILABLE',
      'Worker queue directory not found',
      { queueDir: input.queueDir },
    );
  }

  const ext = path.extname(input.sourcePath).toLowerCase();
  if (ext !== '.pdf') {
    throw new WorkerHandoffError(
      'WORKER_HANDOFF_FAILED',
      'Source file is not a PDF',
      { sourcePath: input.sourcePath },
    );
  }

  const safeSegment = (value: string) => value.replace(/[^a-zA-Z0-9-_]/g, '_');
  const baseName = `${safeSegment(input.transactionId)}_${safeSegment(input.spoolerCorrelationKey)}_${Date.now()}`;
  const fileName = `${baseName}${ext}`;
  const targetPath = path.join(input.queueDir, fileName);
  const tempPath = `${targetPath}.tmp`;
  const jsonPath = path.join(input.queueDir, `${baseName}.json`);

  try {
    // Write the PDF first via atomic temp+rename, then write the JSON sidecar
    // last. The C# worker watches for *.json files and immediately looks for a
    // matching *.pdf — writing the PDF first guarantees it is on disk when the
    // watcher picks up the JSON trigger.
    await fs.copyFile(input.sourcePath, tempPath);
    await fs.rename(tempPath, targetPath);

    const sidecar = {
      copies: input.printSettings?.copies ?? 1,
      color: input.printSettings?.color ?? false,
      pageRange: input.printSettings?.pageRange ?? null,
      duplex: input.printSettings?.duplex ?? false,
      orientation: input.printSettings?.orientation ?? null,
      rotationDeg: input.printSettings?.rotationDeg ?? 0,
      paperSize: input.printSettings?.paperSize ?? 'A4',
      quality: input.printSettings?.quality ?? 'standard',
      scaling: input.printSettings?.scaling ?? DEFAULT_PRINT_SCALING,
      schemaVersion: 2,
      transactionId: input.transactionId,
      spoolerCorrelationKey: input.spoolerCorrelationKey,
    };
    await fs.writeFile(jsonPath, JSON.stringify(sidecar), 'utf-8');

    return { targetPath, fileName };
  } catch {
    // Clean up partial files on failure
    for (const partial of [tempPath, targetPath, jsonPath]) {
      try {
        await fs.unlink(partial);
      } catch {
        // ignore cleanup errors
      }
    }

    throw new WorkerHandoffError(
      'WORKER_HANDOFF_FAILED',
      'Failed to hand off file to worker queue',
      { sourcePath: input.sourcePath, queueDir: input.queueDir },
    );
  }
}
