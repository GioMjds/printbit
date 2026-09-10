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

export async function sendWorkerRequest<TResponse = WorkerHardwareResponse>(
  payload: Record<string, unknown>,
  options?: SendWorkerCommandOptions,
): Promise<TResponse | null> {
  const pipeName = options?.pipeName ?? 'printbit-worker-commands';
  const timeoutMs = options?.timeoutMs ?? 15000;
  const logger = options?.logger ?? console;
  const pipePath = pipeName.startsWith('\\\\.\\pipe\\')
    ? pipeName
    : `\\\\.\\pipe\\${pipeName}`;

  return new Promise<TResponse | null>((resolve) => {
    let resolved = false;
    let buffer = '';
    const socket = net.connect(pipePath);

    const finish = (result: TResponse | null) => {
      if (resolved) return;
      resolved = true;
      socket.setTimeout(0);
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => {
      logger.warn(`[WORKER_COMMAND_PIPE] Connection timeout to ${pipePath}`);
      finish(null);
    });

    socket.on('connect', () => {
      try {
        const frame = JSON.stringify(payload) + '\n';
        socket.write(frame, 'utf-8', (err) => {
          if (err) {
            logger.warn(`[WORKER_COMMAND_PIPE] Write error: ${err.message}`);
            finish(null);
          }
        });
      } catch (err) {
        logger.warn(
          `[WORKER_COMMAND_PIPE] Serialization failure: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        finish(null);
      }
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        try {
          const parsed = JSON.parse(line) as TResponse;
          finish(parsed);
        } catch (err) {
          logger.warn(
            `[WORKER_COMMAND_PIPE] JSON parse error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          finish(null);
        }
      }
    });

    socket.on('error', (err) => {
      logger.warn(
        `[WORKER_COMMAND_PIPE] Socket error connecting to ${pipePath}: ${err.message}`,
      );
      finish(null);
    });

    socket.on('close', () => {
      if (!resolved) {
        finish(null);
      }
    });
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
