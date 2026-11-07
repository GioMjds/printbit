import {
  createAdminSession,
  destroyAdminSession,
  destroySessionsForDevice,
  getAdminSessionDeviceId,
  validateAdminSession,
} from './admin-session';

describe('admin sessions with device binding', () => {
  beforeEach(() => destroyAdminSession());

  it('records the device id on a session', () => {
    const token = createAdminSession('dev-1');
    expect(validateAdminSession(token)).toBe(true);
    expect(getAdminSessionDeviceId(token)).toBe('dev-1');
  });

  it('keeps anonymous sessions working with no device id', () => {
    const token = createAdminSession();
    expect(validateAdminSession(token)).toBe(true);
    expect(getAdminSessionDeviceId(token)).toBeUndefined();
  });

  it('destroySessionsForDevice kills only that device sessions', () => {
    const a1 = createAdminSession('dev-a');
    const a2 = createAdminSession('dev-a');
    const b = createAdminSession('dev-b');

    expect(destroySessionsForDevice('dev-a')).toBe(2);

    expect(validateAdminSession(a1)).toBe(false);
    expect(validateAdminSession(a2)).toBe(false);
    expect(validateAdminSession(b)).toBe(true);
  });
});
