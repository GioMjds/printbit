import os from 'node:os';
import path from 'node:path';

export const PORT = 3000;
export const UPLOAD_DIR = 'uploads/';
export const PORTAL_ASSETS = new Set(['styles.css', 'app.js']);
export const PORTAL_DIR = path.resolve('src/public/upload');
export const PUBLIC_DIR = path.resolve('src/public');
export const PREVIEW_CACHE_DIR = path.join(
  os.tmpdir(),
  'printbit-preview-cache',
);

/** Hotspot settings (configurable via env) */
export const HOTSPOT_SSID =
  process.env.PRINTBIT_HOTSPOT_SSID ?? 'PrintBit-Kiosk';
export const HOTSPOT_PASSWORD =
  process.env.PRINTBIT_HOTSPOT_PASSWORD ?? 'printbit123';
export const CAPTIVE_PORTAL_ENABLED =
  process.env.PRINTBIT_CAPTIVE_PORTAL !== 'false';

/** MyPublicWiFi installation path */
export const MYPUBLICWIFI_PATH =
  process.env.PRINTBIT_MYPUBLICWIFI_PATH ??
  path.join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'MyPublicWiFi',
  );

/** Optional public URL override for tunnel/reverse-proxy (e.g. Cloudflare Tunnel). */
export const PUBLIC_URL =
  process.env.PRINTBIT_PUBLIC_URL?.replace(/\/+$/, '') || undefined;

export const PUBLIC_PAGE_ROUTES: Array<{ route: string; filePath: string }> = [
  { route: '/', filePath: path.join(PUBLIC_DIR, 'index.html') },
  { route: '/print', filePath: path.join(PUBLIC_DIR, 'print', 'index.html') },
  { route: '/copy', filePath: path.join(PUBLIC_DIR, 'copy', 'index.html') },
  { route: '/config', filePath: path.join(PUBLIC_DIR, 'config', 'index.html') },
  {
    route: '/confirm',
    filePath: path.join(PUBLIC_DIR, 'confirm', 'index.html'),
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
    route: '/admin/coins',
    filePath: path.join(PUBLIC_DIR, 'admin', 'coin-stats', 'index.html'),
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
    route: '/admin/feedback',
    filePath: path.join(PUBLIC_DIR, 'admin', 'feedback', 'index.html'),
  },
  {
    route: '/admin/report',
    filePath: path.join(PUBLIC_DIR, 'admin', 'report', 'index.html'),
  },
];
