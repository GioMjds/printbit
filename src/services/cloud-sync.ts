import { getCloudSyncConfig } from '@/config/cloud-sync.config';
import { getWatchdogHealthSnapshot } from '@/services/watchdog-health';
import { db } from '@/core/database/db';

export interface CloudSyncResult {
  synced: boolean;
  status: 'synced' | 'skipped' | 'failed';
  statusCode?: number;
  error?: string;
}

let syncTimer: NodeJS.Timeout | null = null;
let syncInFlight = false;

export function gatherKioskSnapshot() {
  const config = getCloudSyncConfig();
  const snapshot = getWatchdogHealthSnapshot();
  const issues: string[] = [];
  const hardware: Record<string, string> = {};

  for (const [key, comp] of Object.entries(snapshot.components)) {
    hardware[key] = comp.status;
    if (comp.status !== 'healthy') {
      issues.push(comp.detail);
    }
  }

  const earningsToday = db.data?.earnings || 0;
  const jobsToday =
    (db.data?.jobStats?.print || 0) +
    (db.data?.jobStats?.copy || 0) +
    (db.data?.jobStats?.scan || 0);

  return {
    kioskId: config.kioskId,
    timestamp: new Date().toISOString(),
    status: snapshot.overall === 'healthy' ? 'healthy' : 'degraded',
    uptimeSec: Math.floor(process.uptime()),
    hardware,
    summary: {
      earningsToday,
      jobsToday,
      owedChange: 0,
      inkGrayscale: 100,
      inkColor: 100,
      issues,
    },
  };
}

export async function sendCloudSyncOnce(
  customFetch: typeof fetch = fetch,
): Promise<CloudSyncResult> {
  const config = getCloudSyncConfig();
  if (!config.enabled || !config.syncUrl) {
    return { synced: false, status: 'skipped' };
  }

  const payload = gatherKioskSnapshot();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.secret) {
    headers.Authorization = `Bearer ${config.secret}`;
  }

  try {
    const res = await customFetch(config.syncUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    return {
      synced: res.ok,
      status: res.ok ? 'synced' : 'failed',
      statusCode: res.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[CLOUD-SYNC] Failed to push kiosk telemetry to edge:', message);
    return {
      synced: false,
      status: 'failed',
      error: message,
    };
  }
}

export function startCloudSync(customFetch: typeof fetch = fetch): void {
  if (syncTimer) return;

  const config = getCloudSyncConfig();
  if (!config.enabled || !config.syncUrl) {
    return;
  }

  console.info(`[CLOUD-SYNC] Starting cloud telemetry sync to ${config.syncUrl} (every ${config.intervalSec}s).`);
  void sendCloudSyncOnce(customFetch);

  syncTimer = setInterval(async () => {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
      await sendCloudSyncOnce(customFetch);
    } finally {
      syncInFlight = false;
    }
  }, config.intervalSec * 1000);

  syncTimer.unref();
}

export function stopCloudSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  syncInFlight = false;
}
