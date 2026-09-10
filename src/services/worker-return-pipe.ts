import net from 'node:net';
import {
  type PowerStatus,
  type PowerState,
  type WorkerPowerEvent,
  type PowerSafetyState,
  powerSafetyService,
} from './power-safety';
import { printerStateProjection } from './printer-state-projection';
import { hardwareStateProjection } from './hardware-state-projection';

export type WorkerPrintEventType =
  | 'PrintStarted'
  | 'PrintProgress'
  | 'PrintSucceeded'
  | 'PrintFailed'
  | 'PrinterOffline'
  | 'PrinterOnline'
  | 'PrinterError'
  | 'JobPaused'
  | 'JobResumed'
  | 'JobCompleted'
  | 'PowerStatusChanged'
  | 'PowerStatusSnapshot'
  | 'PrinterStatusSnapshot'
  | 'CoinInserted'
  | 'CoinRejected'
  | 'HopperProgress'
  | 'HopperDispensed'
  | 'HardwareStatus';

export type WorkerTerminalOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partially_completed'
  | 'unknown';

const workerTerminalOutcomes = new Set<WorkerTerminalOutcome>([
  'completed',
  'failed',
  'cancelled',
  'partially_completed',
  'unknown',
]);

export interface WorkerPrintEvent {
  type: WorkerPrintEventType;
  protocolVersion?: 2;
  eventId?: string;
  sequence?: number;
  transactionId?: string;
  spoolerCorrelationKey?: string;
  spoolerJobId?: string;
  fileName?: string;
  printerName?: string;
  failureStage?: string;
  message?: string;
  errorMessage?: string;
  outcome?: WorkerTerminalOutcome;
  /**
   * Pages printed so far, reported by the worker's Win32_PrintJob poller.
   * Populated on `PrintProgress` and terminal print events when available.
   */
  pagesPrinted?: number;
  /**
   * Total pages in the spooler job. Reported alongside `pagesPrinted` so the
   * confirm page can render an "N of M" progress indicator.
   */
  totalPages?: number;
  powerStatus?: PowerStatus;
  operationalState?: PowerState;
  acceptingTransactions?: boolean;
  powerSourceInstanceId?: string;
  powerSequence?: number;
  coinValue?: number;
  simulated?: boolean;
  rejectReason?: string;
  dispensedCoins?: number;
  totalCoins?: number;
  errorCode?: string;
  hardwareRequestId?: string;
  requestId?: string;
  timestampUtc: string;
}

/**
 * Handle returned by `startWorkerReturnPipeServer`.
 *
 * - `pipePath`  — the full Windows named-pipe path the server listens on.
 * - `server`    — the underlying `net.Server` instance.
 * - `ready`     — resolves when the server is listening; rejects if the bind
 *                 fails (e.g. pipe already in use).  Await this in startup
 *                 sequences to guarantee the pipe is open before proceeding.
 * - `close`     — gracefully stops the server and resolves when all
 *                 connections are drained.
 */
export interface WorkerReturnPipeServerHandle {
  pipePath: string;
  server: net.Server;
  ready: Promise<void>;
  close: () => Promise<void>;
}

export function parseWorkerEventLine(
  line: string,
  maxBytes: number,
): WorkerPrintEvent {
  if (!line.trim()) {
    throw new Error('EmptyPayload');
  }
  if (Buffer.byteLength(line, 'utf8') > maxBytes) {
    throw new Error('PayloadTooLarge');
  }
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (!parsed.type || !parsed.timestampUtc) {
    throw new Error('InvalidPayload');
  }
  if (parsed.protocolVersion !== undefined) {
    if (
      parsed.protocolVersion !== 2 ||
      typeof parsed.eventId !== 'string' ||
      parsed.eventId.trim().length === 0 ||
      typeof parsed.sequence !== 'number' ||
      !Number.isInteger(parsed.sequence) ||
      parsed.sequence < 0 ||
      (parsed.outcome !== undefined &&
        (typeof parsed.outcome !== 'string' ||
          !workerTerminalOutcomes.has(parsed.outcome as WorkerTerminalOutcome)))
    ) {
      throw new Error('InvalidV2Payload');
    }
  }
  return parsed as unknown as WorkerPrintEvent;
}

export function mapWorkerEventToSocket(evt: WorkerPrintEvent): {
  event:
    | 'workerPrintStarted'
    | 'workerPrintProgress'
    | 'workerPrintSucceeded'
    | 'workerPrintFailed'
    | 'workerPrinterOffline'
    | 'workerPrinterOnline'
    | 'workerPrinterError'
    | 'workerJobPaused'
    | 'workerJobResumed'
    | 'workerPowerStatusChanged'
    | 'coinAccepted'
    | 'coinRejected'
    | 'hopperProgress'
    | 'hopperDispensed'
    | 'hardwareStatus';
  payload: WorkerPrintEvent;
} {
  switch (evt.type) {
    case 'PrintStarted':
      return { event: 'workerPrintStarted', payload: evt };
    case 'PrintProgress':
      return { event: 'workerPrintProgress', payload: evt };
    case 'PrintSucceeded':
      return { event: 'workerPrintSucceeded', payload: evt };
    case 'PrintFailed':
      return { event: 'workerPrintFailed', payload: evt };
    case 'PrinterOffline':
      return { event: 'workerPrinterOffline', payload: evt };
    case 'PrinterOnline':
      return { event: 'workerPrinterOnline', payload: evt };
    case 'PrinterError':
      return { event: 'workerPrinterError', payload: evt };
    case 'JobPaused':
      return { event: 'workerJobPaused', payload: evt };
    case 'JobResumed':
      return { event: 'workerJobResumed', payload: evt };
    case 'PowerStatusChanged':
    case 'PowerStatusSnapshot':
      return { event: 'workerPowerStatusChanged', payload: evt };
    case 'PrinterStatusSnapshot':
      return {
        event: evt.message?.toLowerCase().includes('offline')
          ? 'workerPrinterOffline'
          : 'workerPrinterOnline',
        payload: evt,
      };
    case 'JobCompleted':
      return {
        event:
          evt.outcome === 'completed'
            ? 'workerPrintSucceeded'
            : 'workerPrintFailed',
        payload: evt,
      };
    case 'CoinInserted':
      return { event: 'coinAccepted', payload: evt };
    case 'CoinRejected':
      return { event: 'coinRejected', payload: evt };
    case 'HopperProgress':
      return { event: 'hopperProgress', payload: evt };
    case 'HopperDispensed':
      return { event: 'hopperDispensed', payload: evt };
    case 'HardwareStatus':
      return { event: 'hardwareStatus', payload: evt };
    default: {
      // Exhaustiveness check: if a new WorkerPrintEventType variant is added
      // and not mapped here, fail the type system instead of silently
      // misrouting the event as a print failure (which used to be the
      // behavior of this branch and would corrupt the kiosk UX).
      const _exhaustive: never = evt.type;
      void _exhaustive;
      return { event: 'workerPrintFailed', payload: evt };
    }
  }
}

export function handleWorkerPowerEvent(
  evt: WorkerPrintEvent,
  io?: { emit: (event: string, ...args: unknown[]) => void },
): PowerSafetyState | null {
  if (evt.type !== 'PowerStatusChanged' && evt.type !== 'PowerStatusSnapshot') {
    return null;
  }
  const state = powerSafetyService.applyWorkerPowerEvent(
    evt as unknown as WorkerPowerEvent,
  );
  io?.emit('workerPowerStatusChanged', evt);
  return state;
}

export function startWorkerReturnPipeServer(input: {
  pipeName: string;
  maxBytes: number;
  onEvent: (evt: WorkerPrintEvent) => void;
  logger?: Pick<Console, 'warn' | 'error' | 'log'>;
}): WorkerReturnPipeServerHandle {
  const logger = input.logger ?? console;
  const pipePath = `\\\\.\\pipe\\${input.pipeName}`;

  const server = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const evt = parseWorkerEventLine(line, input.maxBytes);
          printerStateProjection.applyEvent(evt);
          void hardwareStateProjection.applyEvent(evt);
          input.onEvent(evt);
        } catch (err) {
          logger.warn(
            `[WORKER_RETURN_PIPE] Ignored payload: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        index = buffer.indexOf('\n');
      }
    });

    socket.on('error', (err) => {
      logger.warn(
        `[WORKER_RETURN_PIPE] Socket error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  let settled = false;

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      settled = true;
      logger.log(`[WORKER_RETURN_PIPE] Listening on ${pipePath}`);
      resolve();
    });

    server.once('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[WORKER_RETURN_PIPE] Server error: ${message}`);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });

  server.listen({
    path: pipePath,
    readableAll: true,
    writableAll: true,
  });

  return {
    pipePath,
    server,
    ready,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }

        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}
