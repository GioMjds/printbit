import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import type { Request, RequestHandler } from 'express';
import { validateAdminSession } from '@/utils/admin-session';

export const KIOSK_COOKIE_NAME = 'printbit_kiosk';
const BOOTSTRAP_TTL_MS = 30_000;

function normalizeIp(value: string): string {
  const ip = value.trim().toLowerCase();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

let cachedLocalIps: Set<string> | null = null;
let lastLocalIpsRefreshedAt = 0;
const LOCAL_IPS_CACHE_TTL_MS = 30_000;

function getLocalMachineIps(): Set<string> {
  const now = Date.now();
  if (cachedLocalIps && now - lastLocalIpsRefreshedAt < LOCAL_IPS_CACHE_TTL_MS) {
    return cachedLocalIps;
  }
  const localIps = new Set<string>(['127.0.0.1', '::1', 'localhost']);
  try {
    const interfaces = os.networkInterfaces();
    for (const ifaceList of Object.values(interfaces)) {
      if (!ifaceList) continue;
      for (const iface of ifaceList) {
        if (iface.address) {
          localIps.add(normalizeIp(iface.address));
        }
      }
    }
  } catch {
    // ignore interface enumeration errors
  }
  cachedLocalIps = localIps;
  lastLocalIpsRefreshedAt = now;
  return localIps;
}

export function isLoopbackRequest(req: Request): boolean {
  const ip = normalizeIp(req.socket.remoteAddress ?? req.ip ?? '');
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
    return true;
  }
  const localIps = getLocalMachineIps();
  return localIps.has(ip);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export class KioskAccessService {
  private readonly kioskCredential = randomBytes(32).toString('base64url');
  private readonly bootstrapCredentials = new Map<string, number>();

  issueBootstrapCredential(now = Date.now()): string {
    this.prune(now);
    const credential = randomBytes(32).toString('base64url');
    this.bootstrapCredentials.set(credential, now + BOOTSTRAP_TTL_MS);
    return credential;
  }

  consumeBootstrapCredential(credential: string, now = Date.now()): boolean {
    this.prune(now);
    const expiresAt = this.bootstrapCredentials.get(credential);
    if (!expiresAt) return false;
    this.bootstrapCredentials.delete(credential);
    return expiresAt > now;
  }

  hasValidBootstrapCredential(credential: string, now = Date.now()): boolean {
    this.prune(now);
    const expiresAt = this.bootstrapCredentials.get(credential);
    return expiresAt !== undefined && expiresAt > now;
  }

  getCookieCredential(): string {
    return this.kioskCredential;
  }

  isKioskCredential(credential: unknown): boolean {
    return (
      typeof credential === 'string' &&
      constantTimeEqual(credential, this.kioskCredential)
    );
  }

  isKioskRequest(req: Request): boolean {
    if (isLoopbackRequest(req)) {
      return true;
    }
    const credential = req.cookies?.[KIOSK_COOKIE_NAME];
    return this.isKioskCredential(credential);
  }

  private prune(now: number): void {
    for (const [credential, expiresAt] of this.bootstrapCredentials) {
      if (expiresAt <= now) this.bootstrapCredentials.delete(credential);
    }
  }
}

export const kioskAccessService = new KioskAccessService();

const KIOSK_FORBIDDEN_HTML = `<!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Kiosk access required</title>
    <style>
    body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0d1f;color:#fff;padding:1.25rem;box-sizing:border-box}.card{max-width:32rem;background:#181730;border-radius:1rem;padding:1.5rem}a{color:#fff;font-weight:700}
    </style>
    </head>
    <body>
    <main class="card">
    <h1>This page is available on the PrintBit kiosk</h1>
    <p>Scan the QR code shown on the kiosk to continue on your phone, or open the upload portal.</p>
    <p><a href="/portal">Open upload portal</a></p>
    </main>
    </body>
    </html>`;

export function createKioskAccessMiddleware(
  service: KioskAccessService = kioskAccessService,
): RequestHandler {
  return (req, res, next) => {
    // The physical kiosk display runs on the same machine — loopback and host
    // interface requests are always authoritative kiosk origins.
    if (isLoopbackRequest(req)) {
      if (!req.cookies?.[KIOSK_COOKIE_NAME]) {
        res.cookie(KIOSK_COOKIE_NAME, service.getCookieCredential(), {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        });
      }
      next();
      return;
    }
    if (service.isKioskRequest(req)) {
      next();
      return;
    }
    const headerToken = req.get('x-admin-token') || undefined;
    const cookieToken =
      (req.cookies?.['adminToken'] as string | undefined) || undefined;
    const token = headerToken ?? cookieToken;
    if (token && validateAdminSession(token)) {
      next();
      return;
    }
    const isApiRoute =
      req.path.startsWith('/api') || (req.originalUrl && req.originalUrl.startsWith('/api'));
    if (!isApiRoute && req.accepts('html')) {
      res.status(403).type('html').send(KIOSK_FORBIDDEN_HTML);
      return;
    }
    res.status(403).json({
      error: 'Kiosk access required.',
      portal: '/portal',
    });
  };
}
