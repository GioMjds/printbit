import net from 'node:net';

export type WorkerCommandType =
  | 'SimulateCoin'
  | 'cancel_job'
  | 'pause_job'
  | 'resume_job'
  | 'DispenseCoins'
  | 'LockCoinSlot'
  | 'UnlockCoinSlot'
  | 'AnnounceKioskIp'
  | 'GetScannerStatus'
  | 'ProbeScanner'
  | 'StartScan'
  | 'CancelScan'
  | 'GetDefenderHealth'
  | 'ScanFileSecurity'
  | 'ListUsbDrives'
  | 'ExportScanToUsb'
  | 'GetTrustedTimeStatus'
  | 'PrepareHotspotPlatform';

export interface WorkerCommandPayload {
  type: WorkerCommandType;
  protocolVersion?: 2;
  commandId?: string;
  transactionId?: string;
  spoolerCorrelationKey?: string;
  reason?: string;
  timestampUtc?: string;
  requestId?: string;
  coinCount?: number;
  timeoutMs?: number;
  ownerId?: string;
  ip?: string;
  port?: number;
  path?: string;
  filePath?: string;
  sourcePath?: string;
  drive?: string;
  ntpServer?: string | null;
  maxDriftMs?: number;
  preferredSubnetPrefixes?: string[];
  [key: string]: unknown;
}

export interface SendWorkerCommandOptions {
  pipeName?: string;
  timeoutMs?: number;
  connectRetry?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  logger?: Pick<Console, 'warn' | 'error' | 'log'>;
}

export interface WorkerHardwareResponse {
  requestId?: string;
  type?: string;
  success: boolean;
  dispensedCoins?: number;
  unlocked?: boolean;
  errorCode?: string | null;
  message?: string | null;
  [key: string]: unknown;
}

const RETRYABLE_CONNECT_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'EBUSY']);

function getErrorCode(error: Error): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export async function sendWorkerRequest<TResponse = WorkerHardwareResponse>(
  payload: Record<string, unknown>,
  options?: SendWorkerCommandOptions,
): Promise<TResponse | null> {
  const pipeName = options?.pipeName ?? 'printbit-worker-commands';
  const timeoutMs = options?.timeoutMs ?? 15000;
  const initialRetryDelayMs = Math.max(
    1,
    options?.connectRetry?.initialDelayMs ?? 50,
  );
  const maxRetryDelayMs = Math.max(
    initialRetryDelayMs,
    options?.connectRetry?.maxDelayMs ?? 500,
  );
  const logger = options?.logger ?? console;
  const pipePath = pipeName.startsWith('\\\\.\\pipe\\')
    ? pipeName
    : `\\\\.\\pipe\\${pipeName}`;

  let frame: string;
  try {
    frame = `${JSON.stringify(payload)}\n`;
  } catch (err) {
    logger.warn(
      `[WORKER_COMMAND_PIPE] Serialization failure: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  return new Promise<TResponse | null>((resolve) => {
    const startedAt = Date.now();
    const deadlineAt = startedAt + timeoutMs;
    let attempts = 0;
    let resolved = false;
    let activeSocket: net.Socket | null = null;
    let retryTimer: NodeJS.Timeout | null = null;

    const finish = (result: TResponse | null, message?: string) => {
      if (resolved) return;
      resolved = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearTimeout(deadlineTimer);
      activeSocket?.destroy();
      if (message) logger.warn(message);
      resolve(result);
    };

    const deadlineTimer = setTimeout(() => {
      finish(
        null,
        `[WORKER_COMMAND_PIPE] Request deadline exceeded for ${pipePath} ` +
          `after ${attempts} attempt(s) and ${Date.now() - startedAt}ms`,
      );
    }, timeoutMs);

    const connect = () => {
      if (resolved) return;

      attempts += 1;
      let connected = false;
      let retryScheduled = false;
      let buffer = '';
      const socket = net.connect(pipePath);
      activeSocket = socket;

      socket.once('connect', () => {
        connected = true;
        socket.write(frame, 'utf-8', (err) => {
          if (err) {
            finish(
              null,
              `[WORKER_COMMAND_PIPE] Write error on ${pipePath}: ${err.message}`,
            );
          }
        });
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx < 0) return;

        const line = buffer.slice(0, newlineIdx).trim();
        try {
          finish(JSON.parse(line) as TResponse);
        } catch (err) {
          finish(
            null,
            `[WORKER_COMMAND_PIPE] JSON parse error from ${pipePath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });

      socket.once('error', (err) => {
        const errorCode = getErrorCode(err);
        const remainingMs = deadlineAt - Date.now();
        if (
          !connected &&
          errorCode &&
          RETRYABLE_CONNECT_CODES.has(errorCode) &&
          remainingMs > 0
        ) {
          retryScheduled = true;
          activeSocket = null;
          socket.destroy();
          const exponentialDelay = Math.min(
            maxRetryDelayMs,
            initialRetryDelayMs * 2 ** Math.max(0, attempts - 1),
          );
          const jitteredDelay = Math.ceil(
            exponentialDelay * (1 + Math.random() * 0.25),
          );
          retryTimer = setTimeout(connect, Math.min(jitteredDelay, remainingMs));
          return;
        }

        finish(
          null,
          `[WORKER_COMMAND_PIPE] Socket failure on ${pipePath} after ${attempts} ` +
            `attempt(s) and ${Date.now() - startedAt}ms` +
            `${errorCode ? ` (${errorCode})` : ''}: ${err.message}`,
        );
      });

      socket.once('close', () => {
        if (!resolved && !retryScheduled) {
          finish(
            null,
            `[WORKER_COMMAND_PIPE] Connection closed by ${pipePath} after ${attempts} ` +
              `attempt(s) and ${Date.now() - startedAt}ms`,
          );
        }
      });
    };

    connect();
  });
}

export async function sendWorkerCommand(
  payload: WorkerCommandPayload,
  options?: SendWorkerCommandOptions,
): Promise<boolean> {
  const resp = await sendWorkerRequest<WorkerHardwareResponse>(
    payload,
    options,
  );
  return resp !== null && resp.success !== false;
}
