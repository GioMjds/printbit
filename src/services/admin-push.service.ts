import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { anomalyService } from './anomaly';
import type { Server } from 'socket.io';
import type {
  AdminPushSubscriptionEntry,
  VapidKeys,
} from '@/modules/admin/admin.schema';

export interface KioskCriticalAlert {
  code: 'PAPER_JAM' | 'PAPER_OUT' | 'PRINTER_OFFLINE' | 'HOPPER_EMPTY';
  title: string;
  message: string;
  severity: 'critical' | 'warning';
  url?: string;
}

export interface AdminPushServiceDeps {
  getDbData?: () => typeof db.data;
  writeDb?: () => Promise<void>;
  emitSocket?: (event: string, payload: unknown) => void;
  reportAnomaly?: (input: any) => Promise<any>;
}

export class AdminPushService {
  private io: Server | null = null;
  private lastAlertTimestamps = new Map<string, number>();
  private readonly deps: Required<AdminPushServiceDeps>;

  constructor(deps: AdminPushServiceDeps = {}) {
    this.deps = {
      getDbData: deps.getDbData ?? (() => db.data),
      writeDb: deps.writeDb ?? (() => db.write()),
      emitSocket:
        deps.emitSocket ?? ((event, payload) => this.io?.emit(event, payload)),
      reportAnomaly:
        deps.reportAnomaly ?? ((input) => anomalyService.report(input)),
    };
  }

  setSocketIo(io: Server): void {
    this.io = io;
  }

  ensureVapidKeys(): VapidKeys {
    const data = this.deps.getDbData();
    if (!data) throw new Error('Database not initialized');
    if (!data.settings.pushNotifications) {
      data.settings.pushNotifications = { enabled: true, cooldownSeconds: 30 };
    }
    if (!data.settings.pushNotifications.vapidKeys) {
      const keys = webpush.generateVAPIDKeys();
      data.settings.pushNotifications.vapidKeys = keys;
      void this.deps.writeDb();
    }
    const keys = data.settings.pushNotifications.vapidKeys;
    webpush.setVapidDetails(
      'mailto:admin@printbitkiosk.com',
      keys.publicKey,
      keys.privateKey,
    );
    return keys;
  }

  getPublicKey(): string {
    return this.ensureVapidKeys().publicKey;
  }

  async subscribe(
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent = 'Unknown',
  ): Promise<AdminPushSubscriptionEntry> {
    const data = this.deps.getDbData();
    if (!data) throw new Error('Database not initialized');
    if (!data.adminPushSubscriptions) data.adminPushSubscriptions = [];

    const existingIndex = data.adminPushSubscriptions.findIndex(
      (s) => s.endpoint === sub.endpoint,
    );
    const nowIso = new Date().toISOString();

    if (existingIndex >= 0) {
      data.adminPushSubscriptions[existingIndex].keys = sub.keys;
      data.adminPushSubscriptions[existingIndex].userAgent = userAgent;
      await this.deps.writeDb();
      return data.adminPushSubscriptions[existingIndex];
    }

    const entry: AdminPushSubscriptionEntry = {
      id: randomUUID(),
      endpoint: sub.endpoint,
      keys: sub.keys,
      userAgent,
      createdAt: nowIso,
      lastNotifiedAt: null,
    };
    data.adminPushSubscriptions.push(entry);
    await this.deps.writeDb();
    return entry;
  }

  async unsubscribe(endpoint: string): Promise<boolean> {
    const data = this.deps.getDbData();
    if (!data || !data.adminPushSubscriptions) return false;
    const initialLen = data.adminPushSubscriptions.length;
    data.adminPushSubscriptions = data.adminPushSubscriptions.filter(
      (s) => s.endpoint !== endpoint,
    );
    if (data.adminPushSubscriptions.length !== initialLen) {
      await this.deps.writeDb();
      return true;
    }
    return false;
  }

  async broadcastCriticalAlert(
    alert: KioskCriticalAlert,
  ): Promise<{ sent: number; pruned: number }> {
    const nowMs = Date.now();
    const lastAlert = this.lastAlertTimestamps.get(alert.code) ?? 0;
    const cooldownMs =
      (this.deps.getDbData()?.settings?.pushNotifications?.cooldownSeconds ??
        30) * 1000;

    if (nowMs - lastAlert < cooldownMs) {
      return { sent: 0, pruned: 0 };
    }
    this.lastAlertTimestamps.set(alert.code, nowMs);

    // Emit live in-app alert via Socket.IO
    this.deps.emitSocket('admin:kiosk-critical-alert', {
      ...alert,
      timestamp: new Date().toISOString(),
    });

    // Record Anomaly Incident for audit trail
    void this.deps.reportAnomaly({
      type: `kiosk_hardware_${alert.code.toLowerCase()}`,
      source: 'kiosk-hardware',
      category: 'printer',
      severity: alert.severity,
      message: alert.message,
      fingerprint: `kiosk-hardware-${alert.code}`,
      context: { alertCode: alert.code },
    });

    const data = this.deps.getDbData();
    if (!data || !data.settings.pushNotifications?.enabled) {
      return { sent: 0, pruned: 0 };
    }

    this.ensureVapidKeys();
    const subscriptions = data.adminPushSubscriptions || [];
    let sentCount = 0;
    const deadEndpoints = new Set<string>();

    const payload = JSON.stringify({
      title: alert.title,
      body: alert.message,
      tag: 'kiosk-hardware-alert',
      url: alert.url || '/admin/system',
      code: alert.code,
      severity: alert.severity,
      timestamp: new Date().toISOString(),
    });

    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          const isApple = sub.endpoint.includes('push.apple.com');
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: sub.keys,
            },
            payload,
            {
              urgency: 'high',
              topic: 'kiosk-hardware-alert',
              TTL: 86400,
              headers: isApple
                ? {
                    'apns-push-type': 'alert',
                    'apns-priority': '10',
                  }
                : undefined,
            },
          );
          sentCount++;
          sub.lastNotifiedAt = new Date().toISOString();
        } catch (err: any) {
          console.error('[ADMIN-PUSH] Delivery failed for device (' + sub.id + ', agent: ' + sub.userAgent + '):', err?.statusCode || err?.message);
          if (err.statusCode === 404 || err.statusCode === 410) {
            deadEndpoints.add(sub.endpoint);
          }
        }
      }),
    );

    let prunedCount = 0;
    if (deadEndpoints.size > 0) {
      data.adminPushSubscriptions = data.adminPushSubscriptions.filter(
        (s) => !deadEndpoints.has(s.endpoint),
      );
      prunedCount = deadEndpoints.size;
    }
    await this.deps.writeDb();

    return { sent: sentCount, pruned: prunedCount };
  }

  async sendTestNotification(endpoint: string): Promise<boolean> {
    const data = this.deps.getDbData();
    const sub = data?.adminPushSubscriptions?.find(
      (s) => s.endpoint === endpoint,
    );
    if (!sub) return false;

    this.ensureVapidKeys();
    const payload = JSON.stringify({
      title: '🔔 PrintBit Admin Test Alert',
      body: 'Push notifications are working properly on this device!',
      tag: 'kiosk-test-alert',
      url: '/admin/settings',
      timestamp: new Date().toISOString(),
    });

    try {
      const isApple = sub.endpoint.includes('push.apple.com');
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload,
        {
          urgency: 'high',
          topic: 'kiosk-test-alert',
          TTL: 3600,
          headers: isApple
            ? {
                'apns-push-type': 'alert',
                'apns-priority': '10',
              }
            : undefined,
        },
      );
      return true;
    } catch (err: any) {
      console.error('[ADMIN-PUSH] Test push failed for device (' + sub.id + '):', err?.statusCode || err?.message);
      return false;
    }
  }

  clearAlert(code: string): void {
    this.lastAlertTimestamps.delete(code);
    this.deps.emitSocket('admin:kiosk-alert-cleared', { code });
  }
}

export const adminPushService = new AdminPushService();
