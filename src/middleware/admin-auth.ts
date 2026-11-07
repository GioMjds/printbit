import type { RequestHandler } from 'express';
import { db } from '@/services/db';
import {
  ADMIN_SESSION_COOKIE_OPTIONS,
  createAdminSession,
  destroyAdminSession,
  getAdminSessionDeviceId,
  validateAdminSession,
} from '@/utils/admin-session';
import {
  ADMIN_DEVICE_COOKIE,
  DEVICE_COOKIE_OPTIONS,
  adminDeviceService,
} from '@/services/admin-device.service';

function isPrivateIpv4(ip: string): boolean {
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const match172 = ip.match(/^172\.(\d+)\./);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function normalizeIp(rawIp: string): string {
  const lower = rawIp.toLowerCase();
  if (lower.startsWith('::ffff:')) return lower.slice('::ffff:'.length);
  return lower;
}

function isLocalRequestIp(rawIp: string): boolean {
  const ip = normalizeIp(rawIp);
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  return isPrivateIpv4(ip);
}

export const requireAdminLocalAccess: RequestHandler = (req, res, next) => {
  const adminLocalOnly = db.data?.settings.adminLocalOnly ?? true;
  if (!adminLocalOnly) return next();

  const remoteIp = req.ip || req.socket.remoteAddress || '';
  if (!isLocalRequestIp(remoteIp)) {
    return res
      .status(403)
      .json({ error: 'Admin access is allowed only on local network.' });
  }

  return next();
};

export const requireAdminPin: RequestHandler = async (req, res, next) => {
  const headerToken = req.get('x-admin-token') || undefined;
  const cookieToken =
    (req.cookies?.['adminToken'] as string | undefined) || undefined;
  const deviceCookie = req.cookies?.[ADMIN_DEVICE_COOKIE] as unknown;

  // Try the header token first, then the cookie token, so a stale header does
  // not mint a new session while a fresh cookie session exists.
  const candidates = [headerToken, cookieToken].filter(
    (t, i, all): t is string => !!t && all.indexOf(t) === i,
  );
  for (const token of candidates) {
    if (!validateAdminSession(token)) continue;
    const deviceId = getAdminSessionDeviceId(token);
    if (deviceId) {
      if (!adminDeviceService.getById(deviceId)) {
        // Session must not outlive its device.
        destroyAdminSession(token);
        continue;
      }
      const touched = await adminDeviceService
        .touch(deviceId)
        .catch(() => false);
      if (touched && typeof deviceCookie === 'string') {
        res.cookie(ADMIN_DEVICE_COOKIE, deviceCookie, DEVICE_COOKIE_OPTIONS);
      }
    }
    res.locals.adminDeviceId = deviceId;
    res.locals.adminSessionToken = token;
    return next();
  }

  // Session missing or unknown (server restart, expiry): re-derive it from
  // the persisted device cookie.
  const device = await adminDeviceService
    .verifyCookie(deviceCookie)
    .catch(() => null);
  if (device) {
    const sessionToken = createAdminSession(device.id);
    res.cookie('adminToken', sessionToken, ADMIN_SESSION_COOKIE_OPTIONS);
    if (typeof deviceCookie === 'string') {
      res.cookie(ADMIN_DEVICE_COOKIE, deviceCookie, DEVICE_COOKIE_OPTIONS);
    }
    // Lets a client holding a stale x-admin-token header switch to the new one.
    res.setHeader('x-admin-session-token', sessionToken);
    res.locals.adminDeviceId = device.id;
    res.locals.adminSessionToken = sessionToken;
    return next();
  }

  return res.status(401).json({
    error: 'Admin session invalid or expired. Please log in again.',
  });
};
