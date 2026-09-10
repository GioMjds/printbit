import { runPowerShell } from '@/utils';
import type { TrustedTimestampMeta } from './db';
import { getPlatformWorkerFlags } from '@/config/platform-worker.config';
import {
  platformWorkerClient,
  type PlatformWorkerClient,
} from '@/services/platform-worker-client';

export interface TrustedTimeVerificationDeps {
  env?: NodeJS.ProcessEnv;
  workerClient?: Pick<PlatformWorkerClient, 'getTrustedTimeStatus'>;
  runPowerShell?: typeof runPowerShell;
  now?: () => Date;
  logger?: Pick<Console, 'warn'>;
}

const DEFAULT_MAX_DRIFT_MS = 60_000;
const DEFAULT_REVALIDATION_MS = 5 * 60 * 1_000;

export interface TrustedTimestamp {
  timestamp: string;
  meta: TrustedTimestampMeta;
}

export interface TrustedTimeStatus {
  source: TrustedTimestampMeta['source'];
  synced: boolean;
  offsetMs: number | null;
  driftExceeded: boolean;
  maxDriftMs: number;
  enforceForFinancial: boolean;
  checkedAt: string;
  detail: string;
  ntpSource: string | null;
  lastSuccessfulSyncAt: string | null;
}

export class TrustedTimeError extends Error {
  readonly statusCode: number;
  readonly code: 'TRUSTED_TIME_UNAVAILABLE';
  readonly trustedTime: TrustedTimeStatus;
  readonly operation: string;

  constructor(operation: string, status: TrustedTimeStatus) {
    super(
      `Financial operation blocked: trusted time unavailable (${status.detail})`,
    );
    this.name = 'TrustedTimeError';
    this.statusCode = 503;
    this.code = 'TRUSTED_TIME_UNAVAILABLE';
    this.trustedTime = status;
    this.operation = operation;
  }
}

let lastKnownOffsetMs: number | null = null;
let monitorHandle: NodeJS.Timeout | null = null;
let monitorInFlight = false;

let statusCache = {
  source: 'system',
  synced: false,
  offsetMs: null,
  driftExceeded: false,
  maxDriftMs: DEFAULT_MAX_DRIFT_MS,
  enforceForFinancial: false,
  checkedAt: new Date(0).toISOString(),
  detail: 'Trusted time has not been verified yet.',
  ntpSource: null,
  lastSuccessfulSyncAt: null,
} as TrustedTimeStatus;

function readConfiguredOffsetMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.PRINTBIT_NTP_OFFSET_MS;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
}

function readMaxDriftMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRINTBIT_TRUSTED_TIME_MAX_DRIFT_MS;
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_MAX_DRIFT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_DRIFT_MS;
  return Math.floor(parsed);
}

function readRevalidationIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRINTBIT_TRUSTED_TIME_REVALIDATE_MS;
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_REVALIDATION_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 5_000)
    return DEFAULT_REVALIDATION_MS;
  return Math.floor(parsed);
}

function readEnforceFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PRINTBIT_TRUSTED_TIME_ENFORCE;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
    return true;
  }
  // Trusted-time enforcement is opt-in by default. Many production kiosks run
  // in offline/limited-connectivity environments and should not block
  // payments, refunds, or recovery on NTP availability.
  return false;
}

function readNtpServerOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PRINTBIT_TRUSTED_TIME_NTP_SERVER;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type W32StatusKey = 'Source' | 'Last Successful Sync Time';

const STATUS_VALUE_REGEX: Record<W32StatusKey, RegExp> = {
  Source: /^\s*Source\s*:\s*(.+)$/im,
  'Last Successful Sync Time': /^\s*Last Successful Sync Time\s*:\s*(.+)$/im,
};

function parseStatusValue(rawStatus: string, key: string): string | null {
  if (key !== 'Source' && key !== 'Last Successful Sync Time') {
    return null;
  }
  const match = rawStatus.match(STATUS_VALUE_REGEX[key as W32StatusKey]);
  return match?.[1]?.trim() ?? null;
}

function parseStripchartOffsetMs(rawStripchart: string): number | null {
  const compact = rawStripchart.replace(/\r/g, '\n');
  const timedMatch = compact.match(/,\s*([+-]?\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  const genericMatch =
    timedMatch ?? compact.match(/\b([+-]?\d+(?:\.\d+)?)\s*(ms|s)\b/i) ?? null;
  if (!genericMatch) return null;
  const value = Number(genericMatch[1]);
  if (!Number.isFinite(value)) return null;
  const unit = genericMatch[2].toLowerCase();
  return Math.round(unit === 's' ? value * 1_000 : value);
}

function isUnsyncedSource(source: string | null): boolean {
  if (!source || !source.trim()) return true;
  return /local cmos clock|free-running system clock/i.test(source);
}

function normalizeW32ComputerName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

function updateStatus(next: TrustedTimeStatus): TrustedTimeStatus {
  statusCache = next;
  if (next.synced && next.offsetMs !== null) {
    lastKnownOffsetMs = next.offsetMs;
  }
  return statusCache;
}

function buildStatusFromOffset(
  offsetMs: number | null,
  detail: string,
  env: NodeJS.ProcessEnv = process.env,
): TrustedTimeStatus {
  const maxDriftMs = readMaxDriftMs(env);
  const synced = offsetMs !== null;
  const driftExceeded =
    synced && offsetMs !== null ? Math.abs(offsetMs) > maxDriftMs : false;
  return {
    source: synced && !driftExceeded ? 'ntp' : 'system',
    synced: synced && !driftExceeded,
    offsetMs,
    driftExceeded,
    maxDriftMs,
    enforceForFinancial: readEnforceFlag(env),
    checkedAt: new Date().toISOString(),
    detail: driftExceeded
      ? `Clock drift ${Math.abs(offsetMs ?? 0)}ms exceeds threshold ${maxDriftMs}ms.`
      : detail,
    ntpSource: offsetMs !== null ? 'configured-offset' : null,
    lastSuccessfulSyncAt:
      synced && !driftExceeded ? new Date().toISOString() : null,
  };
}

export function updateTrustedClockOffset(offsetMs: number | null): void {
  if (offsetMs !== null && Number.isFinite(offsetMs)) {
    lastKnownOffsetMs = Math.round(offsetMs);
  } else {
    lastKnownOffsetMs = null;
  }
  updateStatus(
    buildStatusFromOffset(
      lastKnownOffsetMs,
      lastKnownOffsetMs !== null
        ? 'Using runtime trusted clock offset.'
        : 'Trusted clock offset cleared.',
    ),
  );
}

export async function verifyTrustedClockSync(
  deps: TrustedTimeVerificationDeps = {},
): Promise<TrustedTimeStatus> {
  const env = deps.env ?? process.env;
  const configuredOffsetMs = readConfiguredOffsetMs(env);
  if (configuredOffsetMs !== null) {
    return updateStatus(
      buildStatusFromOffset(
        configuredOffsetMs,
        'Using PRINTBIT_NTP_OFFSET_MS as trusted clock offset.',
        env,
      ),
    );
  }

  const maxDriftMs = readMaxDriftMs(env);
  const enforceForFinancial = readEnforceFlag(env);
  const flags = getPlatformWorkerFlags(env);
  const logger = deps.logger ?? console;

  if (flags.trustedTime) {
    const workerClient = deps.workerClient ?? platformWorkerClient;
    const ntpOverride = readNtpServerOverride(env);
    let workerRes;
    try {
      workerRes = await workerClient.getTrustedTimeStatus({
        ntpServer: ntpOverride,
        maxDriftMs,
      });
    } catch {
      workerRes = null;
    }

    if (!workerRes || workerRes.errorCode === 'NOT_IMPLEMENTED') {
      logger.warn(
        '[TRUSTED_TIME] Worker backend unavailable; using temporary Node fallback.',
      );
    } else {
      const checkedTime = Date.parse(workerRes.checkedAt);
      const syncTime = workerRes.lastSuccessfulSyncAt
        ? Date.parse(workerRes.lastSuccessfulSyncAt)
        : null;

      if (
        Number.isNaN(checkedTime) ||
        (workerRes.lastSuccessfulSyncAt && syncTime !== null && Number.isNaN(syncTime))
      ) {
        logger.warn(
          '[TRUSTED_TIME] Worker returned invalid timestamp; using temporary Node fallback.',
        );
      } else {
        return updateStatus({
          source: (workerRes.source as TrustedTimestampMeta['source']) || 'system',
          synced: workerRes.synced,
          offsetMs: workerRes.offsetMs ?? null,
          driftExceeded: workerRes.driftExceeded,
          maxDriftMs: workerRes.maxDriftMs,
          enforceForFinancial,
          checkedAt: workerRes.checkedAt,
          detail:
            workerRes.detail ||
            (workerRes.synced
              ? `Trusted time synchronized (offset ${workerRes.offsetMs}ms).`
              : 'Windows Time is not synchronized.'),
          ntpSource: workerRes.ntpSource ?? null,
          lastSuccessfulSyncAt: workerRes.lastSuccessfulSyncAt ?? null,
        });
      }
    }
  }

  const runPs = deps.runPowerShell ?? runPowerShell;
  try {
    const rawStatus = await runPs('w32tm /query /status', 3_000);
    const source = parseStatusValue(rawStatus, 'Source');
    const lastSuccessfulSyncAt = parseStatusValue(
      rawStatus,
      'Last Successful Sync Time',
    );

    if (isUnsyncedSource(source)) {
      return updateStatus({
        source: 'system',
        synced: false,
        offsetMs: null,
        driftExceeded: false,
        maxDriftMs,
        enforceForFinancial,
        checkedAt: (deps.now ? deps.now() : new Date()).toISOString(),
        detail: `Windows Time is not synchronized (source: ${source ?? 'unknown'}).`,
        ntpSource: source,
        lastSuccessfulSyncAt: lastSuccessfulSyncAt ?? null,
      });
    }

    const ntpTarget =
      normalizeW32ComputerName(source) ??
      normalizeW32ComputerName(readNtpServerOverride(env)) ??
      'time.windows.com';
    const rawStripchart = await runPs(
      `w32tm /stripchart /computer:${ntpTarget} /samples:1 /dataonly`,
      3_000,
    );
    const offsetMs = parseStripchartOffsetMs(rawStripchart);
    const driftExceeded =
      offsetMs !== null ? Math.abs(offsetMs) > maxDriftMs : true;
    const synced = offsetMs !== null && !driftExceeded;

    return updateStatus({
      source: synced ? 'ntp' : 'system',
      synced,
      offsetMs,
      driftExceeded,
      maxDriftMs,
      enforceForFinancial,
      checkedAt: (deps.now ? deps.now() : new Date()).toISOString(),
      detail:
        offsetMs === null
          ? `Failed to parse NTP offset from w32tm stripchart output (source: ${source ?? ntpTarget}).`
          : driftExceeded
            ? `Clock drift ${Math.abs(offsetMs)}ms exceeds threshold ${maxDriftMs}ms (source: ${source ?? ntpTarget}).`
            : `Trusted time synchronized via ${source ?? ntpTarget} (offset ${offsetMs}ms).`,
      ntpSource: source ?? ntpTarget,
      lastSuccessfulSyncAt:
        synced && (lastSuccessfulSyncAt ?? null)
          ? lastSuccessfulSyncAt
          : synced
            ? (deps.now ? deps.now() : new Date()).toISOString()
            : null,
    });
  } catch (error) {
    return updateStatus({
      source: 'system',
      synced: false,
      offsetMs: null,
      driftExceeded: false,
      maxDriftMs,
      enforceForFinancial,
      checkedAt: (deps.now ? deps.now() : new Date()).toISOString(),
      detail: `Trusted time verification failed: ${error instanceof Error ? error.message : String(error)}`,
      ntpSource: null,
      lastSuccessfulSyncAt: null,
    });
  }
}

export function getTrustedTimeStatus(): TrustedTimeStatus {
  return { ...statusCache };
}

export function isTrustedTimeError(error: unknown): error is TrustedTimeError {
  return error instanceof TrustedTimeError;
}

export function assertTrustedTimeForFinancialOperation(
  operation: string,
): void {
  const status = getTrustedTimeStatus();
  if (!status.enforceForFinancial) return;
  const ageMs = Date.now() - Date.parse(status.checkedAt);
  const staleThresholdMs = readRevalidationIntervalMs();
  if (!Number.isFinite(ageMs) || ageMs > staleThresholdMs) {
    throw new TrustedTimeError(operation, {
      ...status,
      synced: false,
      source: 'system',
      offsetMs: null,
      driftExceeded: false,
      detail:
        'Trusted time status is stale. Wait for the next verification cycle or run a manual time-sync check.',
    });
  }
  if (!status.synced || status.offsetMs === null || status.driftExceeded) {
    throw new TrustedTimeError(operation, status);
  }
}

export function getTrustedTimestamp(): TrustedTimestamp {
  const current = getTrustedTimeStatus();
  const offsetMs = current.synced ? current.offsetMs : null;
  const adjustedMs = Date.now() + (offsetMs ?? 0);

  return {
    timestamp: new Date(adjustedMs).toISOString(),
    meta: {
      source: current.synced ? 'ntp' : 'system',
      synced: current.synced,
      offsetMs,
      detail: current.detail,
    },
  };
}

export function startTrustedTimeMonitor(
  onStatus?: (status: TrustedTimeStatus) => void | Promise<void>,
): void {
  const intervalMs = readRevalidationIntervalMs();
  if (monitorHandle) clearInterval(monitorHandle);
  monitorHandle = setInterval(() => {
    if (monitorInFlight) return;
    monitorInFlight = true;
    void (async () => {
      const status = await verifyTrustedClockSync();
      if (onStatus) await onStatus(status);
    })()
      .catch((error) => {
        console.error('[TIME] Trusted time monitor callback failed.', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        monitorInFlight = false;
      });
  }, intervalMs);
}

export function stopTrustedTimeMonitor(): void {
  if (!monitorHandle) return;
  clearInterval(monitorHandle);
  monitorHandle = null;
}
