jest.mock('./db', () => ({ db: { data: null, write: jest.fn() } }));

import {
  AdminDeviceService,
  AdminDeviceValidationError,
  DEVICE_COOKIE_TTL_MS,
  MAX_ADMIN_DEVICES,
  MAX_DEVICE_LABEL_LENGTH,
  defaultLabelFromUserAgent,
} from './admin-device.service';

function makeService(onWrite?: (data: any) => void) {
  const data: any = { adminDevices: [], adminPushSubscriptions: [] };
  let nowMs = 1_000_000;
  const service = new AdminDeviceService({
    getDbData: () => data,
    writeDb: async () => {
      onWrite?.(data);
    },
    now: () => nowMs,
  });
  return {
    service,
    data,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('defaultLabelFromUserAgent', () => {
  it('names iPhone Safari before generic Mac', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
    expect(defaultLabelFromUserAgent(ua)).toBe('iPhone Safari');
  });

  it('names Windows Edge and Android Chrome', () => {
    expect(
      defaultLabelFromUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36 Edg/120.0',
      ),
    ).toBe('Windows Edge');
    expect(
      defaultLabelFromUserAgent(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
      ),
    ).toBe('Android Chrome');
  });

  it('falls back to "Device" for an empty user agent', () => {
    expect(defaultLabelFromUserAgent('')).toBe('Device');
  });
});

describe('AdminDeviceService.enroll / verifyCookie', () => {
  it('enrolls a device that verifies with its own cookie', async () => {
    const { service, data } = makeService();
    const { device, cookieValue } = await service.enroll('Phone', 'ua');

    expect(device.label).toBe('Phone');
    expect(device.minSeverity).toBe('warning');
    expect(data.adminDevices).toHaveLength(1);
    expect(device.tokenHash).not.toContain(cookieValue.split('.')[1]);
    expect((await service.verifyCookie(cookieValue))?.id).toBe(device.id);
  });

  it('uses the user agent label when no label is given and trims/truncates labels', async () => {
    const { service } = makeService();
    const generated = await service.enroll(
      undefined,
      'Mozilla/5.0 (Windows NT 10.0) Chrome/1 Safari/1',
    );
    expect(generated.device.label).toBe('Windows Chrome');

    const long = await service.enroll(`  ${'x'.repeat(100)}  `, 'ua');
    expect(long.device.label).toHaveLength(MAX_DEVICE_LABEL_LENGTH);
  });

  it('rejects a wrong secret', async () => {
    const { service } = makeService();
    const { device } = await service.enroll('Phone', 'ua');
    expect(
      await service.verifyCookie(`${device.id}.not-the-secret`),
    ).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['no dot', 'nodot'],
    ['empty id', '.secret'],
    ['empty secret', 'someid.'],
    ['500 characters', 'x'.repeat(500)],
    ['non-string', 12345],
  ])('returns null for malformed cookie: %s', async (_name, value) => {
    const { service } = makeService();
    await service.enroll('Phone', 'ua');
    expect(await service.verifyCookie(value)).toBeNull();
  });

  it('returns null (does not throw) when the stored hash has the wrong length', async () => {
    const { service, data } = makeService();
    const { device, cookieValue } = await service.enroll('Phone', 'ua');
    data.adminDevices[0].tokenHash = 'abc';
    expect(device.id).toBe(data.adminDevices[0].id);
    await expect(service.verifyCookie(cookieValue)).resolves.toBeNull();
  });

  it('expires a device unseen for longer than the cookie lifetime', async () => {
    const { service, advance } = makeService();
    const { cookieValue } = await service.enroll('Phone', 'ua');
    advance(DEVICE_COOKIE_TTL_MS + 1);
    expect(await service.verifyCookie(cookieValue)).toBeNull();
  });

  it('slides lastSeenAt forward when the device was last seen over 5 minutes ago', async () => {
    const { service, data, advance } = makeService();
    const { cookieValue } = await service.enroll('Phone', 'ua');
    const first = data.adminDevices[0].lastSeenAt;
    advance(6 * 60 * 1000);
    await service.verifyCookie(cookieValue);
    expect(data.adminDevices[0].lastSeenAt).not.toBe(first);
  });
});

describe('AdminDeviceService.touch', () => {
  it('writes only when idle over 5 minutes and reports whether it did', async () => {
    const { service, data, advance } = makeService();
    const { device } = await service.enroll('Phone', 'ua');
    const first = data.adminDevices[0].lastSeenAt;
    advance(60 * 1000);
    expect(await service.touch(device.id)).toBe(false);
    expect(data.adminDevices[0].lastSeenAt).toBe(first);
    advance(6 * 60 * 1000);
    expect(await service.touch(device.id)).toBe(true);
    expect(data.adminDevices[0].lastSeenAt).not.toBe(first);
    expect(await service.touch('missing')).toBe(false);
  });

  it('verifyCookie returns null when the device is removed during the touch write', async () => {
    let armed = false;
    const { service, advance } = makeService((d) => {
      if (armed) d.adminDevices = [];
    });
    const { cookieValue } = await service.enroll('Phone', 'ua');
    advance(6 * 60 * 1000);
    armed = true;
    expect(await service.verifyCookie(cookieValue)).toBeNull();
  });
});

describe('AdminDeviceService.resolveOrEnroll', () => {
  it('reuses the presented device when the cookie is valid', async () => {
    const { service, data } = makeService();
    const first = await service.enroll('Phone', 'ua');
    const again = await service.resolveOrEnroll(
      first.cookieValue,
      undefined,
      'ua',
    );

    expect(again.device.id).toBe(first.device.id);
    expect(again.cookieValue).toBe(first.cookieValue);
    expect(data.adminDevices).toHaveLength(1);
  });

  it('enrolls a new device when the cookie is missing or invalid', async () => {
    const { service, data } = makeService();
    await service.resolveOrEnroll(undefined, 'Laptop', 'ua');
    await service.resolveOrEnroll('garbage', 'Laptop 2', 'ua');
    expect(data.adminDevices).toHaveLength(2);
  });
});

describe('AdminDeviceService cap', () => {
  it('evicts the least recently seen device and its subscriptions, never the new one', async () => {
    const { service, data, advance } = makeService();
    const first = await service.enroll('first', 'ua');
    data.adminPushSubscriptions.push({
      id: 's1',
      endpoint: 'e1',
      deviceId: first.device.id,
    });
    for (let i = 1; i < MAX_ADMIN_DEVICES; i++) {
      advance(1000);
      await service.enroll(`d${i}`, 'ua');
    }
    expect(data.adminDevices).toHaveLength(MAX_ADMIN_DEVICES);

    advance(1000);
    const newest = await service.enroll('newest', 'ua');

    expect(data.adminDevices).toHaveLength(MAX_ADMIN_DEVICES);
    expect(data.adminDevices.some((d: any) => d.id === first.device.id)).toBe(
      false,
    );
    expect(data.adminDevices.some((d: any) => d.id === newest.device.id)).toBe(
      true,
    );
    expect(data.adminPushSubscriptions).toHaveLength(0);
  });
});

describe('AdminDeviceService.update / revoke / list', () => {
  it('updates label and severity with validation', async () => {
    const { service } = makeService();
    const { device } = await service.enroll('Phone', 'ua');

    const updated = await service.update(device.id, {
      label: '  Shop laptop ',
      minSeverity: 'critical',
    });
    expect(updated?.label).toBe('Shop laptop');
    expect(updated?.minSeverity).toBe('critical');

    await expect(
      service.update(device.id, { minSeverity: 'info' }),
    ).rejects.toBeInstanceOf(AdminDeviceValidationError);
    await expect(
      service.update(device.id, { label: '   ' }),
    ).rejects.toBeInstanceOf(AdminDeviceValidationError);
    expect(await service.update('missing', { label: 'x' })).toBeNull();
  });

  it('revoke removes the device and its subscriptions only', async () => {
    const { service, data } = makeService();
    const a = await service.enroll('A', 'ua');
    const b = await service.enroll('B', 'ua');
    data.adminPushSubscriptions.push(
      { id: 's1', endpoint: 'e1', deviceId: a.device.id },
      { id: 's2', endpoint: 'e2', deviceId: b.device.id },
    );

    expect(await service.revoke(a.device.id)).toBe(true);
    expect(await service.revoke(a.device.id)).toBe(false);
    expect(data.adminDevices.map((d: any) => d.id)).toEqual([b.device.id]);
    expect(data.adminPushSubscriptions.map((s: any) => s.id)).toEqual(['s2']);
    expect(await service.verifyCookie(a.cookieValue)).toBeNull();
  });

  it('list marks the current device and push registration', async () => {
    const { service, data } = makeService();
    const a = await service.enroll('A', 'ua');
    const b = await service.enroll('B', 'ua');
    data.adminPushSubscriptions.push({
      id: 's1',
      endpoint: 'e1',
      deviceId: b.device.id,
    });

    const rows = service.list(a.device.id);
    const rowA = rows.find((r) => r.id === a.device.id)!;
    const rowB = rows.find((r) => r.id === b.device.id)!;
    expect(rowA.isCurrent).toBe(true);
    expect(rowA.hasPush).toBe(false);
    expect(rowB.isCurrent).toBe(false);
    expect(rowB.hasPush).toBe(true);
    expect(Object.keys(rowA)).not.toContain('tokenHash');
  });
});
