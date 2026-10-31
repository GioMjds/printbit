import { getHeartbeatConfig } from '@/config/heartbeat.config';
import { getWatchdogHealthSnapshot } from '@/services/watchdog-health';

export interface HeartbeatDiagnosticPayload {
  kioskId: string;
  status: 'healthy' | 'degraded';
  timestamp: string;
  uptimeSec: number;
  issues: string[];
  components: Record<string, string>;
}

export interface HeartbeatSendResult {
  sent: boolean;
  endpoint: string | null;
  status: 'healthy' | 'degraded' | 'skipped' | 'failed';
  statusCode?: number;
  error?: string;
}

let reporterTimer: NodeJS.Timeout | null = null;
let reporterInFlight = false;

export function evaluateReadiness(): {
  isHealthy: boolean;
  issues: string[];
  components: Record<string, string>;
} {
  const snapshot = getWatchdogHealthSnapshot();
  const issues: string[] = [];
  const components: Record<string, string> = {};

  for (const [key, comp] of Object.entries(snapshot.components)) {
    components[key] = comp.status;
    if (comp.status !== 'healthy') {
      issues.push(comp.detail);
    }
  }

  const isHealthy = issues.length === 0 && snapshot.overall === 'healthy';
  return { isHealthy, issues, components };
}

export async function sendHeartbeatOnce(
  customFetch: typeof fetch = fetch,
): Promise<HeartbeatSendResult> {
  const config = getHeartbeatConfig();
  if (!config.enabled || !config.pingUrl) {
    return { sent: false, endpoint: null, status: 'skipped' };
  }

  const readiness = evaluateReadiness();
  const targetUrl = readiness.isHealthy
    ? config.pingUrl
    : `${config.pingUrl.replace(/\/+$/, '')}/fail`;

  const payload: HeartbeatDiagnosticPayload = {
    kioskId: config.kioskId,
    status: readiness.isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    issues: readiness.issues,
    components: readiness.components,
  };

  try {
    const res = await customFetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    return {
      sent: true,
      endpoint: targetUrl,
      status: readiness.isHealthy ? 'healthy' : 'degraded',
      statusCode: res.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[HEARTBEAT-REPORTER] Failed to dispatch heartbeat ping:', {
      endpoint: targetUrl,
      error: message,
    });
    return {
      sent: false,
      endpoint: targetUrl,
      status: 'failed',
      error: message,
    };
  }
}

export function startHeartbeatReporter(
  customFetch: typeof fetch = fetch,
): void {
  if (reporterTimer) return;

  const config = getHeartbeatConfig();
  if (!config.enabled || !config.pingUrl) {
    console.info(
      '[HEARTBEAT-REPORTER] Outbound heartbeat reporter disabled (opt-in via PRINTBIT_HEARTBEAT_ENABLED).',
    );
    return;
  }

  console.info(
    `[HEARTBEAT-REPORTER] Starting outbound heartbeat reporter (interval: ${config.intervalSec}s).`,
  );

  void sendHeartbeatOnce(customFetch);

  reporterTimer = setInterval(async () => {
    if (reporterInFlight) return;
    reporterInFlight = true;
    try {
      await sendHeartbeatOnce(customFetch);
    } finally {
      reporterInFlight = false;
    }
  }, config.intervalSec * 1000);

  reporterTimer.unref();
}

export function stopHeartbeatReporter(): void {
  if (reporterTimer) {
    clearInterval(reporterTimer);
    reporterTimer = null;
  }
  reporterInFlight = false;
}
