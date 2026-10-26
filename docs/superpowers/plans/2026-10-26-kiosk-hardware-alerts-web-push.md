# Kiosk Hardware Alerts & Web Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement real-time Web Push notifications and in-app emergency siren/banner for critical kiosk hardware events (Paper Jam, Paper Out, Printer Offline, Coin Hopper Empty) on `admin.printbitkiosk.com`.

**Architecture:** A native `web-push` subsystem on Node.js generates and stores VAPID keys and admin push subscriptions. When kiosk telemetry detects a hardware blocker, `AdminPushService` broadcasts encrypted Web Push payloads to subscribed mobile/desktop PWAs, emits `admin:kiosk-critical-alert` via Socket.IO for open tabs, and logs an anomaly audit. `src/public/admin/sw.js` displays high-priority OS notifications with vibration, while `src/public/admin/shared.ts` renders an emergency sticky banner with a dual-tone Web Audio siren.

**Tech Stack:** Node.js, Express, `web-push`, TypeScript, Socket.IO, Service Worker Push API, Web Audio API, Jest.

**Spec:** `docs/superpowers/specs/2026-10-26-kiosk-hardware-alerts-web-push-design.md`

## Global Constraints
- Target domain: `admin.printbitkiosk.com`.
- Zero external paid push services (pure W3C Push API + VAPID RFC 8292).
- Automatic dead endpoint cleanup on HTTP 404/410 responses from push services.
- 30-second cooldown per alert code (`PAPER_JAM`, `PAPER_OUT`, etc.) to prevent notification storms.
- User interaction unlock for Web Audio API siren to satisfy browser autoplay restrictions.
- All mutating `/api/admin/push/*` routes protected by `requireAdminPin`.

---

### Task 1: Add Dependencies & Database Schema for Push Notifications

**Files:**
- Modify: `package.json`
- Modify: `src/core/database/models/admin.model.ts`
- Modify: `src/modules/admin/admin.schema.ts`
- Modify: `src/services/db.ts`
- Test: `src/services/__tests__/push-schema.spec.ts`

**Interfaces:**
- Produces: `AdminPushSubscriptionEntry`, `PushNotificationSettings`, `db.data.adminPushSubscriptions`, `db.data.settings.pushNotifications`

- [ ] **Step 1: Write the failing test for schema and defaults**

Create `src/services/__tests__/push-schema.spec.ts`:
```ts
import { db } from '../db';
import type { AdminPushSubscriptionEntry, PushNotificationSettings } from '@/modules/admin/admin.schema';

describe('Push Notification Database Schema', () => {
  it('initializes adminPushSubscriptions array in db', async () => {
    expect(Array.isArray(db.data?.adminPushSubscriptions)).toBe(true);
  });

  it('provides default pushNotifications settings structure in db', async () => {
    expect(db.data?.settings.pushNotifications).toBeDefined();
    expect(typeof db.data?.settings.pushNotifications.enabled).toBe('boolean');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm jest src/services/__tests__/push-schema.spec.ts -v`  
Expected: FAIL due to missing properties on `db.data`.

- [ ] **Step 3: Install `web-push` and add schema definitions**

Install dependencies:
```bash
pnpm add web-push
pnpm add -D @types/web-push
```

Update `src/modules/admin/admin.schema.ts`:
```ts
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushNotificationSettings {
  enabled: boolean;
  vapidKeys?: VapidKeys;
  cooldownSeconds: number;
}

export interface AdminPushSubscriptionEntry {
  id: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent: string;
  createdAt: string;
  lastNotifiedAt: string | null;
}
```

Add to `AdminSettings` in `src/modules/admin/admin.schema.ts`:
```ts
pushNotifications: PushNotificationSettings;
```

Update `src/services/db.ts` to include `adminPushSubscriptions: AdminPushSubscriptionEntry[]` and `pushNotifications` defaults in database initialization.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm jest src/services/__tests__/push-schema.spec.ts -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/modules/admin/admin.schema.ts src/services/db.ts src/services/__tests__/push-schema.spec.ts
git commit -m "feat(push): add web-push dependency and database schema for push subscriptions"
```

---

### Task 2: Implement AdminPushService with VAPID Key Lifecycle and Dispatch

**Files:**
- Create: `src/services/admin-push.service.ts`
- Create: `src/services/__tests__/admin-push.service.spec.ts`

**Interfaces:**
- Produces: `adminPushService` singleton
  - `getPublicKey(): string`
  - `subscribe(sub: PushSubscriptionJSON, userAgent?: string): Promise<AdminPushSubscriptionEntry>`
  - `unsubscribe(endpoint: string): Promise<boolean>`
  - `broadcastCriticalAlert(alert: KioskCriticalAlert): Promise<{ sent: number; pruned: number }>`
  - `sendTestNotification(endpoint: string): Promise<boolean>`
  - `clearAlert(code: string): void`

- [ ] **Step 1: Write the failing unit tests for AdminPushService**

Create `src/services/__tests__/admin-push.service.spec.ts`:
```ts
import { AdminPushService, type KioskCriticalAlert } from '../admin-push.service';
import webpush from 'web-push';

jest.mock('web-push');

describe('AdminPushService', () => {
  let service: AdminPushService;
  let mockDbData: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDbData = {
      settings: {
        pushNotifications: {
          enabled: true,
          vapidKeys: {
            publicKey: 'test-public-key',
            privateKey: 'test-private-key',
          },
          cooldownSeconds: 30,
        },
      },
      adminPushSubscriptions: [],
    };
    service = new AdminPushService({
      getDbData: () => mockDbData,
      writeDb: jest.fn().mockResolvedValue(undefined),
      emitSocket: jest.fn(),
      reportAnomaly: jest.fn().mockResolvedValue(undefined),
    });
  });

  it('returns valid VAPID public key', () => {
    expect(service.getPublicKey()).toBe('test-public-key');
  });

  it('subscribes new device and persists subscription', async () => {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
      keys: { p256dh: 'p256', auth: 'auth' },
    };
    const entry = await service.subscribe(sub, 'TestBrowser');
    expect(entry.endpoint).toBe(sub.endpoint);
    expect(mockDbData.adminPushSubscriptions.length).toBe(1);
  });

  it('broadcasts critical alert to all active subscriptions', async () => {
    mockDbData.adminPushSubscriptions.push({
      id: 'sub-1',
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
      keys: { p256dh: 'p256', auth: 'auth' },
      userAgent: 'TestBrowser',
      createdAt: new Date().toISOString(),
      lastNotifiedAt: null,
    });

    (webpush.sendNotification as jest.Mock).mockResolvedValue({});

    const alert: KioskCriticalAlert = {
      code: 'PAPER_JAM',
      title: '🚨 Kiosk Paper Jam Detected!',
      message: 'Paper is jammed in the printer.',
      severity: 'critical',
    };

    const res = await service.broadcastCriticalAlert(alert);
    expect(res.sent).toBe(1);
    expect(res.pruned).toBe(0);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('prunes dead subscription when push service returns 410 Gone', async () => {
    mockDbData.adminPushSubscriptions.push({
      id: 'sub-1',
      endpoint: 'https://fcm.googleapis.com/fcm/send/expired',
      keys: { p256dh: 'p256', auth: 'auth' },
      userAgent: 'OldPhone',
      createdAt: new Date().toISOString(),
      lastNotifiedAt: null,
    });

    const error410 = new Error('Gone') as any;
    error410.statusCode = 410;
    (webpush.sendNotification as jest.Mock).mockRejectedValue(error410);

    const alert: KioskCriticalAlert = {
      code: 'PAPER_OUT',
      title: '⚠️ Kiosk Paper Out!',
      message: 'Paper tray is empty.',
      severity: 'critical',
    };

    const res = await service.broadcastCriticalAlert(alert);
    expect(res.sent).toBe(0);
    expect(res.pruned).toBe(1);
    expect(mockDbData.adminPushSubscriptions.length).toBe(0);
  });

  it('enforces 30-second deduplication cooldown per alert code', async () => {
    mockDbData.adminPushSubscriptions.push({
      id: 'sub-1',
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
      keys: { p256dh: 'p256', auth: 'auth' },
      userAgent: 'TestBrowser',
      createdAt: new Date().toISOString(),
      lastNotifiedAt: null,
    });
    (webpush.sendNotification as jest.Mock).mockResolvedValue({});

    const alert: KioskCriticalAlert = {
      code: 'PAPER_JAM',
      title: '🚨 Kiosk Paper Jam Detected!',
      message: 'Jam!',
      severity: 'critical',
    };

    const first = await service.broadcastCriticalAlert(alert);
    expect(first.sent).toBe(1);

    // Immediate second call should be suppressed by cooldown
    const second = await service.broadcastCriticalAlert(alert);
    expect(second.sent).toBe(0);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm jest src/services/__tests__/admin-push.service.spec.ts -v`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/services/admin-push.service.ts`**

```ts
import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { anomalyService } from './anomaly';
import type { Server } from 'socket.io';
import type { AdminPushSubscriptionEntry, VapidKeys } from '@/modules/admin/admin.schema';

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
      emitSocket: deps.emitSocket ?? ((event, payload) => this.io?.emit(event, payload)),
      reportAnomaly: deps.reportAnomaly ?? ((input) => anomalyService.report(input)),
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
    webpush.setVapidDetails('mailto:admin@printbitkiosk.com', keys.publicKey, keys.privateKey);
    return keys;
  }

  getPublicKey(): string {
    return this.ensureVapidKeys().publicKey;
  }

  async subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent = 'Unknown'): Promise<AdminPushSubscriptionEntry> {
    const data = this.deps.getDbData();
    if (!data) throw new Error('Database not initialized');
    if (!data.adminPushSubscriptions) data.adminPushSubscriptions = [];

    const existingIndex = data.adminPushSubscriptions.findIndex((s) => s.endpoint === sub.endpoint);
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
    data.adminPushSubscriptions = data.adminPushSubscriptions.filter((s) => s.endpoint !== endpoint);
    if (data.adminPushSubscriptions.length !== initialLen) {
      await this.deps.writeDb();
      return true;
    }
    return false;
  }

  async broadcastCriticalAlert(alert: KioskCriticalAlert): Promise<{ sent: number; pruned: number }> {
    const nowMs = Date.now();
    const lastAlert = this.lastAlertTimestamps.get(alert.code) ?? 0;
    const cooldownMs = (this.deps.getDbData()?.settings?.pushNotifications?.cooldownSeconds ?? 30) * 1000;

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
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: sub.keys,
            },
            payload,
            { urgency: 'high', TTL: 86400 }
          );
          sentCount++;
          sub.lastNotifiedAt = new Date().toISOString();
        } catch (err: any) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            deadEndpoints.add(sub.endpoint);
          }
        }
      })
    );

    let prunedCount = 0;
    if (deadEndpoints.size > 0) {
      data.adminPushSubscriptions = data.adminPushSubscriptions.filter((s) => !deadEndpoints.has(s.endpoint));
      prunedCount = deadEndpoints.size;
    }
    await this.deps.writeDb();

    return { sent: sentCount, pruned: prunedCount };
  }

  async sendTestNotification(endpoint: string): Promise<boolean> {
    const data = this.deps.getDbData();
    const sub = data?.adminPushSubscriptions?.find((s) => s.endpoint === endpoint);
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
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload,
        { urgency: 'high', TTL: 3600 }
      );
      return true;
    } catch {
      return false;
    }
  }

  clearAlert(code: string): void {
    this.lastAlertTimestamps.delete(code);
    this.deps.emitSocket('admin:kiosk-alert-cleared', { code });
  }
}

export const adminPushService = new AdminPushService();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm jest src/services/__tests__/admin-push.service.spec.ts -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/admin-push.service.ts src/services/__tests__/admin-push.service.spec.ts
git commit -m "feat(push): implement AdminPushService with VAPID lifecycle, pruning, and cooldown"
```

---

### Task 3: Add Admin Push Controller Endpoints & Authentication

**Files:**
- Modify: `src/modules/admin/admin.controller.ts`
- Create: `src/modules/admin/__tests__/admin-push.routes.spec.ts`

**Interfaces:**
- Produces API routes:
  - `GET /api/admin/push/vapid-public-key`
  - `POST /api/admin/push/subscribe` (requires `requireAdminPin`)
  - `POST /api/admin/push/unsubscribe` (requires `requireAdminPin`)
  - `POST /api/admin/push/test` (requires `requireAdminPin`)
  - `GET /api/admin/push/status` (requires `requireAdminPin`)

- [ ] **Step 1: Write failing API route test**

Create `src/modules/admin/__tests__/admin-push.routes.spec.ts`:
```ts
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { adminPushService } from '@/services/admin-push.service';

jest.mock('@/services/admin-push.service');

describe('Admin Push Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    // Will mount admin router in step 3
  });

  it('GET /api/admin/push/vapid-public-key returns publicKey', async () => {
    (adminPushService.getPublicKey as jest.Mock).mockReturnValue('mock-public-key');
    // Test endpoint
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm jest src/modules/admin/__tests__/admin-push.routes.spec.ts -v`  
Expected: FAIL

- [ ] **Step 3: Implement controller endpoints in `src/modules/admin/admin.controller.ts`**

In `src/modules/admin/admin.controller.ts`, add route handlers:
```ts
this.router.get('/push/vapid-public-key', (req, res) => {
  try {
    const key = adminPushService.getPublicKey();
    return res.json({ success: true, publicKey: key });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

this.router.post('/push/subscribe', requireAdminPin, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint || !subscription?.keys) {
      return res.status(400).json({ success: false, error: 'Invalid subscription object.' });
    }
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const entry = await adminPushService.subscribe(subscription, userAgent);
    return res.json({ success: true, subscription: entry });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

this.router.post('/push/unsubscribe', requireAdminPin, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ success: false, error: 'Endpoint required.' });
    await adminPushService.unsubscribe(endpoint);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

this.router.post('/push/test', requireAdminPin, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ success: false, error: 'Endpoint required.' });
    const ok = await adminPushService.sendTestNotification(endpoint);
    return res.json({ success: ok });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

this.router.get('/push/status', requireAdminPin, (req, res) => {
  const subscriptions = db.data?.adminPushSubscriptions || [];
  return res.json({
    success: true,
    subscriptionCount: subscriptions.length,
    enabled: db.data?.settings.pushNotifications?.enabled ?? true,
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm jest src/modules/admin/__tests__/admin-push.routes.spec.ts -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/admin.controller.ts src/modules/admin/__tests__/admin-push.routes.spec.ts
git commit -m "feat(push): add admin push subscription and test endpoints"
```

---

### Task 4: Hook Hardware Fault Triggers (Paper Jam, Paper Out, Offline, Hopper)

**Files:**
- Modify: `src/services/printer-state-projection.ts`
- Modify: `src/services/worker-print-lifecycle.ts`
- Modify: `src/services/hopper.ts`
- Modify: `src/server.ts`
- Modify: `src/modules/printer/printer-error-guide.spec.ts`

**Interfaces:**
- Calls: `adminPushService.broadcastCriticalAlert`, `adminPushService.clearAlert`

- [ ] **Step 1: Write test verifying Paper Jam dispatches critical alert**

Update `src/modules/printer/printer-error-guide.spec.ts`:
```ts
it('dispatches critical push alert on paper jam print event while preserving customer guide modal', async () => {
  const spy = jest.spyOn(adminPushService, 'broadcastCriticalAlert').mockResolvedValue({ sent: 1, pruned: 0 });
  // Call handlePrinterStatusUpdate with code 8 / paper jam
  // Expect spy to have been called with { code: 'PAPER_JAM', severity: 'critical' }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm jest src/modules/printer/printer-error-guide.spec.ts -v`  
Expected: FAIL because paper jam was previously ignored with early return.

- [ ] **Step 3: Update trigger points**

In `src/services/printer-state-projection.ts`:
```ts
if (translated.code === 'PAPER_JAM_PRINT') {
  void adminPushService.broadcastCriticalAlert({
    code: 'PAPER_JAM',
    title: '🚨 Kiosk Paper Jam Detected!',
    message: 'Paper is jammed in the kiosk printer. Physical clearance required.',
    severity: 'critical',
  });
  return;
}
```

Add clear event handler in `printer-state-projection.ts`:
```ts
onPaperJamCleared: () => {
  adminPushService.clearAlert('PAPER_JAM');
}
```

In `src/services/worker-print-lifecycle.ts`:
```ts
if (isPaperOut) {
  void adminPushService.broadcastCriticalAlert({
    code: 'PAPER_OUT',
    title: '⚠️ Kiosk Paper Out!',
    message: 'Printer rear paper tray is empty. Please load paper.',
    severity: 'critical',
  });
}
```

In `src/server.ts`:
Initialize `adminPushService.setSocketIo(io);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm jest src/modules/printer/printer-error-guide.spec.ts -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/printer-state-projection.ts src/services/worker-print-lifecycle.ts src/services/hopper.ts src/server.ts src/modules/printer/printer-error-guide.spec.ts
git commit -m "feat(hardware): wire Paper Jam, Paper Out, and Hopper alerts to AdminPushService"
```

---

### Task 5: Upgrade Service Worker with Push & Notification Click Handlers

**Files:**
- Modify: `src/public/admin/sw.js`

**Interfaces:**
- Produces: `push` and `notificationclick` event listeners in Service Worker

- [ ] **Step 1: Check existing `sw.js` structure and syntax**

Verify cache names, fetch listeners, and prepare insertion of push listeners.

- [ ] **Step 2: Add `push` and `notificationclick` listeners to `src/public/admin/sw.js`**

```javascript
// ── Push Notification Handlers ─────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: 'PrintBit Kiosk Alert', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || '🚨 PrintBit Kiosk Alert';
  const options = {
    body: data.body || 'A critical hardware event occurred on the kiosk.',
    icon: '/admin/icons/icon-192x192.png',
    badge: '/admin/icons/favicon.svg',
    tag: data.tag || 'kiosk-hardware-alert',
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 500],
    data: {
      url: data.url || '/admin/system',
      timestamp: data.timestamp || Date.now(),
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/admin/system';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes('/admin/') && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
```

- [ ] **Step 3: Verify Service Worker syntax and precache balance**

Run: `node -c src/public/admin/sw.js`  
Expected: Clean exit code 0 without syntax errors.

- [ ] **Step 4: Commit**

```bash
git add src/public/admin/sw.js
git commit -m "feat(pwa): add push and notificationclick event listeners to admin service worker"
```

---

### Task 6: Implement Global In-App Alert System & Audio Siren in `shared.ts`

**Files:**
- Modify: `src/public/admin/shared.ts`
- Modify: `src/public/admin/shared.css`

**Interfaces:**
- Produces: `setupGlobalKioskAlertListener()`, `setupAdminPushNotifications()`, Web Audio synthetic dual siren, top emergency banner

- [ ] **Step 1: Write Web Audio siren generator and banner DOM in `src/public/admin/shared.ts`**

In `src/public/admin/shared.ts`:
- Build `KioskAlarmAudioController`:
  - Creates `AudioContext` on first user gesture (click/touch/login).
  - Generates dual-tone alarm (880Hz alternating with 660Hz every 0.6s).
  - Provides `start()`, `stop()`, and `mute()`.
- Build `renderEmergencyAlertBanner(alert)`:
  - Sticky at top of window: `#emergencyAlertBanner`.
  - Flashing red indicator with emergency text.
  - Buttons: `[Inspect System]` (redirects to `/admin/system`) and `[Mute Alarm]`.
- Connect Socket.IO:
  - Listen for `admin:kiosk-critical-alert`:
    - Display emergency banner.
    - Start alarm siren audio.
  - Listen for `admin:kiosk-alert-cleared`:
    - Stop alarm siren audio.
    - Remove emergency banner.

- [ ] **Step 2: Add Push Registration Helper in `src/public/admin/shared.ts`**

```ts
export async function registerAdminPush(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const reg = await navigator.serviceWorker.ready;
  const res = await apiFetch('/api/admin/push/vapid-public-key');
  if (!res.ok) return false;
  const { publicKey } = await res.json();

  const convertedKey = urlB64ToUint8Array(publicKey);
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: convertedKey,
  });

  const saveRes = await apiFetch('/api/admin/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription: sub }),
  });
  return saveRes.ok;
}
```

- [ ] **Step 3: Add CSS styling for emergency banner in `src/public/admin/shared.css`**

Add styles for `#emergencyAlertBanner`, blinking animation, and button controls.

- [ ] **Step 4: Build client assets to verify TypeScript compilation**

Run: `pnpm run build`  
Expected: Successful compilation without errors.

- [ ] **Step 5: Commit**

```bash
git add src/public/admin/shared.ts src/public/admin/shared.css
git commit -m "feat(admin): implement global emergency siren, banner, and push registration in shared.ts"
```

---

### Task 7: Add Push Notifications Management Card in Admin Settings

**Files:**
- Modify: `src/public/admin/settings/index.html`
- Modify: `src/public/admin/settings/app.ts`
- Modify: `src/public/admin/settings/styles.css`

**Interfaces:**
- Produces: Settings card `#pushNotificationsCard`
  - Toggle switch for device push alerts
  - "Send Test Push" button
  - Status indicator (Active / Blocked / Unsubscribed)
  - Registered device count

- [ ] **Step 1: Add Push Notifications markup to `src/public/admin/settings/index.html`**

Insert card into Settings page layout:
```html
<section class="settings-card" id="pushNotificationsCard">
  <div class="settings-card__header">
    <div class="settings-card__title">
      <span class="icon">🔔</span>
      <h3>Push Notifications (PWA)</h3>
    </div>
    <span class="badge" id="pushStatusBadge">Checking...</span>
  </div>
  <p class="settings-card__desc">
    Receive instant alerts on your phone or computer when Paper Jam, Paper Out, or critical hardware blockers occur.
  </p>
  <div class="push-actions">
    <button type="button" class="btn btn--primary" id="enablePushBtn">Enable Push Alerts</button>
    <button type="button" class="btn btn--secondary" id="testPushBtn">Send Test Push</button>
    <button type="button" class="btn btn--danger hidden" id="disablePushBtn">Disable on this Device</button>
  </div>
  <div class="push-meta text-muted" id="pushMetaText"></div>
</section>
```

- [ ] **Step 2: Add logic in `src/public/admin/settings/app.ts`**

Implement device state check:
- Reads `navigator.permissions.query({ name: 'notifications' })`.
- Updates `#pushStatusBadge` to `Subscribed`, `Disabled`, or `Permission Blocked`.
- Click on `#enablePushBtn` triggers `registerAdminPush()`.
- Click on `#testPushBtn` calls `POST /api/admin/push/test`.
- Click on `#disablePushBtn` unregisters push subscription.

- [ ] **Step 3: Build client assets and test in browser**

Run: `pnpm run build`  
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/public/admin/settings/index.html src/public/admin/settings/app.ts src/public/admin/settings/styles.css
git commit -m "feat(settings): add Push Notifications card with subscribe and test push controls"
```

---

### Task 8: End-to-End Simulation & Verification

**Files:**
- Modify: `src/services/printer-simulation.ts`
- Create: `src/services/__tests__/push-hardware-e2e.spec.ts`

**Interfaces:**
- Verifies: Complete pipeline from Paper Jam simulation trigger to Web Push and Socket.IO emission

- [ ] **Step 1: Write integration test for simulated Paper Jam dispatch**

Create `src/services/__tests__/push-hardware-e2e.spec.ts`:
```ts
import { adminPushService } from '../admin-push.service';
import { simulatePrinterError, clearPaperJamSimulation } from '../printer-simulation';

describe('Paper Jam Push Alert Integration', () => {
  it('dispatches critical push alert when paper jam simulation is activated', async () => {
    const broadcastSpy = jest.spyOn(adminPushService, 'broadcastCriticalAlert').mockResolvedValue({ sent: 1, pruned: 0 });
    const clearSpy = jest.spyOn(adminPushService, 'clearAlert');

    simulatePrinterError('paper_jam');
    expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAPER_JAM' }));

    clearPaperJamSimulation();
    expect(clearSpy).toHaveBeenCalledWith('PAPER_JAM');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm jest src/services/__tests__/push-hardware-e2e.spec.ts -v`  
Expected: PASS

- [ ] **Step 3: Run full test suite and build**

Run:
```bash
pnpm test
pnpm run build
```
Expected: All tests pass, build completes cleanly.

- [ ] **Step 4: Commit**

```bash
git add src/services/printer-simulation.ts src/services/__tests__/push-hardware-e2e.spec.ts
git commit -m "test(e2e): verify paper jam simulation triggers push alert and clear event"
```
