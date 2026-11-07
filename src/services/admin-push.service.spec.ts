jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    generateVAPIDKeys: jest.fn(() => ({ publicKey: 'pub', privateKey: 'priv' })),
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(),
  },
}));
jest.mock('./db', () => ({ db: { data: null, write: jest.fn() } }));
jest.mock('./anomaly', () => ({ anomalyService: { report: jest.fn() } }));

import webpush from 'web-push';
import { AdminPushService, EndpointOwnedError } from './admin-push.service';

const sendNotification = webpush.sendNotification as unknown as jest.Mock;

function makeService(
  subs: Array<{ endpoint: string; deviceId?: string }>,
  devices: Array<{ id: string; minSeverity: 'critical' | 'warning' }> = [],
) {
  const data: any = {
    settings: {
      pushNotifications: {
        enabled: true,
        cooldownSeconds: 30,
        vapidKeys: { publicKey: 'pub', privateKey: 'priv' },
      },
    },
    adminDevices: devices.map((d) => ({
      id: d.id,
      label: d.id,
      tokenHash: 'h',
      minSeverity: d.minSeverity,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    })),
    adminPushSubscriptions: subs.map((s, i) => ({
      id: `id-${i}`,
      endpoint: s.endpoint,
      keys: { p256dh: 'p', auth: 'a' },
      userAgent: 'jest',
      createdAt: new Date().toISOString(),
      lastNotifiedAt: null,
      deviceId: s.deviceId,
    })),
  };
  const service = new AdminPushService({
    getDbData: () => data,
    writeDb: async () => {},
    emitSocket: () => {},
    reportAnomaly: async () => ({}),
    retryDelayMs: 0,
  });
  return { service, data };
}

const alert = {
  code: 'PAPER_JAM',
  title: 't',
  message: 'm',
  severity: 'critical' as const,
};

describe('AdminPushService.broadcastCriticalAlert', () => {
  beforeEach(() => sendNotification.mockReset());

  it('retries transient network errors and delivers', async () => {
    sendNotification
      .mockRejectedValueOnce(Object.assign(new Error('ECONNRESET'), {}))
      .mockResolvedValueOnce({});
    const { service } = makeService([{ endpoint: 'https://fcm/1' }]);

    const result = await service.broadcastCriticalAlert(alert);

    expect(result.sent).toBe(1);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('passes a request timeout to web-push', async () => {
    sendNotification.mockResolvedValue({});
    const { service } = makeService([{ endpoint: 'https://fcm/1' }]);

    await service.broadcastCriticalAlert(alert);

    expect(sendNotification.mock.calls[0][2].timeout).toBeGreaterThan(0);
  });

  it('does not retry permanent 4xx errors', async () => {
    sendNotification.mockRejectedValue(
      Object.assign(new Error('bad'), { statusCode: 400 }),
    );
    const { service } = makeService([{ endpoint: 'https://fcm/1' }]);

    await service.broadcastCriticalAlert(alert);

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('does not burn the cooldown when nothing was delivered', async () => {
    sendNotification.mockRejectedValue(
      Object.assign(new Error('down'), { statusCode: 503 }),
    );
    const { service } = makeService([{ endpoint: 'https://fcm/1' }]);

    const first = await service.broadcastCriticalAlert(alert);
    expect(first.sent).toBe(0);

    sendNotification.mockReset();
    sendNotification.mockResolvedValue({});
    const second = await service.broadcastCriticalAlert(alert);
    expect(second.sent).toBe(1);
  });

  it.each([401, 403, 404, 410])('prunes subscription on %i', async (statusCode) => {
    sendNotification.mockRejectedValue(
      Object.assign(new Error('dead'), { statusCode }),
    );
    const { service, data } = makeService([{ endpoint: 'https://fcm/1' }]);

    const result = await service.broadcastCriticalAlert(alert);

    expect(result.pruned).toBe(1);
    expect(data.adminPushSubscriptions).toHaveLength(0);
  });
});

describe('AdminPushService.hasSubscription', () => {
  it('reports whether endpoint is stored', () => {
    const { service } = makeService([{ endpoint: 'https://fcm/1' }]);
    expect(service.hasSubscription('https://fcm/1')).toBe(true);
    expect(service.hasSubscription('https://fcm/2')).toBe(false);
  });
});

describe('AdminPushService severity routing', () => {
  beforeEach(() => sendNotification.mockReset());

  const warningAlert = { ...alert, severity: 'warning' as const };

  it('skips a critical-only device for a warning alert but delivers to an everything device', async () => {
    sendNotification.mockResolvedValue({});
    const { service, data } = makeService(
      [
        { endpoint: 'https://fcm/phone', deviceId: 'phone' },
        { endpoint: 'https://fcm/laptop', deviceId: 'laptop' },
      ],
      [
        { id: 'phone', minSeverity: 'critical' },
        { id: 'laptop', minSeverity: 'warning' },
      ],
    );

    const result = await service.broadcastCriticalAlert(warningAlert);

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: 1 });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0].endpoint).toBe(
      'https://fcm/laptop',
    );
    expect(data.adminPushSubscriptions).toHaveLength(2); // skipped is not pruned
  });

  it('delivers a critical alert to every device', async () => {
    sendNotification.mockResolvedValue({});
    const { service } = makeService(
      [
        { endpoint: 'https://fcm/phone', deviceId: 'phone' },
        { endpoint: 'https://fcm/laptop', deviceId: 'laptop' },
      ],
      [
        { id: 'phone', minSeverity: 'critical' },
        { id: 'laptop', minSeverity: 'warning' },
      ],
    );

    const result = await service.broadcastCriticalAlert(alert);

    expect(result).toEqual({ sent: 2, pruned: 0, skipped: 0 });
  });

  it('fails open: legacy subscriptions and ones whose device is missing still get alerts', async () => {
    sendNotification.mockResolvedValue({});
    const { service } = makeService(
      [
        { endpoint: 'https://fcm/legacy' },
        { endpoint: 'https://fcm/orphan', deviceId: 'gone' },
      ],
      [],
    );

    const result = await service.broadcastCriticalAlert(warningAlert);

    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(0);
  });
});

describe('AdminPushService ownership', () => {
  beforeEach(() => sendNotification.mockReset());

  it('subscribe links the subscription to the device and replaces its previous endpoint', async () => {
    const { service, data } = makeService([
      { endpoint: 'https://fcm/old', deviceId: 'phone' },
    ]);

    await service.subscribe(
      { endpoint: 'https://fcm/new', keys: { p256dh: 'p', auth: 'a' } },
      'phone',
      'jest',
    );

    expect(data.adminPushSubscriptions.map((s: any) => s.endpoint)).toEqual([
      'https://fcm/new',
    ]);
    expect(data.adminPushSubscriptions[0].deviceId).toBe('phone');
  });

  it('keeps the cooldown when every subscription is skipped', async () => {
    const { service } = makeService(
      [
        { endpoint: 'https://fcm/a', deviceId: 'd1' },
        { endpoint: 'https://fcm/b', deviceId: 'd1' },
      ],
      [{ id: 'd1', minSeverity: 'critical' }],
    );
    const warn = { ...alert, severity: 'warning' as const };
    expect(await service.broadcastCriticalAlert(warn)).toEqual({
      sent: 0,
      pruned: 0,
      skipped: 2,
    });
    expect(await service.broadcastCriticalAlert(warn)).toEqual({
      sent: 0,
      pruned: 0,
      skipped: 0,
    });
  });

  it('takeover with different keys is refused and leaves the stored sub untouched', async () => {
    const { service, data } = makeService(
      [{ endpoint: 'https://fcm/a', deviceId: 'old-device' }],
      [{ id: 'old-device', minSeverity: 'warning' }],
    );
    await expect(
      service.subscribe(
        { endpoint: 'https://fcm/a', keys: { p256dh: 'x', auth: 'y' } },
        'new-device',
      ),
    ).rejects.toBeInstanceOf(EndpointOwnedError);
    expect(data.adminPushSubscriptions[0].deviceId).toBe('old-device');
    expect(data.adminPushSubscriptions[0].keys).toEqual({
      p256dh: 'p',
      auth: 'a',
    });
  });

  it('takeover with matching keys works', async () => {
    const { service, data } = makeService(
      [{ endpoint: 'https://fcm/a', deviceId: 'old-device' }],
      [{ id: 'old-device', minSeverity: 'warning' }],
    );
    await service.subscribe(
      { endpoint: 'https://fcm/a', keys: { p256dh: 'p', auth: 'a' } },
      'new-device',
    );
    expect(data.adminPushSubscriptions[0].deviceId).toBe('new-device');
  });

  it('takeover of an orphan-owned endpoint works with different keys', async () => {
    const { service, data } = makeService([
      { endpoint: 'https://fcm/a', deviceId: 'deleted-device' },
    ]);
    await service.subscribe(
      { endpoint: 'https://fcm/a', keys: { p256dh: 'x', auth: 'y' } },
      'new-device',
    );
    expect(data.adminPushSubscriptions[0].deviceId).toBe('new-device');
    expect(data.adminPushSubscriptions[0].keys).toEqual({
      p256dh: 'x',
      auth: 'y',
    });
  });

  it('subscribe lets a device take over an endpoint owned by another device or nobody', async () => {
    const { service, data } = makeService([
      { endpoint: 'https://fcm/a', deviceId: 'old-device' },
      { endpoint: 'https://fcm/b' },
    ]);

    await service.subscribe(
      { endpoint: 'https://fcm/a', keys: { p256dh: 'p', auth: 'a' } },
      'new-device',
    );
    await service.subscribe(
      { endpoint: 'https://fcm/b', keys: { p256dh: 'p', auth: 'a' } },
      'new-device',
    );

    const byEndpoint = Object.fromEntries(
      data.adminPushSubscriptions.map((s: any) => [s.endpoint, s.deviceId]),
    );
    expect(byEndpoint['https://fcm/b']).toBe('new-device');
    // the replace rule keeps one subscription per device
    expect(
      data.adminPushSubscriptions.filter(
        (s: any) => s.deviceId === 'new-device',
      ),
    ).toHaveLength(1);
  });

  it('unsubscribe removes own, refuses foreign, reports absent', async () => {
    const { service, data } = makeService([
      { endpoint: 'https://fcm/a', deviceId: 'phone' },
    ]);

    expect(await service.unsubscribe('https://fcm/a', 'laptop')).toBe(
      'forbidden',
    );
    expect(data.adminPushSubscriptions).toHaveLength(1);
    expect(await service.unsubscribe('https://fcm/missing', 'phone')).toBe(
      'absent',
    );
    expect(await service.unsubscribe('https://fcm/a', 'phone')).toBe('removed');
    expect(data.adminPushSubscriptions).toHaveLength(0);
  });

  it('test push is refused for a foreign subscription and ignores minSeverity for the owner', async () => {
    sendNotification.mockResolvedValue({});
    const { service } = makeService(
      [{ endpoint: 'https://fcm/a', deviceId: 'phone' }],
      [{ id: 'phone', minSeverity: 'critical' }],
    );

    expect(await service.sendTestNotification('https://fcm/a', 'laptop')).toBe(
      false,
    );
    expect(sendNotification).not.toHaveBeenCalled();
    expect(await service.sendTestNotification('https://fcm/a', 'phone')).toBe(
      true,
    );
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('hasSubscription with a device id is true only for the owner', () => {
    const { service } = makeService([
      { endpoint: 'https://fcm/a', deviceId: 'phone' },
      { endpoint: 'https://fcm/legacy' },
    ]);

    expect(service.hasSubscription('https://fcm/a', 'phone')).toBe(true);
    expect(service.hasSubscription('https://fcm/a', 'laptop')).toBe(false);
    expect(service.hasSubscription('https://fcm/legacy', 'phone')).toBe(false);
    expect(service.hasSubscription('https://fcm/a')).toBe(true);
  });
});
