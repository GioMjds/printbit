import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { DOCUMENT_CONVERSION_PIPE_NAME } from '@/config/http.config';

export interface DocumentConversionRequest {
  requestId: string;
  sourcePath: string;
  outputDirectory?: string;
  targetFormat?: string;
  timeoutSeconds?: number;
}

export interface DocumentConversionResult {
  requestId: string;
  success: boolean;
  outputPath?: string | null;
  pageCount?: number | null;
  sourceFormat?: string;
  durationMs: number;
  errorMessage?: string | null;
}

export interface ConvertDocumentOptions {
  outputDirectory?: string;
  timeoutSeconds?: number;
  pipeName?: string;
}

const DEFAULT_TIMEOUT_SECONDS = 60;
// Grace period on top of the worker's own conversion timeout so the client
// doesn't give up a moment before the worker would have responded.
const CLIENT_TIMEOUT_GRACE_MS = 5_000;

function toPipePath(pipeName: string): string {
  return pipeName.startsWith('\\\\.\\pipe\\')
    ? pipeName
    : `\\\\.\\pipe\\${pipeName}`;
}

export async function convertDocumentViaWorker(
  sourcePath: string,
  options?: ConvertDocumentOptions,
): Promise<DocumentConversionResult> {
  const pipeName = options?.pipeName ?? DOCUMENT_CONVERSION_PIPE_NAME;
  const pipePath = toPipePath(pipeName);
  const timeoutSeconds = options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000 + CLIENT_TIMEOUT_GRACE_MS;

  const request: DocumentConversionRequest = {
    requestId: randomUUID(),
    sourcePath,
    outputDirectory: options?.outputDirectory,
    targetFormat: 'pdf',
    timeoutSeconds,
  };

  return new Promise<DocumentConversionResult>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let socket: net.Socket;
    let connectAttempts = 0;
    const maxConnectAttempts = 3;
    let retryTimer: NodeJS.Timeout | null = null;

    const timeoutHandle = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `Document conversion timed out after ${timeoutSeconds}s waiting for the worker.`,
          ),
        ),
      );
    }, timeoutMs);

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (retryTimer) clearTimeout(retryTimer);
      socket?.removeAllListeners();
      socket?.destroy?.();
      fn();
    }

    function tryConnect(): void {
      if (settled) return;
      connectAttempts++;
      socket = net.connect(pipePath);

      socket.on('connect', () => {
        socket.write(JSON.stringify(request) + '\n', 'utf-8', (err) => {
          if (err) {
            settle(() =>
              reject(
                new Error(`Failed to send conversion request: ${err.message}`),
              ),
            );
          }
        });
      });

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) return;

        const line = buffer.slice(0, newlineIndex);
        settle(() => {
          try {
            resolve(JSON.parse(line) as DocumentConversionResult);
          } catch (parseError) {
            reject(
              new Error(
                `Document conversion service returned an unreadable response: ${
                  parseError instanceof Error
                    ? parseError.message
                    : String(parseError)
                }`,
              ),
            );
          }
        });
      });

      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (
          !settled &&
          connectAttempts < maxConnectAttempts &&
          (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EBUSY')
        ) {
          socket.removeAllListeners();
          socket.destroy();
          retryTimer = setTimeout(tryConnect, 500);
          return;
        }
        settle(() =>
          reject(
            new Error(
              `Document conversion service is offline (${pipePath}): ${err.message}`,
            ),
          ),
        );
      });

      socket.on('close', () => {
        settle(() =>
          reject(
            new Error(
              'Document conversion service closed the connection before responding.',
            ),
          ),
        );
      });
    }

    tryConnect();
  });
}
