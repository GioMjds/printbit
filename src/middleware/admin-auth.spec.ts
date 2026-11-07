jest.mock('@/services/db', () => ({
  db: { data: { settings: { adminLocalOnly: false } } },
}));

const mockVerifyCookie = jest.fn();
jest.mock('@/services/admin-device.service', () => ({
  ADMIN_DEVICE_COOKIE: 'adminDevice',
  adminDeviceService: {
    verifyCookie: (...args: unknown[]) => mockVerifyCookie(...args),
  },
}));

import { requireAdminPin } from './admin-auth';
import {
  createAdminSession,
  destroyAdminSession,
  validateAdminSession,
} from '@/utils/admin-session';

function makeReq(opts: {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}) {
  return {
    get: (name: string) => opts.headers?.[name.toLowerCase()],
    cookies: opts.cookies ?? {},
  } as any;
}

function makeRes() {
  const res: any = {
    locals: {},
    cookie: jest.fn(),
    setHeader: jest.fn(),
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  return res;
}

describe('requireAdminPin', () => {
  beforeEach(() => {
    destroyAdminSession();
    mockVerifyCookie.mockReset();
  });

  it('passes a valid session and exposes its device id', async () => {
    const token = createAdminSession('dev-1');
    const res = makeRes();
    const next = jest.fn();

    await requireAdminPin(
      makeReq({ headers: { 'x-admin-token': token } }),
      res,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.locals.adminDeviceId).toBe('dev-1');
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });

  it('after a restart (no sessions) a valid device cookie mints a fresh session', async () => {
    mockVerifyCookie.mockResolvedValue({ id: 'dev-1' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminPin(
      makeReq({ cookies: { adminDevice: 'dev-1.secret' } }),
      res,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.locals.adminDeviceId).toBe('dev-1');
    const minted = res.cookie.mock.calls[0][1];
    expect(res.cookie.mock.calls[0][0]).toBe('adminToken');
    expect(res.setHeader).toHaveBeenCalledWith('x-admin-session-token', minted);
    expect(validateAdminSession(minted)).toBe(true);
  });

  it('a stale x-admin-token header plus a valid device cookie still authenticates', async () => {
    mockVerifyCookie.mockResolvedValue({ id: 'dev-1' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminPin(
      makeReq({
        headers: { 'x-admin-token': 'stale-token-from-before-restart' },
        cookies: { adminDevice: 'dev-1.secret' },
      }),
      res,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(validateAdminSession(res.setHeader.mock.calls[0][1])).toBe(true);
  });

  it('answers 401 when there is no session and the device cookie is invalid', async () => {
    mockVerifyCookie.mockResolvedValue(null);
    const res = makeRes();
    const next = jest.fn();

    await requireAdminPin(
      makeReq({ cookies: { adminDevice: 'bad' } }),
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('answers 401 when device verification throws', async () => {
    mockVerifyCookie.mockRejectedValue(new Error('db not ready'));
    const res = makeRes();
    const next = jest.fn();

    await requireAdminPin(
      makeReq({ cookies: { adminDevice: 'x.y' } }),
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
