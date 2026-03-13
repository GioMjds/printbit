import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { db } from './db';
import { Server } from 'socket.io';
import { adminService } from './admin';
import {
  parseHopperResponse,
  parseLegacyHopperResponse,
  type HopperResponse,
  type HopperErrorCodeValue,
  HopperErrorCode,
} from './hopper-protocol';

// [PHASE 5 - PRINTER GATE] Import printer telemetry and blocked status set
// so we can refuse coin credits when the printer is offline or faulted.
import { getPrinterTelemetry } from './printer-status';
import { BLOCKED_STATUSES } from '@/utils';

const ACCEPTED_COINS = new Set([1, 5, 10, 20]);
const FRAGMENT_WINDOW_MS = 140;
const TELEMETRY_MAX_AGE_MS = 45_000;
const RETRY_INTERVAL_MS = 5_000;
const MAX_RETRIES = 12; // 60 seconds of retrying

let serialConnected = false;
let serialPortPath: string | null = null;
let serialLastError: string | null = null;
let activeSerialPort: SerialPort | null = null;
let socketIo: Server | null = null;

let hopperCommandPending = false;
let hopperLastError: string | null = null;
let hopperLastSuccessAt: string | null = null;

export interface HopperCommandResult {
  ok: boolean;
  message: string;
  dispensedCoins?: number;
  errorCode?: HopperErrorCodeValue;
}

interface PendingHopperCommand {
  requestId: string;
  resolve: (result: HopperCommandResult) => void;
  timer: NodeJS.Timeout;
}

let pendingHopperCommand: PendingHopperCommand | null = null;

export function getSerialStatus() {
  return {
    connected: serialConnected,
    portPath: serialPortPath,
    lastError: serialLastError,
  };
}

export function getHopperStatus() {
  return {
    connected: serialConnected,
    pending: hopperCommandPending,
    portPath: serialPortPath,
    lastError: hopperLastError,
    lastSuccessAt: hopperLastSuccessAt,
  };
}

function completePendingHopperCommand(result: HopperCommandResult): boolean {
  if (!pendingHopperCommand) return false;
  const pending = pendingHopperCommand;
  pendingHopperCommand = null;
  clearTimeout(pending.timer);
  hopperCommandPending = false;

  if (result.ok) {
    hopperLastError = null;
    hopperLastSuccessAt = new Date().toISOString();
  } else {
    hopperLastError = result.message;
  }

  pending.resolve(result);
  return true;
}

function tryHandleHopperResponse(rawLine: string): boolean {
  const line = rawLine.trim();

  // ── Try structured protocol first ──────────────────────────────────────────
  const parsed = parseHopperResponse(line);
  if (parsed) {
    if (!pendingHopperCommand) {
      hopperLastError = `Unsolicited hopper response: ${line}`;
      console.warn(`[SERIAL] ⚠ ${hopperLastError}`);
      return true;
    }

    // Ignore responses for a different request ID
    if (parsed.requestId !== pendingHopperCommand.requestId) {
      console.warn(
        `[SERIAL] ⚠ Hopper response requestId mismatch: expected ${pendingHopperCommand.requestId}, got ${parsed.requestId}`,
      );
      return true;
    }

    return handleParsedResponse(parsed, line);
  }

  // ── Fall back to legacy format ("HOPPER OK" / "HOPPER ERROR …") ───────────
  const legacy = parseLegacyHopperResponse(line);
  if (legacy) {
    if (!pendingHopperCommand) {
      hopperLastError = `Unsolicited hopper response: ${line}`;
      console.warn(`[SERIAL] ⚠ ${hopperLastError}`);
      return true;
    }

    console.warn(
      `[SERIAL] ⚠ Legacy hopper response detected — consider upgrading Arduino firmware: "${line}"`,
    );
    completePendingHopperCommand(
      legacy.ok
        ? { ok: true, message: legacy.message }
        : { ok: false, message: legacy.message },
    );
    return true;
  }

  // Not a hopper message
  return false;
}

function handleParsedResponse(
  response: HopperResponse,
  rawLine: string,
): boolean {
  switch (response.kind) {
    case 'ACK':
      // Arduino acknowledged the command — keep waiting for DONE/ERR
      console.log(
        `[SERIAL] Hopper ACK received for request ${response.requestId}`,
      );
      return true;

    case 'PROGRESS':
      console.log(
        `[SERIAL] Hopper progress: ${response.dispensed}/${response.total} coins`,
      );
      socketIo?.emit('changeDispenseProgress', {
        dispensed: response.dispensed,
        total: response.total,
      });
      return true;

    case 'DONE':
      completePendingHopperCommand({
        ok: true,
        message: rawLine,
        dispensedCoins: response.dispensedCount,
      });
      return true;

    case 'ERR':
      completePendingHopperCommand({
        ok: false,
        message: `${response.code}: ${response.detail}`,
        errorCode: response.code,
      });
      return true;
  }
}

export async function sendHopperCommand(
  command: string,
  timeoutMs: number,
  requestId?: string,
): Promise<HopperCommandResult> {
  if (!serialConnected || !activeSerialPort) {
    return { ok: false, message: 'Serial port not connected.' };
  }

  if (pendingHopperCommand) {
    return { ok: false, message: 'Hopper command already in progress.' };
  }

  const normalizedTimeout = Number.isFinite(timeoutMs)
    ? Math.max(1000, Math.floor(timeoutMs))
    : 8000;

  return await new Promise<HopperCommandResult>((resolve) => {
    const timer = setTimeout(() => {
      completePendingHopperCommand({
        ok: false,
        message: `Hopper timeout after ${normalizedTimeout}ms.`,
        errorCode: HopperErrorCode.MOTOR_TIMEOUT,
      });
    }, normalizedTimeout);

    pendingHopperCommand = { requestId: requestId ?? '', resolve, timer };
    hopperCommandPending = true;

    activeSerialPort!.write(`${command.trim()}\n`, (error) => {
      if (!error) return;
      completePendingHopperCommand({
        ok: false,
        message: error.message,
      });
    });
  });
}

export async function initSerial(io: Server) {
  socketIo = io;
  console.log('[SERIAL] ── Initializing serial connection ──────────────');
  await attemptSerialConnection(io, 0);
}

async function attemptSerialConnection(io: Server, attempt: number) {
  try {
    const ports = await SerialPort.list();

    if (attempt === 0) {
      console.log(`[SERIAL] Found ${ports.length} serial port(s):`);
      for (const p of ports) {
        console.log(
          `[SERIAL]   → ${p.path} (manufacturer: ${p.manufacturer ?? 'unknown'}, vendorId: ${p.vendorId ?? 'unknown'}, productId: ${p.productId ?? 'unknown'}, serialNumber: ${p.serialNumber ?? 'unknown'})`,
        );
      }
    }

    if (!ports.length) {
      serialConnected = false;
      serialPortPath = null;
      serialLastError = 'No serial ports found.';
      console.warn(
        '[SERIAL] ✗ No serial ports found. Continuing without serial connection.',
      );
      return;
    }

    const portPath = ports[0].path;
    serialPortPath = portPath;
    console.log(
      `[SERIAL] Selected port: ${portPath} (baud: 9600)${attempt > 0 ? ` — retry #${attempt}` : ''}`,
    );

    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort(
        {
          path: portPath,
          baudRate: 9600,
        },
        (err) => {
          if (err) return reject(err);
        },
      );
      activeSerialPort = port;

      const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

      port.on('open', () => {
        console.log(
          `[SERIAL] ✓ Port opened — Arduino connected on ${portPath}`,
        );
        serialConnected = true;
        serialLastError = null;
        io.emit('serialStatus', getSerialStatus());
        resolve();
      });

      port.on('close', () => {
        console.log('[SERIAL] ✗ Port closed — Arduino disconnected');
        serialConnected = false;
        activeSerialPort = null;
        io.emit('serialStatus', getSerialStatus());
        completePendingHopperCommand({
          ok: false,
          message: 'Serial port closed during hopper command.',
        });
      });

      port.on('error', (error) => {
        serialConnected = false;
        serialLastError = error.message;
        activeSerialPort = null;
        io.emit('serialStatus', getSerialStatus());
        console.error('[SERIAL] ✗ Port error:', error.message);
        completePendingHopperCommand({
          ok: false,
          message: `Serial error: ${error.message}`,
        });
      });

      let pendingPrefix: '1' | '2' | null = null;
      let pendingTimer: NodeJS.Timeout | null = null;

      const clearPending = () => {
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingPrefix = null;
        pendingTimer = null;
      };

      const persistBalance = async (coinValue: number) => {
        db.data!.balance += coinValue;
        await adminService.incrementCoinStats(coinValue);
        await adminService.appendAdminLog(
          'coin_accepted',
          `Accepted coin: ${coinValue}`,
          {
            coinValue,
            balance: db.data!.balance,
          },
        );
        console.log(
          `[SERIAL] ✓ Coin accepted: ₱${coinValue} → new balance: ₱${db.data!.balance}`,
        );
        io.emit('balance', db.data!.balance);
        io.emit('coinAccepted', {
          value: coinValue,
          balance: db.data!.balance,
        });
      };

      const getPrinterAvailability = () => {
        const telemetry = getPrinterTelemetry();
        const checkedAtMs = Date.parse(telemetry.lastCheckedAt);
        const telemetryStale =
          !Number.isFinite(checkedAtMs) ||
          Date.now() - checkedAtMs > TELEMETRY_MAX_AGE_MS;
        const printerBlocked =
          telemetryStale ||
          !telemetry.connected ||
          BLOCKED_STATUSES.has(telemetry.status);

        const reason = telemetryStale
          ? 'Printer telemetry is stale'
          : !telemetry.connected
            ? 'Printer not connected'
            : `Printer status: ${telemetry.status}`;

        return {
          telemetry,
          printerBlocked,
          reason,
        };
      };

      const rejectCoinCredit = (
        token: string,
        value: number,
        reason: string,
        telemetry: ReturnType<typeof getPrinterTelemetry>,
      ) => {
        console.warn(
          `[SERIAL] ⚠ Coin rejected — printer unavailable (${reason}). Token: "${token}"`,
        );

        io.emit('coinRejected', {
          value: value > 0 ? value : null,
          reason,
          printerStatus: telemetry.status,
          telemetryLastCheckedAt: telemetry.lastCheckedAt,
        });

        void adminService.appendAdminLog(
          'coin_rejected_printer_unavailable',
          `Coin rejected: printer unavailable (${reason}).`,
          {
            token,
            coinValue: value > 0 ? value : null,
            printerStatus: telemetry.status,
            printerConnected: telemetry.connected,
            telemetryLastCheckedAt: telemetry.lastCheckedAt,
          },
        );

        clearPending();
      };

      const creditResolvedCoin = async (coinValue: number, token: string) => {
        const { telemetry, printerBlocked, reason } = getPrinterAvailability();
        if (printerBlocked) {
          rejectCoinCredit(token, coinValue, reason, telemetry);
          return;
        }

        await persistBalance(coinValue);
      };

      const flushPending = async (reason: 'timeout' | 'interrupted') => {
        if (!pendingPrefix) return;
        const prefix = pendingPrefix;
        console.log(
          `[SERIAL] Flushing pending "${prefix}" (reason: ${reason})`,
        );
        clearPending();

        if (prefix === '1') {
          await creditResolvedCoin(1, prefix);
          return;
        }

        io.emit('coinParserWarning', {
          code: 'INVALID_FRAGMENT',
          message: `Ignored fragment '${prefix}' (${reason}).`,
        });
        void adminService.appendAdminLog(
          'coin_parser_warning',
          `Ignored fragment '${prefix}' (${reason}).`,
          { reason },
        );
      };

      const armPending = (prefix: '1' | '2') => {
        console.log(
          `[SERIAL] Pending fragment: "${prefix}" (waiting ${FRAGMENT_WINDOW_MS}ms)`,
        );
        clearPending();
        pendingPrefix = prefix;
        pendingTimer = setTimeout(() => {
          void flushPending('timeout');
        }, FRAGMENT_WINDOW_MS);
      };

      const processToken = async (token: string) => {
        console.log(`[SERIAL] Token: "${token}"`);
        if (pendingPrefix) {
          if (token === '0') {
            const combined = Number(`${pendingPrefix}${token}`);
            clearPending();
            if (ACCEPTED_COINS.has(combined)) {
              await creditResolvedCoin(combined, `${pendingPrefix}${token}`);
            } else {
              io.emit('coinParserWarning', {
                code: 'INVALID_COMBINATION',
                message: `Ignored invalid coin '${combined}'.`,
              });
              void adminService.appendAdminLog(
                'coin_parser_warning',
                `Ignored invalid coin '${combined}'.`,
                { combined },
              );
            }
            return;
          }

          await flushPending('interrupted');
        }

        if (token === '1' || token === '2') {
          armPending(token);
          return;
        }

        const value = Number(token);
        if (!Number.isInteger(value)) {
          io.emit('coinParserWarning', {
            code: 'NON_NUMERIC',
            message: `Ignored serial token '${token}'.`,
          });
          void adminService.appendAdminLog(
            'coin_parser_warning',
            `Ignored non-numeric serial token '${token}'.`,
            { token },
          );
          return;
        }

        if (!ACCEPTED_COINS.has(value)) {
          io.emit('coinParserWarning', {
            code: 'UNSUPPORTED_COIN',
            message: `Ignored unsupported coin '${value}'.`,
          });
          void adminService.appendAdminLog(
            'coin_parser_warning',
            `Ignored unsupported coin '${value}'.`,
            { value },
          );
          return;
        }

        await creditResolvedCoin(value, token);
      };

      parser.on('data', (rawLine: string) => {
        console.log(`[SERIAL] Raw data: "${rawLine}"`);
        if (tryHandleHopperResponse(rawLine)) return;
        const token = rawLine.trim().replace(/[^0-9]/g, '');
        if (!token) return;
        void processToken(token);
      });
    });

    console.log(`[SERIAL] ✓ Serial port initialized on ${portPath}`);
    void adminService.appendAdminLog(
      'serial_connected',
      `Serial port initialized on ${portPath}`,
      {
        portPath,
      },
    );
  } catch (error) {
    serialConnected = false;
    serialLastError =
      error instanceof Error ? error.message : 'Unknown serial error.';

    const isAccessDenied = serialLastError
      .toLowerCase()
      .includes('access denied');

    if (isAccessDenied && attempt < MAX_RETRIES) {
      console.warn(
        `[SERIAL] ⚠ Port access denied — retrying in ${RETRY_INTERVAL_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES}). Close Arduino IDE Serial Monitor if open.`,
      );
      setTimeout(
        () => void attemptSerialConnection(io, attempt + 1),
        RETRY_INTERVAL_MS,
      );
      return;
    }

    console.error('[SERIAL] ✗ Init error:', serialLastError);
    if (isAccessDenied) {
      console.error(
        '[SERIAL] ✗ Gave up after retries. Close Arduino IDE Serial Monitor or any app using the port, then restart the server.',
      );
    }
    void adminService.appendAdminLog(
      'serial_init_error',
      'Error initializing serial port. Continuing without serial connection.',
      { message: serialLastError },
    );
  }
}
class SerialService {
  getStatus() {
    return getSerialStatus();
  }

  getHopperStatus() {
    return getHopperStatus();
  }

  async sendHopperCommand(
    command: string,
    timeoutMs: number,
    requestId?: string,
  ): Promise<HopperCommandResult> {
    return sendHopperCommand(command, timeoutMs, requestId);
  }

  async init(io: Server): Promise<void> {
    return initSerial(io);
  }
}

export const serialService = new SerialService();
