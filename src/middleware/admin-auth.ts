import type { RequestHandler } from 'express';
import { db } from '@/services/db';
import { validateAdminSession } from '@/utils/admin-session';

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
  if (!db.data!.settings.adminLocalOnly) return next();

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
  const cookieToken = (req.cookies?.['adminToken'] as string | undefined) || undefined;
  const token = headerToken ?? cookieToken;
  if (!token || !validateAdminSession(token)) {
    return res.status(401).json({
      error: 'Admin session invalid or expired. Please log in again.',
    });
  }
  return next();
};
