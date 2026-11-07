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
import { AdminPushService } from './admin-push.service';

const sendNotification = webpush.sendNotification as unknown as jest.Mock;

function makeService(subs: Array<{ endpoint: string }>) {
  const data: any = {
    settings: {
      pushNotifications: {
        enabled: true,
        cooldownSeconds: 30,
        vapidKeys: { publicKey: 'pub', privateKey: 'priv' },
      },
    },
    adminPushSubscriptions: subs.map((s, i) => ({
      id: `id-${i}`,
      endpoint: s.endpoint,
      keys: { p256dh: 'p', auth: 'a' },
      userAgent: 'jest',
      createdAt: new Date().toISOString(),
      lastNotifiedAt: null,
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
