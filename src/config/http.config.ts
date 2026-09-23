import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 3000;
const rawPort = process.env.PORT?.trim();
const parsedPort =
  rawPort !== undefined && /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
export const PORT =
  Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : DEFAULT_PORT;
export const UPLOAD_DIR = 'uploads/';
const rawWorkerQueueDir = process.env.PRINTBIT_WORKER_QUEUE_DIR?.trim();
export const WORKER_QUEUE_DIR =
  rawWorkerQueueDir && rawWorkerQueueDir.length > 0
    ? rawWorkerQueueDir
    : undefined;
const rawWorkerFailedDir = process.env.PRINTBIT_WORKER_FAILED_DIR?.trim();
export const WORKER_FAILED_DIR =
  rawWorkerFailedDir && rawWorkerFailedDir.length > 0
    ? rawWorkerFailedDir
    : undefined;
export const WORKER_PIPE_NAME =
  process.env.PRINTBIT_WORKER_PIPE_NAME?.trim() || 'printbit-node-errors';
const rawWorkerPrechecks =
  process.env.PRINTBIT_WORKER_PRECHECKS_ENABLED?.trim().toLowerCase();
const WORKER_PRECHECKS_DISABLED_TOKENS = new Set(['0', 'false', 'no', 'off']);
export const WORKER_PRECHECKS_ENABLED =
  rawWorkerPrechecks === undefined
    ? true
    : !WORKER_PRECHECKS_DISABLED_TOKENS.has(rawWorkerPrechecks);
export const WORKER_RETURN_PIPE_NAME =
  process.env.PRINTBIT_WORKER_RETURN_PIPE_NAME?.trim() ||
  'printbit-worker-events';
export const WORKER_COMMAND_PIPE_NAME =
  process.env.PRINTBIT_WORKER_COMMAND_PIPE_NAME?.trim() ||
  'printbit-worker-commands';
export const DOCUMENT_CONVERSION_PIPE_NAME =
  process.env.PRINTBIT_DOCUMENT_CONVERSION_PIPE_NAME?.trim() ||
  'printbit-document-conversion';
export const PORTAL_ASSETS = new Set(['styles.css', 'app.js']);
export const PUBLIC_DIR = path.resolve('src', 'public');
export const PORTAL_DIR = path.resolve(PUBLIC_DIR, 'upload');
export const PREVIEW_CACHE_DIR = path.join(
  os.tmpdir(),
  'printbit-preview-cache',
);

export const NETWORK_PROVIDER =
  process.env.PRINTBIT_NETWORK_PROVIDER?.trim().toLowerCase() || 'esp32';
const DEFAULT_HOTSPOT_SSID = 'PrintBit';
const DEFAULT_HOTSPOT_PASSWORD = '';

/** Hotspot settings (configurable via env) */
export const HOTSPOT_SSID =
  process.env.PRINTBIT_HOTSPOT_SSID ?? DEFAULT_HOTSPOT_SSID;
export const HOTSPOT_PASSWORD =
  process.env.PRINTBIT_HOTSPOT_PASSWORD ?? DEFAULT_HOTSPOT_PASSWORD;
const rawHotspotAuthType = process.env.PRINTBIT_HOTSPOT_AUTH_TYPE?.trim();
const normalizedHotspotAuthType =
  rawHotspotAuthType && rawHotspotAuthType.length > 0
    ? rawHotspotAuthType
    : HOTSPOT_PASSWORD.trim().length > 0
      ? 'WPA'
      : 'nopass';
export const HOTSPOT_AUTH_TYPE =
  HOTSPOT_PASSWORD.trim().length > 0 &&
  normalizedHotspotAuthType.toUpperCase() === 'NOPASS'
    ? 'WPA'
    : normalizedHotspotAuthType;
export const ESP32_CAPTIVE_PORTAL_PATH =
  process.env.PRINTBIT_ESP32_CAPTIVE_PORTAL_PATH ?? '/portal';
export const ESP32_AP_BASE_URL =
  process.env.PRINTBIT_ESP32_AP_BASE_URL?.trim() || 'http://192.168.4.1';
export const ESP32_REGISTER_TOKEN =
  process.env.PRINTBIT_ESP32_REGISTER_TOKEN?.trim() ||
  'printbit-register-token';
/** Optional token for the ESP32 liveness probe. Empty keeps firmware compatibility. */
export const ESP32_HEALTH_TOKEN =
  process.env.PRINTBIT_ESP32_HEALTH_TOKEN?.trim() || '';
export const ESP32_KIOSK_SUBNET_PREFIX =
  process.env.PRINTBIT_ESP32_KIOSK_SUBNET_PREFIX?.trim() || '192.168.4.';
/** Explicit kiosk IP on the ESP32 AP network (bypasses auto-detection). */
export const ESP32_KIOSK_IP =
  process.env.PRINTBIT_ESP32_KIOSK_IP?.trim() || undefined;
export const ESP32_COIN_BRIDGE_SOURCE =
  process.env.PRINTBIT_ESP32_COIN_SOURCE?.trim() || 'esp32';
const rawEsp32CoinBridgeApiKey =
  process.env.PRINTBIT_ESP32_COIN_API_KEY?.trim() || '';
if (
  process.env.NODE_ENV !== 'test' &&
  NETWORK_PROVIDER === 'esp32' &&
  rawEsp32CoinBridgeApiKey.length === 0
) {
  throw new Error(
    'PRINTBIT_ESP32_COIN_API_KEY must be set when PRINTBIT_NETWORK_PROVIDER=esp32.',
  );
}
export const ESP32_COIN_BRIDGE_API_KEY =
  rawEsp32CoinBridgeApiKey.length > 0
    ? rawEsp32CoinBridgeApiKey
    : 'printbit-coin-bridge-key';
const relaxedBridgeTokens = new Set(['1', 'true', 'yes', 'on']);
export const ESP32_COIN_BRIDGE_RELAXED_MODE = relaxedBridgeTokens.has(
  process.env.PRINTBIT_ESP32_COIN_BRIDGE_RELAXED?.trim().toLowerCase() ?? '',
);
const alwaysAcceptCoinTokens = new Set(['1', 'true', 'yes', 'on']);
const defaultAlwaysAcceptCoinsToken =
  NETWORK_PROVIDER === 'esp32' ? 'true' : 'false';
export const ESP32_ALWAYS_ACCEPT_COINS = alwaysAcceptCoinTokens.has(
  process.env.PRINTBIT_ESP32_ALWAYS_ACCEPT_COINS?.trim().toLowerCase() ??
    defaultAlwaysAcceptCoinsToken,
);
export const CAPTIVE_PORTAL_ENABLED =
  process.env.PRINTBIT_CAPTIVE_PORTAL !== 'false';

/** Kiosk lockdown controls */
export const KIOSK_LOCKDOWN_ENABLED =
  process.env.PRINTBIT_KIOSK_LOCKDOWN === 'true';
const USB_EXPORT_DISABLED_TOKENS = new Set(['false', '0', 'no', '']);
const usbExportEnv =
  process.env.PRINTBIT_USB_EXPORT_ENABLED?.trim().toLowerCase();
export const USB_EXPORT_ENABLED =
  usbExportEnv !== undefined
    ? !USB_EXPORT_DISABLED_TOKENS.has(usbExportEnv)
    : !KIOSK_LOCKDOWN_ENABLED;

/** Optional public URL override for tunnel/reverse-proxy (e.g. Cloudflare Tunnel). */
export const PUBLIC_URL =
  process.env.PRINTBIT_PUBLIC_URL?.replace(/\/+$/, '') || undefined;

const rawSessionExpiryEnabled =
  process.env.PRINTBIT_SESSION_EXPIRY_ENABLED?.trim().toLowerCase();
const SESSION_EXPIRY_DISABLED_TOKENS = new Set(['false', '0', 'no', 'off']);
export const SESSION_EXPIRY_ENABLED =
  rawSessionExpiryEnabled === undefined
    ? true
    : !SESSION_EXPIRY_DISABLED_TOKENS.has(rawSessionExpiryEnabled);

export type PrintDispatchMode = 'legacy' | 'phased' | 'new-only';

function readPathEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readPositiveIntEnv(
  value: string | undefined,
  fallback: number,
  minimum = 1,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized >= minimum ? normalized : fallback;
}

export const WORKER_RETURN_MAX_BYTES = readPositiveIntEnv(
  process.env.PRINTBIT_WORKER_RETURN_MAX_BYTES?.trim(),
  8_192,
  256,
);

const rawPrintDispatchMode = (
  process.env.PRINTBIT_PRINT_DISPATCH_MODE ??
  process.env.PRINT_DISPATCH_MODE ??
  'legacy'
)
  .trim()
  .toLowerCase();

export const PRINT_DISPATCH_MODE: PrintDispatchMode =
  rawPrintDispatchMode === 'phased' || rawPrintDispatchMode === 'new-only'
    ? rawPrintDispatchMode
    : 'legacy';

export const SUMATRA_PATH =
  readPathEnv('PRINTBIT_SUMATRA_PATH', 'SUMATRA_PATH') ??
  path.resolve('bin', 'SumatraPDF.exe');

export const PDFTOPRINTER_PATH =
  readPathEnv(
    'PRINTBIT_PDFTOPRINTER_PATH',
    'PDFTOPRINTER_PATH',
    'PDFTTOPRINTER_PATH',
  ) ?? path.resolve('bin', 'PDFtoPrinter.exe');

export const GHOSTSCRIPT_PATH = readPathEnv(
  'PRINTBIT_GHOSTSCRIPT_PATH',
  'GHOSTSCRIPT_PATH',
);

export const PRINT_DISPATCH_TIMEOUT_MS = readPositiveIntEnv(
  process.env.PRINTBIT_PRINT_DISPATCH_TIMEOUT_MS?.trim(),
  60_000,
  5_000,
);

export const PRINT_SPOOLER_MONITOR_WINDOW_MS = readPositiveIntEnv(
  process.env.PRINTBIT_PRINT_SPOOLER_MONITOR_WINDOW_MS?.trim(),
  3 * 60 * 1_000,
  30_000,
);

export const PRINT_SPOOLER_POLL_INTERVAL_MS = readPositiveIntEnv(
  process.env.PRINTBIT_PRINT_SPOOLER_POLL_INTERVAL_MS?.trim(),
  1_500,
  250,
);

export const PRINT_SPOOLER_LOOKBACK_MINUTES = readPositiveIntEnv(
  process.env.PRINTBIT_PRINT_SPOOLER_LOOKBACK_MINUTES?.trim(),
  3,
  1,
);

export const PRINT_SPOOLER_QUERY_TIMEOUT_MS = readPositiveIntEnv(
  process.env.PRINTBIT_PRINT_SPOOLER_QUERY_TIMEOUT_MS?.trim(),
  20_000,
  5_000,
);

export const PUBLIC_PAGE_ROUTES = [
  { route: '/', filePath: path.join(PUBLIC_DIR, 'index.html') },
  { route: '/print', filePath: path.join(PUBLIC_DIR, 'print', 'index.html') },
  { route: '/copy', filePath: path.join(PUBLIC_DIR, 'copy', 'index.html') },
  { route: '/config', filePath: path.join(PUBLIC_DIR, 'config', 'index.html') },
  {
    route: '/confirm',
    filePath: path.join(PUBLIC_DIR, 'confirm', 'index.html'),
  },
  {
    route: '/receipt/t/:token',
    filePath: path.join(PUBLIC_DIR, 'receipt', 'index.html'),
  },
  {
    route: '/receipt/:transactionId',
    filePath: path.join(PUBLIC_DIR, 'receipt', 'index.html'),
  },
  { route: '/scan', filePath: path.join(PUBLIC_DIR, 'scan', 'index.html') },
  {
    route: '/admin/dashboard',
    filePath: path.join(PUBLIC_DIR, 'admin', 'dashboard', 'index.html'),
  },
  {
    route: '/admin/earnings',
    filePath: path.join(PUBLIC_DIR, 'admin', 'earnings', 'index.html'),
  },
  {
    route: '/admin/system',
    filePath: path.join(PUBLIC_DIR, 'admin', 'system', 'index.html'),
  },
  {
    route: '/admin/settings',
    filePath: path.join(PUBLIC_DIR, 'admin', 'settings', 'index.html'),
  },
  {
    route: '/admin/logs',
    filePath: path.join(PUBLIC_DIR, 'admin', 'logs', 'index.html'),
  },
  {
    route: '/admin/transactions',
    filePath: path.join(PUBLIC_DIR, 'admin', 'transactions', 'index.html'),
  },
  {
    route: '/admin/feedback',
    filePath: path.join(PUBLIC_DIR, 'admin', 'feedback', 'index.html'),
  },
  {
    route: '/admin/report',
    filePath: path.join(PUBLIC_DIR, 'admin', 'report', 'index.html'),
  },
  {
    route: '/admin/alerts',
    filePath: path.join(PUBLIC_DIR, 'admin', 'alerts', 'index.html'),
  },
  {
    route: '/scc',
    filePath: path.join(PUBLIC_DIR, 'scc', 'index.html'),
  },
] satisfies { route: string; filePath: string }[];
