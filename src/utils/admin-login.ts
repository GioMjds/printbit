import type { Request, Response } from 'express';
import {
  ADMIN_DEVICE_COOKIE,
  DEVICE_COOKIE_OPTIONS,
  adminDeviceService,
} from '@/services/admin-device.service';
import {
  ADMIN_SESSION_COOKIE_OPTIONS,
  createAdminSession,
} from './admin-session';

/**
 * Call after the PIN was accepted. Reuses or enrols the calling device, then
 * creates a device-bound session and sets the session and device cookies.
 */
export async function establishAdminSession(
  req: Request,
  res: Response,
): Promise<string> {
  const label =
    typeof req.body?.deviceLabel === 'string'
      ? req.body.deviceLabel
      : undefined;
  try {
    const { device, cookieValue } = await adminDeviceService.resolveOrEnroll(
      req.cookies?.[ADMIN_DEVICE_COOKIE],
      label,
      req.get('user-agent') ?? '',
    );
    const sessionToken = createAdminSession(device.id);
    res.cookie('adminToken', sessionToken, ADMIN_SESSION_COOKIE_OPTIONS);
    res.cookie(ADMIN_DEVICE_COOKIE, cookieValue, DEVICE_COOKIE_OPTIONS);
    res.locals.adminDeviceId = device.id;
    return sessionToken;
  } catch (err) {
    // Never block a correct PIN on device bookkeeping; push will report
    // DEVICE_REQUIRED until the next successful login.
    console.error(
      '[ADMIN] Device enrolment failed, using anonymous session',
      err,
    );
    const sessionToken = createAdminSession();
    res.cookie('adminToken', sessionToken, ADMIN_SESSION_COOKIE_OPTIONS);
    return sessionToken;
  }
}

export function clearAdminSessionCookies(res: Response): void {
  res.clearCookie('adminToken');
  res.clearCookie(ADMIN_DEVICE_COOKIE);
}
