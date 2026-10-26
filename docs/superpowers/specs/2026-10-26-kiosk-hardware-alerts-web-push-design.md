# Specification: Kiosk Hardware Alerts & Web Push Notification Subsystem

**Date:** 2026-10-26  
**Status:** Approved  
**Domain:** `admin.printbitkiosk.com`  
**Target:** Kiosk Hardware Faults (Paper Jam, Paper Out, Printer Offline, Coin Hopper Empty)

---

## 1. Context & Motivation

PrintBit kiosk operations require immediate intervention when physical hardware blockers arise, specifically:
1. **Paper Jam (`PAPER_JAM_PRINT`)**: The customer cannot print or scan; physical clearing by staff/operator is required.
2. **Paper Out (`PAPER_TRAY_EMPTY`)**: The printer cannot feed paper; the tray needs replenishment.
3. **Printer Disconnected / Offline (`PRINTER_OFFLINE`)**: Communication or USB connection lost.
4. **Coin Hopper Empty (`HOPPER_EMPTY`)**: The kiosk cannot dispense change, risking user funds.

Previously, Paper Jam events were partially isolated within customer recovery screens and excluded from persistent anomaly alerts. Furthermore, operator notifications were passive, requiring someone to actively refresh or inspect the Anomaly Alerts page.

With the kiosk admin portal now accessible via its registered domain `admin.printbitkiosk.com` over HTTPS and configured as a Progressive Web Application (PWA), operators can install the app on mobile phones and desktop computers. This subsystem implements a **hybrid alerting pipeline**:
- **Native Web Push**: Sends instant OS-level push notifications to registered operator devices even when the admin browser tab is closed or mobile device is locked.
- **In-App Emergency Alarm**: Provides a persistent, flashing top-banner and audible synthetic alarm siren across all open admin pages (`/admin/*`) via Socket.IO.
- **Anomaly Audit Recording**: Automatically logs every critical incident in the database for auditing and resolution tracking.

---

## 2. Architecture & Data Flow

```
┌────────────────────────────────────────────────────────┐
│               Kiosk Hardware & Telemetry               │
│   (WinSpool API / Epson Status / Hopper Serial Loop)   │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│     Node Backend: Hardware Monitoring Services         │
│  - PrinterStateProjection (Status polling & events)    │
│  - WorkerPrintLifecycle (Stall detection in job run)   │
│  - HopperService (Coin dispense & empty detection)     │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│               AdminPushService (Dispatcher)            │
├──────────────────────────┬─────────────────────────────┤
│                          │                             │
│ (1) Web Push Dispatch    │ (2) Socket.IO Broadcast     │ (3) Anomaly Logging
│     (web-push / VAPID)   │     ('admin:kiosk-critical')│     (anomalyService)
│                          │                             │
▼                          ▼                             ▼
┌────────────────────┐ ┌───────────────────────────┐ ┌─────────────────┐
│ Browser Push Svcs  │ │ All Open Admin Pages      │ │ SQLite / DB     │
│ (FCM / APNs)       │ │ (`src/public/admin/`)     │ │ anomalyIncidents│
└─────────┬──────────┘ └─────────────┬─────────────┘ └─────────────────┘
          │                          │
          ▼                          ▼
┌────────────────────┐ ┌───────────────────────────┐
│ Device OS Tray     │ │ In-App Sticky Banner      │
│ (PWA ServiceWorker)│ │ + Web Audio Dual Siren    │
└────────────────────┘ └───────────────────────────┘
```

### Event Resolution / Clear Flow
1. Operator physically clears the jammed paper or loads paper into the tray.
2. Sensors report status back to normal (`printer:paper-jam-cleared` or `printer:ready`).
3. Backend emits `admin:kiosk-alert-cleared` with fault details.
4. Active in-app siren stops; banner transitions to dismissed/cleared state.
5. In-flight notification tags in Service Worker update or clear.

---

## 3. Backend Subsystem Specification

### 3.1 Dependencies & VAPID Keypair
- Package: `web-push` and `@types/web-push`.
- Key Generation:
  - If `db.data.settings.pushNotifications.vapidKeys` is absent, generate a new pair via `webpush.generateVAPIDKeys()`.
  - Persist `{ publicKey, privateKey }` in the settings storage.
  - Set VAPID contact details to `mailto:admin@printbitkiosk.com`.

### 3.2 Database Storage Model
New storage slice in `db.data.adminPushSubscriptions`:
```ts
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

### 3.3 AdminPushService (`src/services/admin-push.service.ts`)
Methods:
- `getPublicKey(): string`: Returns VAPID public key in base64url string format.
- `subscribe(sub: PushSubscriptionJSON, userAgent?: string): Promise<AdminPushSubscriptionEntry>`: Inserts or updates subscription indexed by `endpoint`.
- `unsubscribe(endpoint: string): Promise<boolean>`: Removes matching subscription.
- `broadcastCriticalAlert(alert: KioskCriticalAlert): Promise<{ sent: number; pruned: number }>`:
  - Checks 30-second cooldown per alert type (`alert.code`) to prevent notification storms.
  - Packages notification payload:
    ```json
    {
      "title": "🚨 Kiosk Hardware Alert: Paper Jam",
      "body": "A paper jam was detected in the kiosk printer. Physical intervention required.",
      "tag": "kiosk-hardware-fault",
      "url": "/admin/system",
      "timestamp": "2026-10-26T10:35:00.000Z",
      "severity": "critical",
      "code": "PAPER_JAM"
    }
    ```
  - Dispatches `webpush.sendNotification(subscription, JSON.stringify(payload))` concurrently.
  - Pruning: If push service returns HTTP `404 Not Found` or `410 Gone`, immediately delete subscription from database.
  - Socket.IO: Emits `io.emit('admin:kiosk-critical-alert', alert)` to notify open browser sessions.
  - Anomaly Audit: Calls `anomalyService.report(...)` to persist audit record.
- `sendTestNotification(endpoint: string): Promise<boolean>`: Dispatches immediate verification alert to a single device.
- `clearAlert(code: string): void`: Emits `io.emit('admin:kiosk-alert-cleared', { code })`.

### 3.4 Integration Points in Kiosk Core
1. **`src/services/printer-state-projection.ts`**:
   - Update `translateHardwarePrinterError`: Remove silent `return` on `PAPER_JAM_PRINT`.
   - On `PAPER_JAM_PRINT`: Trigger `adminPushService.broadcastCriticalAlert({ code: 'PAPER_JAM', title: '🚨 Kiosk Paper Jam Detected!', message: 'Paper is jammed inside the printer. Please open printer and remove jammed paper.', severity: 'critical' })`.
   - On paper jam clear event (`printer:paper-jam-cleared`): Call `adminPushService.clearAlert('PAPER_JAM')`.
2. **`src/services/worker-print-lifecycle.ts`**:
   - In stall / error evaluation: When `errorCode === 'PAPER_TRAY_EMPTY'`, call `adminPushService.broadcastCriticalAlert({ code: 'PAPER_OUT', title: '⚠️ Kiosk Paper Out!', message: 'Printer rear paper tray is empty. Please load paper to resume printing.', severity: 'critical' })`.
   - When `errorCode === 'PRINTER_OFFLINE'`, call `adminPushService.broadcastCriticalAlert({ code: 'PRINTER_OFFLINE', title: '⚠️ Printer Disconnected!', message: 'Kiosk lost connection to printer.', severity: 'critical' })`.
3. **`src/services/hopper.ts`**:
   - When hopper status reports empty or dispense stall: Call `adminPushService.broadcastCriticalAlert({ code: 'HOPPER_EMPTY', title: '⚠️ Coin Hopper Empty!', message: 'Kiosk coin hopper is empty. Change cannot be dispensed.', severity: 'critical' })`.

### 3.5 Admin Controller API Endpoints
All modifying endpoints protected by `requireAdminPin`:
- `GET /api/admin/push/vapid-public-key` -> `{ success: true, publicKey: string }`
- `POST /api/admin/push/subscribe` -> `{ success: true, subscription: AdminPushSubscriptionEntry }`
- `POST /api/admin/push/unsubscribe` -> `{ success: true }`
- `POST /api/admin/push/test` -> `{ success: true }`
- `GET /api/admin/push/status` -> `{ success: true, subscriptionCount: number, isConfigured: boolean }`

---

## 4. Frontend PWA & Service Worker Specification

### 4.1 Service Worker (`src/public/admin/sw.js`)
Add push event listeners:
```js
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: 'PrintBit Kiosk Alert', body: event.data.text() };
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
      timestamp: data.timestamp || Date.now()
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/admin/system';

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

### 4.2 Shared In-App Alert System (`src/public/admin/shared.ts`)
1. **Socket.IO Central Hub**:
   - Establish single Socket.IO connection across all admin pages if script is loaded.
   - Listen for `admin:kiosk-critical-alert`:
     - Render emergency sticky bar at top of viewport:
       - Blinking red accent (`#ef4444`).
       - Large text: `🚨 CRITICAL KIOSK ALERT: [Alert Title] - [Alert Message]`.
       - Action buttons: `[Inspect System]` (links to `/admin/system`) and `[Mute Audio]`.
     - Synthesize emergency dual-pulse alarm via Web Audio API:
       - Uses `AudioContext` with alternating 880Hz and 660Hz square/sawtooth tones.
       - Pulses every 1.2 seconds until fault cleared or muted.
       - AudioContext unlocks automatically upon login click.
   - Listen for `admin:kiosk-alert-cleared`:
     - Stop oscillator immediately.
     - Smoothly fade out emergency banner.

2. **Push Registration Helper**:
   - Expose `setupAdminPushNotifications()`:
     - Check if service worker & push manager are available.
     - Fetch VAPID public key from backend.
     - Convert URL-safe base64 key to `Uint8Array`.
     - Call `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
     - Send subscription to `POST /api/admin/push/subscribe`.
   - Automatic Prompt:
     - After successful login, if `Notification.permission === 'default'`, show polite prompt banner:
       *"Enable push notifications on this device to get alerted immediately when paper jams or runs out."*
     - If accepted, register immediately and show confirmation toast.

### 4.3 Settings Management Page (`src/public/admin/settings/`)
Add a new **Push Notification Subscriptions** card:
- Current Device Status indicator:
  - 🟢 **Subscribed**: PWA will receive hardware alert pushes.
  - 🟡 **Not Subscribed**: Button to "Enable Notifications".
  - 🔴 **Permission Blocked**: Guidance to unblock in browser site settings.
- Action Buttons:
  - **"Send Test Push"**: Sends a diagnostic push message to verify device sound/vibration.
  - **"Unsubscribe Device"**: Revokes subscription for current device.
- Total Active Devices count: Informs operator how many phones/computers are registered to receive alerts.

---

## 5. Security, Resilience & Edge Cases

| Challenge | Mitigation |
|---|---|
| **Stale / Dead Subscriptions** | Google FCM / Apple APNs return HTTP 410 Gone when an operator uninstalls the PWA or resets browser data. `AdminPushService` catches 410 and 404 responses and automatically prunes the subscription from `db.data.adminPushSubscriptions`. |
| **Notification Flooding** | A 30-second deduplication cooldown is enforced per alert code (`PAPER_JAM`, `PAPER_OUT`, etc.) unless an explicit clear event intervenes. |
| **Audio Autoplay Restrictions** | Modern browsers block audio autoplay until user interacts with the page. The audio context is lazily resumed on the first click or touch event during login or dashboard navigation. |
| **iOS PWA Web Push Restrictions** | On iOS 16.4+, Web Push is supported only when the website has been added to the Home Screen. If iOS browser tab detects lack of `PushManager`, the prompt displays: *"Add PrintBit Admin to your Home Screen first to enable push notifications."* |
| **Authentication on API** | All subscription modifications and test triggers require a valid admin session token (`x-admin-token` or cookie). The public VAPID key is public information and safe for unauthenticated read. |

---

## 6. Verification & Test Plan

### Automated Tests
1. **Unit Tests (`src/services/__tests__/admin-push.service.test.ts`)**:
   - Test VAPID key generation and persistent storage.
   - Test subscription registration and idempotent upsert.
   - Test pruning logic when `webpush.sendNotification` throws 410 Gone.
   - Test cooldown suppression when rapid duplicate alerts are triggered.
2. **API Route Tests**:
   - Verify `GET /api/admin/push/vapid-public-key` returns valid base64 key.
   - Verify `POST /api/admin/push/subscribe` requires valid admin authentication.
   - Verify `POST /api/admin/push/test` sends payload to registered subscription.
3. **Integration Hook Tests**:
   - Verify `PAPER_JAM_PRINT` in `PrinterStateProjection` calls `broadcastCriticalAlert`.
   - Verify `PAPER_TRAY_EMPTY` in `WorkerPrintLifecycle` calls `broadcastCriticalAlert`.

### Manual End-to-End Tests
1. **PWA Setup**: Open `https://admin.printbitkiosk.com` on a mobile device and install to home screen.
2. **Permission & Subscription**: Log in with Admin PIN. Accept notification prompt. Verify Settings card turns green.
3. **Test Push**: Tap "Send Test Push" in Settings. Verify notification appears in device notification center with vibration.
4. **Paper Jam Simulation**: Trigger simulated paper jam. Verify:
   - Phone receives "🚨 Kiosk Paper Jam Detected!" push notification with persistent interaction.
   - Open dashboard tab displays flashing red emergency banner and sounds dual-tone siren.
5. **Clear Simulation**: Trigger clear paper jam. Verify siren immediately halts and banner clears.
