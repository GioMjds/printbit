const mockResolveOrEnroll = jest.fn();
jest.mock('@/services/admin-device.service', () => ({
  ADMIN_DEVICE_COOKIE: 'adminDevice',
  DEVICE_COOKIE_OPTIONS: { httpOnly: true, sameSite: 'strict', maxAge: 1 },
  adminDeviceService: {
    resolveOrEnroll: (...args: unknown[]) => mockResolveOrEnroll(...args),
  },
}));

import { establishAdminSession, clearAdminSessionCookies } from './admin-login';
import {
  destroyAdminSession,
  getAdminSessionDeviceId,
  validateAdminSession,
} from './admin-session';

function makeReq(over: any = {}) {
  return {
    body: {},
    cookies: {},
    get: (name: string) =>
      name.toLowerCase() === 'user-agent' ? 'test-agent' : undefined,
    ...over,
  } as any;
}

function makeRes() {
  return { locals: {}, cookie: jest.fn(), clearCookie: jest.fn() } as any;
}

describe('establishAdminSession', () => {
  beforeEach(() => {
    destroyAdminSession();
    mockResolveOrEnroll.mockReset();
  });

  it('binds a session to the resolved device and sets both cookies', async () => {
    mockResolveOrEnroll.mockResolvedValue({
      device: { id: 'dev-1' },
      cookieValue: 'dev-1.secret',
    });
    const res = makeRes();

    const token = await establishAdminSession(
      makeReq({
        body: { deviceLabel: 'Phone' },
        cookies: { adminDevice: 'old' },
      }),
      res,
    );

    expect(mockResolveOrEnroll).toHaveBeenCalledWith(
      'old',
      'Phone',
      'test-agent',
    );
    expect(validateAdminSession(token)).toBe(true);
    expect(getAdminSessionDeviceId(token)).toBe('dev-1');
    const names = res.cookie.mock.calls.map((c: any[]) => c[0]);
    expect(names).toEqual(
      expect.arrayContaining(['adminToken', 'adminDevice']),
    );
    expect(res.locals.adminDeviceId).toBe('dev-1');
  });

  it('ignores a non-string deviceLabel', async () => {
    mockResolveOrEnroll.mockResolvedValue({
      device: { id: 'd' },
      cookieValue: 'd.s',
    });
    await establishAdminSession(
      makeReq({ body: { deviceLabel: { evil: true } } }),
      makeRes(),
    );
    expect(mockResolveOrEnroll).toHaveBeenCalledWith(
      undefined,
      undefined,
      'test-agent',
    );
  });

  it('still logs in with an anonymous session when enrolment fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockResolveOrEnroll.mockRejectedValue(new Error('db down'));
    const res = makeRes();

    const token = await establishAdminSession(makeReq(), res);

    expect(validateAdminSession(token)).toBe(true);
    expect(getAdminSessionDeviceId(token)).toBeUndefined();
    expect(res.cookie.mock.calls.map((c: any[]) => c[0])).toEqual([
      'adminToken',
    ]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('clearAdminSessionCookies', () => {
  it('clears both cookies so the device cookie cannot undo a logout', () => {
    const res = makeRes();
    clearAdminSessionCookies(res);
    expect(res.clearCookie.mock.calls.map((c: any[]) => c[0]).sort()).toEqual([
      'adminDevice',
      'adminToken',
    ]);
  });
});
