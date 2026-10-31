import { BLOCKED_STATUSES } from '@/utils';

type WatchdogComponent = 'app' | 'serial' | 'printer' | 'hotspot';
type WatchdogStatus = 'healthy' | 'degraded' | 'unhealthy';

type WatchdogContextValue = string | number | boolean | null;
type WatchdogContext = Record<string, WatchdogContextValue>;

interface WatchdogComponentState {
  status: WatchdogStatus;
  detail: string;
  lastHeartbeatAt: string;
  staleAfterMs: number;
  context: WatchdogContext;
}

export interface WatchdogHealthSnapshot {
  status: WatchdogStatus;
  checkedAt: string;
  process: {
    pid: number;
    uptimeSeconds: number;
    startedAt: string;
  };
  monitor: {
    appHeartbeatIntervalMs: number;
    componentPollIntervalMs: number;
  };
  externalWatchdog: ExternalWatchdogState;
  components: Record<
    WatchdogComponent,
    WatchdogComponentState & { stale: boolean; staleForMs: number }
  >;
  overall: WatchdogStatus;
}

export interface WatchdogHealthMonitorDeps {
  getSerialStatus: () => {
    connected: boolean;
    portPath: string | null;
    lastError: string | null;
  };
  getPrinterTelemetry: () => {
    connected: boolean;
    status: string;
    statusFlags: string[];
    lastCheckedAt: string;
    lastError: string | null;
    name: string | null;
  };
  isHotspotRunning: () => boolean;
}

export interface ExternalWatchdogState {
  running: boolean;
  watchdogPid: number | null;
  consecutiveFailures: number;
  recoveryAttempts: number;
  backoffDelayMs: number;
  nextRecoveryAt: string | null;
  lastAction: string;
  lastError: string | null;
  lastUpdatedAt: string;
}

const APP_HEARTBEAT_INTERVAL_MS = readPositiveIntEnv(
  'PRINTBIT_WATCHDOG_APP_HEARTBEAT_MS',
  1_000,
);
const COMPONENT_POLL_INTERVAL_MS = readPositiveIntEnv(
  'PRINTBIT_WATCHDOG_COMPONENT_POLL_MS',
  5_000,
);
const DEFAULT_STALE_AFTER_MS = readPositiveIntEnv(
  'PRINTBIT_WATCHDOG_STALE_AFTER_MS',
  20_000,
);
const PRINTER_TELEMETRY_STALE_AFTER_MS = readPositiveIntEnv(
  'PRINTBIT_WATCHDOG_PRINTER_TELEMETRY_STALE_AFTER_MS',
  90_000,
);

const PROCESS_STARTED_AT = new Date(
  Date.now() - Math.floor(process.uptime() * 1_000),
).toISOString();

let appHeartbeatTimer: NodeJS.Timeout | null = null;
let componentPollTimer: NodeJS.Timeout | null = null;
let componentPollInFlight = false;
let monitorDeps: WatchdogHealthMonitorDeps | null = null;
let externalWatchdog: ExternalWatchdogState = {
  running: false,
  watchdogPid: null,
  consecutiveFailures: 0,
  recoveryAttempts: 0,
  backoffDelayMs: 0,
  nextRecoveryAt: null,
  lastAction: 'not_reported',
  lastError: null,
  lastUpdatedAt: new Date(0).toISOString(),
};

const components: Record<WatchdogComponent, WatchdogComponentState> = {
  app: {
    status: 'degraded',
    detail: 'App heartbeat not started yet.',
    lastHeartbeatAt: new Date(0).toISOString(),
    staleAfterMs: Math.max(
      DEFAULT_STALE_AFTER_MS,
      APP_HEARTBEAT_INTERVAL_MS * 3,
    ),
    context: {},
  },
  serial: {
    status: 'degraded',
    detail: 'Serial health polling not started yet.',
    lastHeartbeatAt: new Date(0).toISOString(),
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
    context: {},
  },
  printer: {
    status: 'degraded',
    detail: 'Printer health polling not started yet.',
    lastHeartbeatAt: new Date(0).toISOString(),
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
    context: {},
  },
  hotspot: {
    status: 'degraded',
    detail: 'Hotspot health polling not started yet.',
    lastHeartbeatAt: new Date(0).toISOString(),
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
    context: {},
  },
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function toTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function worstStatus(a: WatchdogStatus, b: WatchdogStatus): WatchdogStatus {
  if (a === 'unhealthy' || b === 'unhealthy') return 'unhealthy';
  if (a === 'degraded' || b === 'degraded') return 'degraded';
  return 'healthy';
}

function cloneContext(context?: WatchdogContext): WatchdogContext {
  return context ? { ...context } : {};
}

function updateComponentState(
  component: WatchdogComponent,
  update: {
    status: WatchdogStatus;
    detail: string;
    context?: WatchdogContext;
    heartbeatAt?: string;
  },
): void {
  components[component] = {
    ...components[component],
    status: update.status,
    detail: update.detail,
    context: cloneContext(update.context),
    lastHeartbeatAt: update.heartbeatAt ?? new Date().toISOString(),
  };
}

export function markWatchdogHeartbeat(
  component: WatchdogComponent,
  context?: WatchdogContext,
): void {
  components[component] = {
    ...components[component],
    lastHeartbeatAt: new Date().toISOString(),
    context: context ? cloneContext(context) : cloneContext(components[component].context),
  };
}

export function setWatchdogComponentState(
  component: WatchdogComponent,
  status: WatchdogStatus,
  detail: string,
  context?: WatchdogContext,
): void {
  updateComponentState(component, { status, detail, context });
}

export function getExternalWatchdogState(): ExternalWatchdogState {
  return { ...externalWatchdog };
}

export function updateExternalWatchdogState(
  next: Partial<
    Omit<ExternalWatchdogState, 'lastUpdatedAt' | 'watchdogPid'> & {
      watchdogPid: number | null;
    }
  >,
): ExternalWatchdogState {
  const normalizedPid =
    next.watchdogPid === null
      ? null
      : typeof next.watchdogPid === 'number' &&
          Number.isFinite(next.watchdogPid)
        ? Math.floor(next.watchdogPid)
        : externalWatchdog.watchdogPid;

  externalWatchdog = {
    running:
      typeof next.running === 'boolean'
        ? next.running
        : externalWatchdog.running,
    watchdogPid: normalizedPid,
    consecutiveFailures:
      typeof next.consecutiveFailures === 'number' &&
      Number.isFinite(next.consecutiveFailures)
        ? Math.max(0, Math.floor(next.consecutiveFailures))
        : externalWatchdog.consecutiveFailures,
    recoveryAttempts:
      typeof next.recoveryAttempts === 'number' &&
      Number.isFinite(next.recoveryAttempts)
        ? Math.max(0, Math.floor(next.recoveryAttempts))
        : externalWatchdog.recoveryAttempts,
    backoffDelayMs:
      typeof next.backoffDelayMs === 'number' &&
      Number.isFinite(next.backoffDelayMs)
        ? Math.max(0, Math.floor(next.backoffDelayMs))
        : externalWatchdog.backoffDelayMs,
    nextRecoveryAt:
      next.nextRecoveryAt === null
        ? null
        : typeof next.nextRecoveryAt === 'string'
          ? next.nextRecoveryAt
          : externalWatchdog.nextRecoveryAt,
    lastAction:
      typeof next.lastAction === 'string' && next.lastAction.trim().length > 0
        ? next.lastAction.trim()
        : externalWatchdog.lastAction,
    lastError:
      next.lastError === null
        ? null
        : typeof next.lastError === 'string'
          ? next.lastError.trim() || null
          : externalWatchdog.lastError,
    lastUpdatedAt: new Date().toISOString(),
  };

  return { ...externalWatchdog };
}

async function pollWatchdogComponents(): Promise<void> {
  const deps = monitorDeps;
  if (!deps) return;
  if (componentPollInFlight) return;
  componentPollInFlight = true;

  try {
    try {
      const serial = deps.getSerialStatus();
      updateComponentState('serial', {
        status: serial.connected ? 'healthy' : 'degraded',
        detail: serial.connected
          ? `Serial connected on ${serial.portPath ?? 'unknown port'}.`
          : `Serial disconnected${serial.lastError ? `: ${serial.lastError}` : '.'}`,
        context: {
          connected: serial.connected,
          portPath: serial.portPath,
          hasError: serial.lastError ? true : false,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[WATCHDOG-HEALTH] Failed to poll serial health.', {
        error: message,
      });
      updateComponentState('serial', {
        status: 'degraded',
        detail: `Serial health check failed: ${message}`,
        context: {
          connected: false,
        },
      });
    }

    try {
      const printer = deps.getPrinterTelemetry();
      const printerCheckedAtMs = toTimestampMs(printer.lastCheckedAt);
      const printerTelemetryStale =
        !Number.isFinite(printerCheckedAtMs) ||
        Date.now() - printerCheckedAtMs > PRINTER_TELEMETRY_STALE_AFTER_MS;

      let printerStatus: WatchdogStatus = 'healthy';
      let printerDetail = `Printer healthy (${printer.status}).`;

      if (!printer.connected) {
        printerStatus = 'degraded';
        printerDetail = 'Printer disconnected.';
      } else if (BLOCKED_STATUSES.has(printer.status)) {
        printerStatus = 'degraded';
        printerDetail = `Printer blocked: ${printer.status}.`;
      } else if (printerTelemetryStale) {
        printerStatus = 'degraded';
        printerDetail = 'Printer telemetry is stale.';
      }

      updateComponentState('printer', {
        status: printerStatus,
        detail: printerDetail,
        context: {
          connected: printer.connected,
          status: printer.status,
          telemetryStale: printerTelemetryStale,
          lastError: printer.lastError,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[WATCHDOG-HEALTH] Failed to poll printer health.', {
        error: message,
      });
      updateComponentState('printer', {
        status: 'degraded',
        detail: `Printer health check failed: ${message}`,
        context: {
          connected: false,
        },
      });
    }

    try {
      const hotspotRunning = deps.isHotspotRunning();
      updateComponentState('hotspot', {
        status: hotspotRunning ? 'healthy' : 'degraded',
        detail: hotspotRunning
          ? 'Hotspot service is running.'
          : 'Hotspot service is not running.',
        context: {
          running: hotspotRunning,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[WATCHDOG-HEALTH] Failed to poll hotspot health.', {
        error: message,
      });
      updateComponentState('hotspot', {
        status: 'degraded',
        detail: `Hotspot health check failed: ${message}`,
        context: {
          running: false,
        },
      });
    }
  } finally {
    componentPollInFlight = false;
  }
}

export function startWatchdogHealthMonitor(
  deps: WatchdogHealthMonitorDeps,
): void {
  if (appHeartbeatTimer || componentPollTimer) return;

  monitorDeps = deps;

  updateComponentState('app', {
    status: 'healthy',
    detail: 'App heartbeat monitor started.',
  });

  appHeartbeatTimer = setInterval(() => {
    markWatchdogHeartbeat('app', {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }, APP_HEARTBEAT_INTERVAL_MS);

  componentPollTimer = setInterval(() => {
    void pollWatchdogComponents().catch((error) => {
      console.error('[WATCHDOG-HEALTH] Component poll failed.', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, COMPONENT_POLL_INTERVAL_MS);

  void pollWatchdogComponents().catch((error) => {
    console.error('[WATCHDOG-HEALTH] Initial component poll failed.', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  console.log('[WATCHDOG-HEALTH] ✓ Watchdog health monitor started.');
}

export function stopWatchdogHealthMonitor(): void {
  if (appHeartbeatTimer) {
    clearInterval(appHeartbeatTimer);
    appHeartbeatTimer = null;
  }
  if (componentPollTimer) {
    clearInterval(componentPollTimer);
    componentPollTimer = null;
  }
  monitorDeps = null;
  componentPollInFlight = false;
}

export function getWatchdogHealthSnapshot(): WatchdogHealthSnapshot {
  const now = new Date();
  const checkedAt = now.toISOString();
  const nowMs = now.getTime();

  let overall: WatchdogStatus = 'healthy';
  const computed: WatchdogHealthSnapshot['components'] = {
    app: {
      ...components.app,
      context: cloneContext(components.app.context),
      stale: false,
      staleForMs: 0,
    },
    serial: {
      ...components.serial,
      context: cloneContext(components.serial.context),
      stale: false,
      staleForMs: 0,
    },
    printer: {
      ...components.printer,
      context: cloneContext(components.printer.context),
      stale: false,
      staleForMs: 0,
    },
    hotspot: {
      ...components.hotspot,
      context: cloneContext(components.hotspot.context),
      stale: false,
      staleForMs: 0,
    },
  };

  for (const component of Object.keys(computed) as WatchdogComponent[]) {
    const entry = computed[component];
    const heartbeatMs = toTimestampMs(entry.lastHeartbeatAt);
    const staleForMs = Number.isFinite(heartbeatMs)
      ? nowMs - heartbeatMs
      : Number.POSITIVE_INFINITY;
    const stale = staleForMs > entry.staleAfterMs;
    const status = stale ? 'unhealthy' : entry.status;

    computed[component] = {
      ...entry,
      status,
      detail: stale
        ? `${entry.detail} Heartbeat stale for ${Math.floor(staleForMs)}ms.`
        : entry.detail,
      stale,
      staleForMs: Number.isFinite(staleForMs)
        ? Math.max(0, Math.floor(staleForMs))
        : Number.MAX_SAFE_INTEGER,
      context: cloneContext(entry.context),
    };
    overall = worstStatus(overall, status);
  }

  return {
    status: overall,
    checkedAt,
    process: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: PROCESS_STARTED_AT,
    },
    monitor: {
      appHeartbeatIntervalMs: APP_HEARTBEAT_INTERVAL_MS,
      componentPollIntervalMs: COMPONENT_POLL_INTERVAL_MS,
    },
    externalWatchdog: { ...externalWatchdog },
    components: computed,
    overall,
  };
}
