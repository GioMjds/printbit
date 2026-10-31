export interface HeartbeatConfig {
  enabled: boolean;
  pingUrl: string | null;
  intervalSec: number;
  timeoutMs: number;
  kioskId: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function getHeartbeatConfig(): HeartbeatConfig {
  const enabled = process.env.PRINTBIT_HEARTBEAT_ENABLED === 'true';
  const rawUrl = process.env.PRINTBIT_HEARTBEAT_PING_URL?.trim();
  const pingUrl = rawUrl && rawUrl.length > 0 ? rawUrl : null;

  const rawInterval = parsePositiveInt(
    process.env.PRINTBIT_HEARTBEAT_INTERVAL_SEC,
    30,
  );
  const intervalSec = Math.max(10, Math.min(300, rawInterval));

  const rawTimeout = parsePositiveInt(
    process.env.PRINTBIT_HEARTBEAT_TIMEOUT_MS,
    5000,
  );
  const timeoutMs = Math.max(1000, Math.min(30000, rawTimeout));

  const kioskId =
    process.env.PRINTBIT_HEARTBEAT_KIOSK_ID?.trim() || 'printbit-kiosk-01';

  return {
    enabled,
    pingUrl,
    intervalSec,
    timeoutMs,
    kioskId,
  };
}
