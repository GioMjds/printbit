import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** File name of the bundled worker entry, next to the server bundle. */
export const ANALYSIS_WORKER_SCRIPT_NAME = 'document-analysis-worker.js';

/** The part of an analysis request that can be copied to a worker thread. */
export interface AnalysisWorkerInput {
  filePath: string;
  contentType?: string;
  filename?: string;
  colorDetectionEnabled?: boolean;
  originalFileType?: string;
}

export type AnalysisWorkerMessage<T> =
  | { type: 'success'; result: T }
  | { type: 'error'; message: string };

/**
 * The worker thread itself failed (could not start, crashed, or exited
 * without answering). This says nothing about the document, so the caller
 * may run the analysis on its own thread instead.
 */
export class AnalysisWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisWorkerUnavailableError';
  }
}

const WORKER_ANALYZABLE_EXTENSIONS = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
]);

/**
 * PDFs and images are analyzed from the file alone. Office files need a
 * conversion first, and a caller-supplied converter is a function that cannot
 * be sent to another thread, so those stay on the calling thread.
 */
export function canAnalyzeInWorker(
  input: AnalysisWorkerInput & { convertToPdfPreview?: unknown },
): boolean {
  if (input.convertToPdfPreview) return false;
  return WORKER_ANALYZABLE_EXTENSIONS.has(
    path.extname(input.filePath).toLowerCase(),
  );
}

/**
 * Runs one analysis in a fresh worker thread and resolves with its result.
 *
 * Rendering every page of a PDF is CPU-bound. Doing it on the main thread
 * stalls coin events, sockets and HTTP for the length of the document.
 *
 * Rejects with the worker's own error message when the analysis failed, and
 * with AnalysisWorkerUnavailableError when the thread itself failed.
 */
export function runAnalysisInWorker<T>(
  scriptPath: string,
  input: AnalysisWorkerInput,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };

    let worker: Worker;
    try {
      worker = new Worker(scriptPath, {
        workerData: {
          filePath: input.filePath,
          contentType: input.contentType,
          filename: input.filename,
          colorDetectionEnabled: input.colorDetectionEnabled,
          originalFileType: input.originalFileType,
        },
      });
    } catch (error) {
      reject(
        new AnalysisWorkerUnavailableError(
          `Analysis worker could not start: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
      return;
    }

    worker.once('message', (message: AnalysisWorkerMessage<T>) => {
      if (message?.type === 'success') {
        settle(() => resolve(message.result));
      } else {
        settle(() =>
          reject(
            new Error(
              message?.type === 'error' && message.message
                ? message.message
                : 'Document analysis failed.',
            ),
          ),
        );
      }
      void worker.terminate();
    });

    worker.once('error', (error) => {
      settle(() =>
        reject(
          new AnalysisWorkerUnavailableError(
            `Analysis worker crashed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        ),
      );
    });

    worker.once('exit', (code) => {
      settle(() =>
        reject(
          new AnalysisWorkerUnavailableError(
            `Analysis worker exited with code ${code} before answering.`,
          ),
        ),
      );
    });
  });
}
