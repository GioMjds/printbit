# Admin Device Identity and Alert Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each admin device a persisted identity (label, severity filter, long-lived device cookie) so push alerts route per device, restarts do not log known devices out, and a device can only manage its own push subscription.

**Architecture:** A new `AdminDeviceService` owns device records (`adminDevices` in the db). PIN login enrols or reuses a device and sets an `adminDevice` cookie. `requireAdminPin` falls back to that cookie when the in-memory session is missing. `AdminPushService` links subscriptions to a `deviceId`, filters broadcasts by `minSeverity`, and enforces ownership. A "Devices" card in settings lists, renames, mutes and revokes devices.

**Tech Stack:** TypeScript, Express, cookie-parser, `web-push`, jest + ts-jest (`@/` alias, `**/*.spec.ts`), esbuild client bundle (`scripts/build-client.js`).

**Spec:** `docs/superpowers/specs/2026-11-07-admin-device-identity-design.md`

## Global Constraints

- Device collection name is `adminDevices`; device cookie name is `adminDevice`, value format `<id>.<secret>`; session cookie stays `adminToken`.
- Cookie secret is stored only as a sha256 hex hash (`tokenHash`) and compared with `timingSafeEqual`.
- Device cookie: httpOnly, sameSite `strict`, 90 days, sliding.
- Admin session TTL stays 24h and in memory; the cookie fallback re-derives sessions.
- `minSeverity` is `'critical' | 'warning'`; default is `'warning'` (receives everything).
- Label: trimmed, max 40 characters. Device list capped at 20; at the cap the least recently seen device is evicted together with its subscriptions.
- `broadcastCriticalAlert` returns `{ sent, pruned, skipped }`. Retry, timeout, pruning and cooldown-restore behaviour is unchanged.
- Push subscribe, test and unsubscribe are own-device only; list, rename, severity change and revoke are open to any logged-in device.
- All new routes use `requireAdminLocalAccess` and `requireAdminPin`.
- PIN lockout and attempt limits are unchanged. Do not touch Express `trust proxy` (out of scope).
- Every commit message ends with these two trailer lines:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_014rjHKjm6C3YxohmSkjPZ3V`.
- Use the project test command `npx jest <path>`; typecheck with `npx tsc --noEmit -p tsconfig.json`.

## Implementation Decisions Beyond the Spec

These fill gaps the spec left open. They are flagged here so the reviewer can reject any of them.

1. The device id reaches handlers as `res.locals.adminDeviceId` (not `req.adminDeviceId`). This avoids a global Express type augmentation.
2. Logout clears both cookies but does **not** revoke the device record. Without this, the device cookie would silently log the user back in. The old record stays in the list until revoked, and logging in again from the same browser creates a new one.
3. `subscribe()` lets a device take over an endpoint owned by another device or by nobody. The endpoint plus its keys prove possession of the browser subscription. Without this, the logout/login case above would lock a browser out of its own subscription.
4. Revoking a device also destroys that device's live in-memory sessions. Otherwise a revoked lost phone would stay authenticated until its 24h session expires.
5. When the cookie fallback mints a new session it also returns it in an `x-admin-session-token` response header. The client stores it. Without this, a client holding a stale `x-admin-token` header would mint a new session on every request.
6. If device enrolment fails at login (db error), login still succeeds with an anonymous session. Push then answers 403 `DEVICE_REQUIRED`.
7. The "naming prompt" is a one-time `window.prompt` per browser, tracked in `localStorage`. It needs no schema flag.

## Review Focus

Failure modes the spec implies but a happy-path test would miss, most likely first. Each has a test in the task that owns the code.

1. A stale `x-admin-token` header after a server restart, with a valid device cookie: the request must authenticate through the fallback, and the minted token must validate afterwards (Task 3).
2. Logout must not be undone by the device cookie, and must clear both cookies (Task 4).
3. A browser that logged in before this change has no device cookie: subscribe must answer 403 with code `DEVICE_REQUIRED`, and the client must show a "log in again" message, not a generic failure (Tasks 6, 7).
4. Malformed or tampered device cookie values (no dot, empty secret, 500 characters, stored hash of the wrong length) must return `null`, never throw. `timingSafeEqual` throws on a length mismatch (Task 2).
5. Revoking a device must kill its live sessions, and cap eviction must never evict the device just enrolled (Tasks 2, 3).
6. A subscription whose device record is missing, or a legacy one with no `deviceId`, must still receive alerts (fail open) (Task 5).

---

### Task 0: Commit the item 1-3 push reliability work

The working tree still holds the uncommitted push reliability changes (retry, timeout, server-verified status, non-destructive subscribe). Commit them first so later commits stay focused.

**Files:**
- Commit: `src/services/admin-push.service.ts`, `src/services/admin-push.service.spec.ts`, `src/modules/admin/admin.controller.ts`, `src/public/admin/shared.ts`

- [ ] **Step 1: Check the diff contains only push-related changes**

Run: `git diff --stat -- src/services/admin-push.service.ts src/modules/admin/admin.controller.ts src/public/admin/shared.ts`
Expected: only these three files listed. Then run `git diff -- src/modules/admin/admin.controller.ts` and confirm the only hunk is `handleGetPushStatus`. If it contains unrelated hunks, stage with `git add -p` and take only the push hunks.

- [ ] **Step 2: Run the existing push tests**

Run: `npx jest src/services/admin-push.service.spec.ts`
Expected: `Tests: 9 passed, 9 total`

- [ ] **Step 3: Commit**

```bash
git add src/services/admin-push.service.ts src/services/admin-push.service.spec.ts src/modules/admin/admin.controller.ts src/public/admin/shared.ts
git commit -m "fix(admin-push): retry delivery, server-verified status, non-destructive subscribe" -m $'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_014rjHKjm6C3YxohmSkjPZ3V'
```

---

### Task 1: Schema types and db defaults

**Files:**
- Modify: `src/modules/admin/admin.schema.ts:216-226`
- Modify: `src/core/database/models/admin.model.ts:4-14`
- Modify: `src/core/database/db.ts` (import list ~line 89, export list ~line 109, `Schema` type ~line 204, `DEFAULT_DATA` ~line 406, `normalizeSchema` ~line 1769)

**Interfaces:**
- Produces: `AdminDeviceEntry`, `AdminDeviceSeverity` exported from `@/modules/admin/admin.schema`; `AdminPushSubscriptionEntry.deviceId?: string`; `Schema.adminDevices: AdminDeviceEntry[]`.

This task has no unit test: `db.ts` pulls in the sqlite layer, and the repo has no db spec to extend. Verification is the typecheck plus the later tasks' tests.

- [ ] **Step 1: Add the types to `admin.schema.ts`**

Replace the `AdminPushSubscriptionEntry` interface (lines 216-226) with:

```ts
export type AdminDeviceSeverity = 'critical' | 'warning';

export interface AdminDeviceEntry {
  id: string;
  label: string;
  tokenHash: string;
  minSeverity: AdminDeviceSeverity;
  createdAt: string;
  lastSeenAt: string;
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
  // Absent on subscriptions saved before device identity existed.
  deviceId?: string;
}
```

- [ ] **Step 2: Re-export from `admin.model.ts`**

Replace lines 4-14 with:

```ts
import {
  PushNotificationSettings,
  AdminPushSubscriptionEntry,
  AdminDeviceEntry,
  AdminDeviceSeverity,
  VapidKeys,
} from '@/modules/admin/admin.schema';

export {
  PushNotificationSettings,
  AdminPushSubscriptionEntry,
  AdminDeviceEntry,
  AdminDeviceSeverity,
  VapidKeys,
};
```

- [ ] **Step 3: Wire `db.ts`**

In the import list from `./models/admin.model` (the line `AdminPushSubscriptionEntry,` at ~89) add `AdminDeviceEntry,` right after it. In the `export { ... }` block (the line `AdminPushSubscriptionEntry,` at ~109) add `AdminDeviceEntry,` right after it.

In the `Schema` type, after `adminPushSubscriptions: AdminPushSubscriptionEntry[];` add:

```ts
  adminDevices: AdminDeviceEntry[];
```

In `DEFAULT_DATA`, after `adminPushSubscriptions: [],` add:

```ts
  adminDevices: [],
```

In `normalizeSchema`, after the `adminPushSubscriptions: ...` entry (the one ending `: DEFAULT_DATA.adminPushSubscriptions,`) add:

```ts
    adminDevices: Array.isArray(data?.adminDevices)
      ? data.adminDevices
      : DEFAULT_DATA.adminDevices,
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/admin.schema.ts src/core/database/models/admin.model.ts src/core/database/db.ts
git commit -m "feat(admin-device): add adminDevices schema and db defaults" -m $'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_014rjHKjm6C3YxohmSkjPZ3V'
```

---

### Task 2: AdminDeviceService

**Files:**
- Create: `src/services/admin-device.service.ts`
- Test: `src/services/admin-device.service.spec.ts`

**Interfaces:**
- Consumes: `AdminDeviceEntry`, `AdminDeviceSeverity` (Task 1); `db` from `./db`.
- Produces (all exported from `src/services/admin-device.service.ts`):
  - constants `ADMIN_DEVICE_COOKIE = 'adminDevice'`, `MAX_ADMIN_DEVICES = 20`, `MAX_DEVICE_LABEL_LENGTH = 40`, `DEVICE_COOKIE_TTL_MS`
  - `DEVICE_COOKIE_OPTIONS: { httpOnly: true; sameSite: 'strict'; maxAge: number }`
  - `class AdminDeviceValidationError extends Error`
  - `defaultLabelFromUserAgent(ua: string): string`
  - `interface AdminDeviceView { id; label; minSeverity; lastSeenAt; isCurrent: boolean; hasPush: boolean }`
  - `class AdminDeviceService` with:
    - `enroll(label: string | undefined, userAgent: string): Promise<{ device: AdminDeviceEntry; cookieValue: string }>`
    - `verifyCookie(cookieValue: unknown): Promise<AdminDeviceEntry | null>`
    - `resolveOrEnroll(cookieValue: unknown, label: string | undefined, userAgent: string): Promise<{ device: AdminDeviceEntry; cookieValue: string }>`
    - `getById(id: string): AdminDeviceEntry | null`
    - `list(currentId?: string): AdminDeviceView[]`
    - `update(id: string, patch: { label?: unknown; minSeverity?: unknown }): Promise<AdminDeviceEntry | null>`
    - `revoke(id: string): Promise<boolean>`
  - `adminDeviceService` singleton.

- [ ] **Step 1: Write the failing tests**

Create `src/services/admin-device.service.spec.ts`:

```ts
jest.mock('./db', () => ({ db: { data: null, write: jest.fn() } }));

import {
  AdminDeviceService,
  AdminDeviceValidationError,
  DEVICE_COOKIE_TTL_MS,
  MAX_ADMIN_DEVICES,
  MAX_DEVICE_LABEL_LENGTH,
  defaultLabelFromUserAgent,
} from './admin-device.service';

function makeService() {
  const data: any = { adminDevices: [], adminPushSubscriptions: [] };
  let nowMs = 1_000_000;
  const service = new AdminDeviceService({
    getDbData: () => data,
    writeDb: async () => {},
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
    const generated = await service.enroll(undefined, 'Mozilla/5.0 (Windows NT 10.0) Chrome/1 Safari/1');
    expect(generated.device.label).toBe('Windows Chrome');

    const long = await service.enroll(`  ${'x'.repeat(100)}  `, 'ua');
    expect(long.device.label).toHaveLength(MAX_DEVICE_LABEL_LENGTH);
  });

  it('rejects a wrong secret', async () => {
    const { service } = makeService();
    const { device } = await service.enroll('Phone', 'ua');
    expect(await service.verifyCookie(`${device.id}.not-the-secret`)).toBeNull();
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

describe('AdminDeviceService.resolveOrEnroll', () => {
  it('reuses the presented device when the cookie is valid', async () => {
    const { service, data } = makeService();
    const first = await service.enroll('Phone', 'ua');
    const again = await service.resolveOrEnroll(first.cookieValue, undefined, 'ua');

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
    data.adminPushSubscriptions.push({ id: 's1', endpoint: 'e1', deviceId: first.device.id });
    for (let i = 1; i < MAX_ADMIN_DEVICES; i++) {
      advance(1000);
      await service.enroll(`d${i}`, 'ua');
    }
    expect(data.adminDevices).toHaveLength(MAX_ADMIN_DEVICES);

    advance(1000);
    const newest = await service.enroll('newest', 'ua');

    expect(data.adminDevices).toHaveLength(MAX_ADMIN_DEVICES);
    expect(data.adminDevices.some((d: any) => d.id === first.device.id)).toBe(false);
    expect(data.adminDevices.some((d: any) => d.id === newest.device.id)).toBe(true);
    expect(data.adminPushSubscriptions).toHaveLength(0);
  });
});

describe('AdminDeviceService.update / revoke / list', () => {
  it('updates label and severity with validation', async () => {
    const { service } = makeService();
    const { device } = await service.enroll('Phone', 'ua');

    const updated = await service.update(device.id, { label: '  Shop laptop ', minSeverity: 'critical' });
    expect(updated?.label).toBe('Shop laptop');
    expect(updated?.minSeverity).toBe('critical');

    await expect(service.update(device.id, { minSeverity: 'info' })).rejects.toBeInstanceOf(
      AdminDeviceValidationError,
    );
    await expect(service.update(device.id, { label: '   ' })).rejects.toBeInstanceOf(
      AdminDeviceValidationError,
    );
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
    data.adminPushSubscriptions.push({ id: 's1', endpoint: 'e1', deviceId: b.device.id });

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/services/admin-device.service.spec.ts`
Expected: FAIL with `Cannot find module './admin-device.service'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/admin-device.service.ts`:

```ts
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { db } from './db';
import type {
  AdminDeviceEntry,
  AdminDeviceSeverity,
} from '@/modules/admin/admin.schema';

export const ADMIN_DEVICE_COOKIE = 'adminDevice';
export const MAX_ADMIN_DEVICES = 20;
export const MAX_DEVICE_LABEL_LENGTH = 40;
export const DEVICE_COOKIE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_COOKIE_LENGTH = 200;

export const DEVICE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  maxAge: DEVICE_COOKIE_TTL_MS,
};

export class AdminDeviceValidationError extends Error {}

export interface AdminDeviceServiceDeps {
  getDbData?: () => typeof db.data;
  writeDb?: () => Promise<void>;
  now?: () => number;
}

export interface AdminDeviceView {
  id: string;
  label: string;
  minSeverity: AdminDeviceSeverity;
  lastSeenAt: string;
  isCurrent: boolean;
  hasPush: boolean;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function normalizeLabel(label: unknown): string {
  if (typeof label !== 'string') return '';
  return label.trim().slice(0, MAX_DEVICE_LABEL_LENGTH).trim();
}

export function defaultLabelFromUserAgent(ua: string): string {
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return browser ? `${os} ${browser}` : os;
}

export class AdminDeviceService {
  private readonly deps: Required<AdminDeviceServiceDeps>;

  constructor(deps: AdminDeviceServiceDeps = {}) {
    this.deps = {
      getDbData: deps.getDbData ?? (() => db.data),
      writeDb: deps.writeDb ?? (() => db.write()),
      now: deps.now ?? (() => Date.now()),
    };
  }

  private data() {
    const data = this.deps.getDbData();
    if (!data) throw new Error('Database not initialized');
    if (!data.adminDevices) data.adminDevices = [];
    if (!data.adminPushSubscriptions) data.adminPushSubscriptions = [];
    return data;
  }

  private removeDevices(ids: Set<string>): void {
    const data = this.data();
    data.adminDevices = data.adminDevices.filter((d) => !ids.has(d.id));
    data.adminPushSubscriptions = data.adminPushSubscriptions.filter(
      (s) => !s.deviceId || !ids.has(s.deviceId),
    );
  }

  private evictOverflow(keepId: string): void {
    const data = this.data();
    while (data.adminDevices.length > MAX_ADMIN_DEVICES) {
      let oldest: AdminDeviceEntry | null = null;
      for (const device of data.adminDevices) {
        if (device.id === keepId) continue;
        if (!oldest || Date.parse(device.lastSeenAt) < Date.parse(oldest.lastSeenAt)) {
          oldest = device;
        }
      }
      if (!oldest) return;
      this.removeDevices(new Set([oldest.id]));
    }
  }

  async enroll(
    label: string | undefined,
    userAgent: string,
  ): Promise<{ device: AdminDeviceEntry; cookieValue: string }> {
    const data = this.data();
    const nowIso = new Date(this.deps.now()).toISOString();
    const secret = randomBytes(32).toString('base64url');
    const device: AdminDeviceEntry = {
      id: randomUUID(),
      label: normalizeLabel(label) || defaultLabelFromUserAgent(userAgent),
      tokenHash: hashSecret(secret),
      minSeverity: 'warning',
      createdAt: nowIso,
      lastSeenAt: nowIso,
    };
    data.adminDevices.push(device);
    this.evictOverflow(device.id);
    await this.deps.writeDb();
    return { device, cookieValue: `${device.id}.${secret}` };
  }

  async verifyCookie(cookieValue: unknown): Promise<AdminDeviceEntry | null> {
    if (typeof cookieValue !== 'string' || cookieValue.length > MAX_COOKIE_LENGTH) {
      return null;
    }
    const dot = cookieValue.indexOf('.');
    if (dot <= 0) return null;
    const id = cookieValue.slice(0, dot);
    const secret = cookieValue.slice(dot + 1);
    if (!secret) return null;

    const device = this.data().adminDevices.find((d) => d.id === id);
    if (!device) return null;

    const presented = Buffer.from(hashSecret(secret), 'hex');
    const stored = Buffer.from(device.tokenHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      return null;
    }

    const now = this.deps.now();
    const lastSeen = Date.parse(device.lastSeenAt);
    const idleMs = Number.isFinite(lastSeen) ? now - lastSeen : Infinity;
    if (idleMs > DEVICE_COOKIE_TTL_MS) return null;
    if (idleMs > TOUCH_INTERVAL_MS) {
      device.lastSeenAt = new Date(now).toISOString();
      await this.deps.writeDb();
    }
    return device;
  }

  async resolveOrEnroll(
    cookieValue: unknown,
    label: string | undefined,
    userAgent: string,
  ): Promise<{ device: AdminDeviceEntry; cookieValue: string }> {
    const existing = await this.verifyCookie(cookieValue);
    if (existing && typeof cookieValue === 'string') {
      return { device: existing, cookieValue };
    }
    return this.enroll(label, userAgent);
  }

  getById(id: string): AdminDeviceEntry | null {
    return this.data().adminDevices.find((d) => d.id === id) ?? null;
  }

  list(currentId?: string): AdminDeviceView[] {
    const data = this.data();
    const withPush = new Set(
      data.adminPushSubscriptions.map((s) => s.deviceId).filter(Boolean),
    );
    return data.adminDevices.map((d) => ({
      id: d.id,
      label: d.label,
      minSeverity: d.minSeverity,
      lastSeenAt: d.lastSeenAt,
      isCurrent: d.id === currentId,
      hasPush: withPush.has(d.id),
    }));
  }

  async update(
    id: string,
    patch: { label?: unknown; minSeverity?: unknown },
  ): Promise<AdminDeviceEntry | null> {
    const device = this.getById(id);
    if (!device) return null;

    let nextLabel = device.label;
    let nextSeverity = device.minSeverity;

    if (patch.label !== undefined) {
      nextLabel = normalizeLabel(patch.label);
      if (!nextLabel) {
        throw new AdminDeviceValidationError('Label must not be empty.');
      }
    }
    if (patch.minSeverity !== undefined) {
      if (patch.minSeverity !== 'critical' && patch.minSeverity !== 'warning') {
        throw new AdminDeviceValidationError(
          "minSeverity must be 'critical' or 'warning'.",
        );
      }
      nextSeverity = patch.minSeverity;
    }

    device.label = nextLabel;
    device.minSeverity = nextSeverity;
    await this.deps.writeDb();
    return device;
  }

  async revoke(id: string): Promise<boolean> {
    if (!this.getById(id)) return false;
    this.removeDevices(new Set([id]));
    await this.deps.writeDb();
    return true;
  }
}

export const adminDeviceService = new AdminDeviceService();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/services/admin-device.service.spec.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/admin-device.service.ts src/services/admin-device.service.spec.ts
git commit -m "feat(admin-device): add device service with cookie verification and cap" -m $'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_014rjHKjm6C3YxohmSkjPZ3V'
```

---

### Task 3: Device-aware sessions and the cookie fallback

**Files:**
- Modify: `src/utils/admin-session.ts`
- Modify: `src/middleware/admin-auth.ts:1-3,42-53`
- Test: `src/utils/admin-session.spec.ts` (create), `src/middleware/admin-auth.spec.ts` (create)

**Interfaces:**
- Consumes: `adminDeviceService.verifyCookie`, `ADMIN_DEVICE_COOKIE` (Task 2).
- Produces from `src/utils/admin-session.ts`:
  - `ADMIN_SESSION_COOKIE_OPTIONS: { httpOnly: true; sameSite: 'strict'; maxAge: number }`
  - `createAdminSession(deviceId?: string): string`
  - `getAdminSessionDeviceId(token: string): string | undefined`
  - `destroySessionsForDevice(deviceId: string): number`
- `requireAdminPin` sets `res.locals.adminDeviceId` (string or undefined) and, on fallback, the `adminToken` cookie and the `x-admin-session-token` response header.

- [ ] **Step 1: Write the failing session tests**

Create `src/utils/admin-session.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/utils/admin-session.spec.ts`
Expected: FAIL (`getAdminSessionDeviceId` / `destroySessionsForDevice` is not a function, or a type error).

- [ ] **Step 3: Implement session changes**

In `src/utils/admin-session.ts`, replace the `AdminSession` interface, add the cookie options constant after `MAX_SESSIONS`, change `createAdminSession`, and add the two new functions:

```ts
export const ADMIN_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  maxAge: SESSION_TTL_MS,
};

interface AdminSession {
  token: string;
  lastActivityAt: number;
  deviceId?: string;
}
```

Change the signature and the `set` call in `createAdminSession`:

```ts
export function createAdminSession(deviceId?: string): string {
```

```ts
  activeSessions.set(token, { token, lastActivityAt: now, deviceId });
```

Append at the end of the file:

```ts
export function getAdminSessionDeviceId(token: string): string | undefined {
  return activeSessions.get(token)?.deviceId;
}

export function destroySessionsForDevice(deviceId: string): number {
  let removed = 0;
  for (const [token, session] of activeSessions.entries()) {
    if (session.deviceId === deviceId) {
      activeSessions.delete(token);
      removed++;
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run to verify session tests pass**

Run: `npx jest src/utils/admin-session.spec.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Write the failing middleware tests**

Create `src/middleware/admin-auth.spec.ts`:

```ts
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

function makeReq(opts: { headers?: Record<string, string>; cookies?: Record<string, string> }) {
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

    await requireAdminPin(makeReq({ headers: { 'x-admin-token': token } }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.locals.adminDeviceId).toBe('dev-1');
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });

  it('after a restart (no sessions) a valid device cookie mints a fresh session', async () => {
    mockVerifyCookie.mockResolvedValue({ id: 'dev-1' });
    const res = makeRes();
    const next = jest.fn();

    await requireAdminPin(makeReq({ cookies: { adminDevice: 'dev-1.secret' } }), res, next);

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

    await requireAdminPin(makeReq({ cookies: { adminDevice: 'bad' } }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('answers 401 when device verification throws', async () => {
    mockVerifyCookie.mockRejectedValue(new Error('db not ready'));
    const res = makeRes();
    const next = jest.fn();

    await requireAdminPin(makeReq({ cookies: { adminDevice: 'x.y' } }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx jest src/middleware/admin-auth.spec.ts`
Expected: FAIL (fallback tests fail: no cookie set / `next` not called).

- [ ] **Step 7: Implement the middleware fallback**

In `src/middleware/admin-auth.ts` replace the import on line 3 with:

```ts
import {
  ADMIN_SESSION_COOKIE_OPTIONS,
  createAdminSession,
  getAdminSessionDeviceId,
  validateAdminSession,
} from '@/utils/admin-session';
import {
  ADMIN_DEVICE_COOKIE,
  adminDeviceService,
} from '@/services/admin-device.service';
```

Replace the whole `requireAdminPin` export (lines 42-53) with:

```ts
export const requireAdminPin: RequestHandler = async (req, res, next) => {
  const headerToken = req.get('x-admin-token') || undefined;
  const cookieToken =
    (req.cookies?.['adminToken'] as string | undefined) || undefined;
  const token = headerToken ?? cookieToken;
  if (token && validateAdminSession(token)) {
    res.locals.adminDeviceId = getAdminSessionDeviceId(token);
    return next();
  }

  // Session missing or unknown (server restart, expiry): re-derive it from
  // the persisted device cookie.
  const device = await adminDeviceService
    .verifyCookie(req.cookies?.[ADMIN_DEVICE_COOKIE])
    .catch(() => null);
  if (device) {
    const sessionToken = createAdminSession(device.id);
    res.cookie('adminToken', sessionToken, ADMIN_SESSION_COOKIE_OPTIONS);
    // Lets a client holding a stale x-admin-token header switch to the new one.
    res.setHeader('x-admin-session-token', sessionToken);
    res.locals.adminDeviceId = device.id;
    return next();
  }

  return res.status(401).json({
    error: 'Admin session invalid or expired. Please log in again.',
  });
};
```

- [ ] **Step 8: Run to verify the middleware and session tests pass**

Run: `npx jest src/middleware/admin-auth.spec.ts src/utils/admin-session.spec.ts`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/utils/admin-session.ts src/utils/admin-session.spec.ts src/middleware/admin-auth.ts src/middleware/admin-auth.spec.ts
git commit -m "feat(admin-auth): bind sessions to devices and re-derive them from the device cookie" -m $'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_014rjHKjm6C3YxohmSkjPZ3V'
```

---

### Task 4: Login and logout establish and clear the device

**Files:**
- Create: `src/utils/admin-login.ts`
- Test: `src/utils/admin-login.spec.ts`
- Modify: `src/modules/admin/admin.controller.ts` (import line 84; `handleAuth` ~938-946; `handleVerifyPin` ~977-982; `handleLogout` ~1011-1020)

**Interfaces:**
- Consumes: `adminDeviceService.resolveOrEnroll`, `ADMIN_DEVICE_COOKIE`, `DEVICE_COOKIE_OPTIONS` (Task 2); `createAdminSession`, `ADMIN_SESSION_COOKIE_OPTIONS` (Task 3).
- Produces: `establishAdminSession(req: Request, res: Response): Promise<string>` returns the session token, sets both cookies, sets `res.locals.adminDeviceId`; `clearAdminSessionCookies(res: Response): void`.

- [ ] **Step 1: Write the failing tests**

Create `src/utils/admin-login.spec.ts`:

```ts
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
    get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'test-agent' : undefined),
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
      makeReq({ body: { deviceLabel: 'Phone' }, cookies: { adminDevice: 'old' } }),
      res,
    );

    expect(mockResolveOrEnroll).toHaveBeenCalledWith('old', 'Phone', 'test-agent');
    expect(validateAdminSession(token)).toBe(true);
    expect(getAdminSessionDeviceId(token)).toBe('dev-1');
    const names = res.cookie.mock.calls.map((c: any[]) => c[0]);
    expect(names).toEqual(expect.arrayContaining(['adminToken', 'adminDevice']));
    expect(res.locals.adminDeviceId).toBe('dev-1');
  });

  it('ignores a non-string deviceLabel', async () => {
    mockResolveOrEnroll.mockResolvedValue({ device: { id: 'd' }, cookieValue: 'd.s' });
    await establishAdminSession(makeReq({ body: { deviceLabel: { evil: true } } }), makeRes());
    expect(mockResolveOrEnroll).toHaveBeenCalledWith(undefined, undefined, 'test-agent');
  });

  it('still logs in with an anonymous session when enrolment fails', async () => {
    mockResolveOrEnroll.mockRejectedValue(new Error('db down'));
    const res = makeRes();

    const token = await establishAdminSession(makeReq(), res);

    expect(validateAdminSession(token)).toBe(true);
    expect(getAdminSessionDeviceId(token)).toBeUndefined();
    expect(res.cookie.mock.calls.map((c: any[]) => c[0])).toEqual(['adminToken']);
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/utils/admin-login.spec.ts`
Expected: FAIL with `Cannot find module './admin-login'`.

- [ ] **Step 3: Implement the helper**

Create `src/utils/admin-login.ts`:

```ts
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
    typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel : undefined;
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
    console.error('[ADMIN] Device enrolment failed, using anonymous session', err);
    const sessionToken = createAdminSession();
    res.cookie('adminToken', sessionToken, ADMIN_SESSION_COOKIE_OPTIONS);
    return sessionToken;
  }
}

export function clearAdminSessionCookies(res: Response): void {
  res.clearCookie('adminToken');
  res.clearCookie(ADMIN_DEVICE_COOKIE);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/utils/admin-login.spec.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Use it in the controller**

In `src/modules/admin/admin.controller.ts` replace line 84:

```ts
import { createAdminSession, destroyAdminSession } from '@/utils/admin-session';
```

with:

```ts
import { destroyAdminSession } from '@/utils/admin-session';
import {
  clearAdminSessionCookies,
  establishAdminSession,
} from '@/utils/admin-login';
```

In `handleAuth`, replace:

```ts
    await clearLockout();
    const sessionToken = createAdminSession();

    res.cookie('adminToken', sessionToken, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.json({ ok: true, sessionToken });
```

with:

```ts
    await clearLockout();
    const sessionToken = await establishAdminSession(req, res);

    return res.json({ ok: true, sessionToken });
```

In `handleVerifyPin`, replace:

```ts
    const sessionToken = createAdminSession();
    res.cookie('adminToken', sessionToken, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    });

    if (req.body?.action === 'disable_ui_blocking') {
```

with:

```ts
    const sessionToken = await establishAdminSession(req, res);

    if (req.body?.action === 'disable_ui_blocking') {
```

In `handleLogout`, replace `res.clearCookie('adminToken');` with `clearAdminSessionCookies(res);`.

- [ ] **Step 6: Typecheck and rerun related tests**

Run: `npx tsc --noEmit -p tsconfig.json && npx jest src/utils src/middleware`
Expected: typecheck clean; all tests PASS. If tsc reports `createAdminSession` unused elsewhere in the controller, there is no other use; the import was removed on purpose.

- [ ] **Step 7: Commit**

```bash
git add src/utils/admin-login.ts src/utils/admin-login.spec.ts src/modules/admin/admin.controller.ts
git commit -m "feat(admin-auth): enrol or reuse the device at login and clear both cookies on logout" -m $'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_014rjHKjm6C3YxohmSkjPZ3V'
```

---

### Task 5: Push service routing and ownership

**Files:**
- Modify: `src/services/admin-push.service.ts` (`hasSubscription` 73-76, `subscribe` 157-188, `unsubscribe` 190-202, `broadcastCriticalAlert` 204-295, `sendTestNotification` 297-335)
- Modify: `src/services/admin-push.service.spec.ts` (helper lines 17-43, append new describes)

**Interfaces:**
- Consumes: `AdminDeviceEntry` shape in `data.adminDevices`; `AdminPushSubscriptionEntry.deviceId` (Task 1).
- Produces:
  - `hasSubscription(endpoint: string, deviceId?: string): boolean` (with `deviceId`, true only when that device owns the subscription)
  - `subscribe(sub, deviceId: string, userAgent?: string): Promise<AdminPushSubscriptionEntry>`
  - `unsubscribe(endpoint: string, deviceId: string): Promise<'removed' | 'absent' | 'forbidden'>`
  - `sendTestNotification(endpoint: string, deviceId: string): Promise<boolean>`
  - `broadcastCriticalAlert(alert): Promise<{ sent: number; pruned: number; skipped: number }>`

- [ ] **Step 1: Extend the spec helper and add failing tests**

In `src/services/admin-push.service.spec.ts` replace the `makeService` function (lines 17-43) with:

```ts
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
```

Append at the end of the file:

```ts
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
    expect(sendNotification.mock.calls[0][0].endpoint).toBe('https://fcm/laptop');
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
    const { service, data } = makeService([{ endpoint: 'https://fcm/old', deviceId: 'phone' }]);

    await service.subscribe(
      { endpoint: 'https://fcm/new', keys: { p256dh: 'p', auth: 'a' } },
      'phone',
      'jest',
    );

    expect(data.adminPushSubscriptions.map((s: any) => s.endpoint)).toEqual(['https://fcm/new']);
    expect(data.adminPushSubscriptions[0].deviceId).toBe('phone');
  });

  it('subscribe lets a device take over an endpoint owned by another device or nobody', async () => {
    const { service, data } = makeService([
      { endpoint: 'https://fcm/a', deviceId: 'old-device' },
      { endpoint: 'https://fcm/b' },
    ]);

    await service.subscribe({ endpoint: 'https://fcm/a', keys: { p256dh: 'p', auth: 'a' } }, 'new-device');
    await service.subscribe({ endpoint: 'https://fcm/b', keys: { p256dh: 'p', auth: 'a' } }, 'new-device');

    const byEndpoint = Object.fromEntries(
      data.adminPushSubscriptions.map((s: any) => [s.endpoint, s.deviceId]),
    );
    expect(byEndpoint['https://fcm/b']).toBe('new-device');
    // the replace rule keeps one subscription per device
    expect(data.adminPushSubscriptions.filter((s: any) => s.deviceId === 'new-device')).toHaveLength(1);
  });

  it('unsubscribe removes own, refuses foreign, reports absent', async () => {
    const { service, data } = makeService([{ endpoint: 'https://fcm/a', deviceId: 'phone' }]);

    expect(await service.unsubscribe('https://fcm/a', 'laptop')).toBe('forbidden');
    expect(data.adminPushSubscriptions).toHaveLength(1);
    expect(await service.unsubscribe('https://fcm/missing', 'phone')).toBe('absent');
    expect(await service.unsubscribe('https://fcm/a', 'phone')).toBe('removed');
    expect(data.adminPushSubscriptions).toHaveLength(0);
  });

  it('test push is refused for a foreign subscription and ignores minSeverity for the owner', async () => {
    sendNotification.mockResolvedValue({});
    const { service } = makeService(
      [{ endpoint: 'https://fcm/a', deviceId: 'phone' }],
      [{ id: 'phone', minSeverity: 'critical' }],
    );

    expect(await service.sendTestNotification('https://fcm/a', 'laptop')).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(await service.sendTestNotification('https://fcm/a', 'phone')).toBe(true);
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
```

The existing `AdminPushService.hasSubscription` describe stays valid (it calls `hasSubscription(endpoint)` with one argument).

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/services/admin-push.service.spec.ts`
Expected: the new tests FAIL (the second argument is not accepted, `skipped` is missing); the original 9 still pass.

- [ ] **Step 3: Implement in `admin-push.service.ts`**

Replace `hasSubscription` (lines 73-76) with:

```ts
  hasSubscription(endpoint: string, deviceId?: string): boolean {
    const data = this.deps.getDbData();
    return !!data?.adminPushSubscriptions?.some(
      (s) =>
        s.endpoint === endpoint && (deviceId === undefined || s.deviceId === deviceId),
    );
  }
```

Replace `subscribe` (lines 157-188) with:

```ts
  async subscribe(
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    deviceId: string,
    userAgent = 'Unknown',
  ): Promise<AdminPushSubscriptionEntry> {
    const data = this.deps.getDbData();
    if (!data) throw new Error('Database not initialized');
    if (!data.adminPushSubscriptions) data.adminPushSubscriptions = [];

    // One subscription per device: drop the device's previous endpoints.
    data.adminPushSubscriptions = data.adminPushSubscriptions.filter(
      (s) => s.endpoint === sub.endpoint || s.deviceId !== deviceId,
    );

    const existing = data.adminPushSubscriptions.find(
      (s) => s.endpoint === sub.endpoint,
    );
    if (existing) {
      // Presenting the endpoint with its keys proves possession, so the caller
      // may take the subscription over (e.g. after a logout/login created a
      // new device record for the same browser).
      existing.keys = sub.keys;
      existing.userAgent = userAgent;
      existing.deviceId = deviceId;
      await this.deps.writeDb();
      return existing;
    }

    const entry: AdminPushSubscriptionEntry = {
      id: randomUUID(),
      endpoint: sub.endpoint,
      keys: sub.keys,
      userAgent,
      createdAt: new Date().toISOString(),
      lastNotifiedAt: null,
      deviceId,
    };
    data.adminPushSubscriptions.push(entry);
    await this.deps.writeDb();
    return entry;
  }
```

Replace `unsubscribe` (lines 190-202) with:

```ts
  async unsubscribe(
    endpoint: string,
    deviceId: string,
  ): Promise<'removed' | 'absent' | 'forbidden'> {
    const data = this.deps.getDbData();
    const sub = data?.adminPushSubscriptions?.find((s) => s.endpoint === endpoint);
    if (!data || !sub) return 'absent';
    if (sub.deviceId && sub.deviceId !== deviceId) return 'forbidden';
    data.adminPushSubscriptions = data.adminPushSubscriptions.filter(
      (s) => s.endpoint !== endpoint,
    );
    await this.deps.writeDb();
    return 'removed';
  }
```

In `broadcastCriticalAlert`: change the return type to `Promise<{ sent: number; pruned: number; skipped: number }>`; change both early `return { sent: 0, pruned: 0 };` to `return { sent: 0, pruned: 0, skipped: 0 };`; and replace the block from `const subscriptions = data.adminPushSubscriptions || [];` through the end of the `Promise.all(...)` call's opening line `subscriptions.map(async (sub) => {` so it reads:

```ts
    const subscriptions = data.adminPushSubscriptions || [];
    const devices = data.adminDevices ?? [];
    // Fail open: a missing device record or a legacy subscription gets everything.
    const targets = subscriptions.filter((sub) => {
      const minSeverity =
        devices.find((d) => d.id === sub.deviceId)?.minSeverity ?? 'warning';
      return minSeverity === 'warning' || alert.severity === 'critical';
    });
    const skippedCount = subscriptions.length - targets.length;
    let sentCount = 0;
    const deadEndpoints = new Set<string>();
```

(keep the `payload` constant as is), then change `subscriptions.map(async (sub) => {` to `targets.map(async (sub) => {`. Finally change the last line `return { sent: sentCount, pruned: prunedCount };` to:

```ts
    return { sent: sentCount, pruned: prunedCount, skipped: skippedCount };
```

Replace the start of `sendTestNotification` (signature and the lookup through `if (!sub) return false;`) with:

```ts
  async sendTestNotification(endpoint: string, deviceId: string): Promise<boolean> {
    const data = this.deps.getDbData();
    const sub = data?.adminPushSubscriptions?.find(
      (s) => s.endpoint === endpoint,
    );
    if (!sub) return false;
    if (sub.deviceId && sub.deviceId !== deviceId) return false;
```

- [ ] **Step 4: Run to verify all push tests pass**

Run: `npx jest src/services/admin-push.service.spec.ts`
Expected: the original 9 plus the new tests all PASS.

- [ ] **Step 5: Check other callers of the changed signatures**

Run: `grep -rn "broadcastCriticalAlert\|adminPushService\.\(subscribe\|unsubscribe\|sendTestNotification\|hasSubscription\)" src --include=*.ts | grep -v "spec.ts" | grep -v "admin-push.service.ts"`
Expected: only the controller handlers (fixed in Task 6) and callers that read `.sent` or `.pruned`. If any other caller destructures the return value in a way that breaks, fix it here.

- [ ] **Step 6: Commit** (typecheck will still fail on the controller until Task 6; commit the service on its own)

```bash
git add src/services/admin-push.service.ts src/services/admin-push.service.spec.ts
git commit -m "feat(admin-push): route alerts by device severity and enforce subscription ownership" -m $'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_014rjHKjm6C3YxohmSkjPZ3V'
```

---

### Task 6: Controller push handlers and device routes

**Files:**
- Modify: `src/modules/admin/admin.controller.ts` (imports ~line 84; routes after the `/push/status` route ~535; handlers ~4258-4342)

**Interfaces:**
- Consumes: `adminPushService` new signatures (Task 5); `adminDeviceService.list/update/revoke/getById`, `AdminDeviceValidationError` (Task 2); `destroySessionsForDevice` (Task 3); `clearAdminSessionCookies` (Task 4); `res.locals.adminDeviceId` (Task 3).
- Produces: routes `GET /devices`, `PATCH /devices/:id`, `DELETE /devices/:id`; push handlers answer 403 `{ success: false, code: 'DEVICE_REQUIRED' }` when there is no device; `GET /push/status` adds `device`.

The controller has no existing handler test harness, so the handlers stay thin and the logic is covered by Tasks 2 and 5. Verification here is the typecheck plus the smoke test in Task 8.

- [ ] **Step 1: Add imports**

Next to the `destroyAdminSession` import added in Task 4, change it to:

```ts
import {
  destroyAdminSession,
  destroySessionsForDevice,
} from '@/utils/admin-session';
import {
  AdminDeviceValidationError,
  adminDeviceService,
} from '@/services/admin-device.service';
```

- [ ] **Step 2: Add the device routes**

After the `this.router.get('/push/status', ...)` registration (ends `this.handleGetPushStatus,\n    );`) insert:

```ts
    // ── Admin device routes ────────────────────────────────────────────────────
    this.router.get(
      '/devices',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleListDevices,
    );
    this.router.patch(
      '/devices/:id',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleUpdateDevice,
    );
    this.router.delete(
      '/devices/:id',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleRevokeDevice,
    );
```

- [ ] **Step 3: Replace the four push handlers**

Replace `handlePushSubscribe`, `handlePushUnsubscribe`, `handlePushTest` and `handleGetPushStatus` (lines ~4258-4342) with the following, and add the device handlers before the class's closing brace:

```ts
  private static readonly DEVICE_REQUIRED = {
    success: false,
    code: 'DEVICE_REQUIRED',
    error:
      'This session is not registered as a device. Log out, log in again with the PIN, then retry.',
  };

  private handlePushSubscribe = async (req: Request, res: Response) => {
    try {
      const deviceId = res.locals.adminDeviceId as string | undefined;
      if (!deviceId) {
        return res.status(403).json(AdminController.DEVICE_REQUIRED);
      }
      const { subscription } = req.body ?? {};
      if (
        !subscription?.endpoint ||
        !subscription?.keys?.p256dh ||
        !subscription?.keys?.auth
      ) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid subscription object.' });
      }
      const userAgent = (req.headers['user-agent'] as string) || 'Unknown';
      const entry = await adminPushService.subscribe(
        subscription,
        deviceId,
        userAgent,
      );
      return res.json({ success: true, subscription: entry });
    } catch (err: any) {
      console.error('[ADMIN] Failed to register push subscription', err);
      return res
        .status(500)
        .json({ success: false, error: err?.message || 'Failed to register subscription.' });
    }
  };

  private handlePushUnsubscribe = async (req: Request, res: Response) => {
    try {
      const deviceId = res.locals.adminDeviceId as string | undefined;
      if (!deviceId) {
        return res.status(403).json(AdminController.DEVICE_REQUIRED);
      }
      const { endpoint } = req.body ?? {};
      if (!endpoint || typeof endpoint !== 'string') {
        return res
          .status(400)
          .json({ success: false, error: 'Endpoint is required.' });
      }
      const result = await adminPushService.unsubscribe(endpoint, deviceId);
      if (result === 'forbidden') {
        return res
          .status(404)
          .json({ success: false, error: 'Subscription not found.' });
      }
      return res.json({ success: true, removed: result === 'removed' });
    } catch (err: any) {
      console.error('[ADMIN] Failed to remove push subscription', err);
      return res
        .status(500)
        .json({ success: false, error: err?.message || 'Failed to remove subscription.' });
    }
  };

  private handlePushTest = async (req: Request, res: Response) => {
    try {
      const deviceId = res.locals.adminDeviceId as string | undefined;
      if (!deviceId) {
        return res.status(403).json(AdminController.DEVICE_REQUIRED);
      }
      const { endpoint } = req.body ?? {};
      if (!endpoint || typeof endpoint !== 'string') {
        return res
          .status(400)
          .json({ success: false, error: 'Endpoint is required.' });
      }
      const ok = await adminPushService.sendTestNotification(endpoint, deviceId);
      if (!ok) {
        return res
          .status(404)
          .json({ success: false, error: 'Subscription not found or delivery failed.' });
      }
      return res.json({ success: true });
    } catch (err: any) {
      console.error('[ADMIN] Failed to send test push notification', err);
      return res
        .status(500)
        .json({ success: false, error: err?.message || 'Failed to send test push.' });
    }
  };

  private handleGetPushStatus = async (req: Request, res: Response) => {
    try {
      const deviceId = res.locals.adminDeviceId as string | undefined;
      const subscriptions = db.data?.adminPushSubscriptions || [];
      const enabled = db.data?.settings.pushNotifications?.enabled ?? true;
      const endpoint =
        typeof req.query.endpoint === 'string' ? req.query.endpoint : '';
      const device = deviceId ? adminDeviceService.getById(deviceId) : null;
      return res.json({
        success: true,
        enabled,
        subscriptionCount: subscriptions.length,
        device: device
          ? { id: device.id, label: device.label, minSeverity: device.minSeverity }
          : null,
        ...(endpoint
          ? { registered: adminPushService.hasSubscription(endpoint, deviceId) }
          : {}),
      });
    } catch (err: any) {
      console.error('[ADMIN] Failed to get push status', err);
      return res
        .status(500)
        .json({ success: false, error: err?.message || 'Failed to get push status.' });
    }
  };

  // ── Admin device handlers ──────────────────────────────────────────────────

  private handleListDevices = (_req: Request, res: Response) => {
    try {
      const currentId = res.locals.adminDeviceId as string | undefined;
      return res.json({ success: true, devices: adminDeviceService.list(currentId) });
    } catch (err: any) {
      console.error('[ADMIN] Failed to list devices', err);
      return res
        .status(500)
        .json({ success: false, error: err?.message || 'Failed to list devices.' });
    }
  };

  private handleUpdateDevice = async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id ?? '');
      const { label, minSeverity } = req.body ?? {};
      const device = await adminDeviceService.update(id, { label, minSeverity });
      if (!device) {
        return res.status(404).json({ success: false, error: 'Device not found.' });
      }
      await this.adminService.appendAdminLog(
        'admin_device_updated',
        `Admin device "${device.label}" updated.`,
      );
      return res.json({
        success: true,
        device: { id: device.id, label: device.label, minSeverity: device.minSeverity },
      });
    } catch (err: any) {
      if (err instanceof AdminDeviceValidationError) {
        return res.status(400).json({ success: false, error: err.message });
      }
      console.error('[ADMIN] Failed to update device', err);
      return res
        .status(500)
        .json({ success: false, error: err?.message || 'Failed to update device.' });
    }
  };

  private handleRevokeDevice = async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id ?? '');
      const revoked = await adminDeviceService.revoke(id);
      if (!revoked) {
        return res.status(404).json({ success: false, error: 'Device not found.' });
      }
      destroySessionsForDevice(id);
      if (id === res.locals.adminDeviceId) {
        clearAdminSessionCookies(res);
      }
      await this.adminService.appendAdminLog(
        'admin_device_revoked',
        'An admin device was revoked.',
      );
      return res.json({ success: true });
    } catch (err: any) {
      console.error('[ADMIN] Failed to revoke device', err);
      return res
        .status(500)
        .json({ success: false, error: err?.message || 'Failed to revoke device.' });
    }
  };
```

If the class is not named `AdminController`, use its real name in `AdminController.DEVICE_REQUIRED` (check with `grep -n "^export class" src/modules/admin/admin.controller.ts`).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output. Fix any type error before continuing (for example, `res.locals` typing is `Record<string, any>`, so the casts are enough).

- [ ] **Step 5: Run all related tests**

Run: `npx jest src/services/admin-push.service.spec.ts src/services/admin-device.service.spec.ts src/utils src/middleware/admin-auth.spec.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/admin/admin.controller.ts
git commit -m "feat(admin): own-device push handlers and device list, rename and revoke routes" -m $'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_014rjHKjm6C3YxohmSkjPZ3V'
```

---

### Task 7: Client: session token refresh, DEVICE_REQUIRED message, Devices card

**Files:**
- Modify: `src/public/admin/shared.ts` (`apiFetch` ~469-496; `saveSubscriptionWithRetry` ~1087-1112)
- Modify: `src/public/admin/settings/index.html` (new card after the push card that ends at ~1259)
- Modify: `src/public/admin/settings/app.ts` (device UI near the push settings block ~1151-1259; hook into `refreshPushSettingsUI` and the enable handler)

There is no DOM test infrastructure in the repo, so this task is verified by typecheck, a client bundle build and the manual browser check in Task 8. Say so in the final report; do not claim it is unit tested.

- [ ] **Step 1: Store a refreshed session token in `apiFetch`**

In `shared.ts`, inside `apiFetch`, directly after `const res = await fetch(path, { ...init, headers, credentials: 'include' });` insert:

```ts
    // The server re-derived our session from the device cookie (e.g. after a
    // restart): adopt the new token instead of sending the stale one again.
    const refreshedToken = res.headers.get('x-admin-session-token');
    if (refreshedToken) setAdminToken(refreshedToken);
```

- [ ] **Step 2: Explain DEVICE_REQUIRED in `saveSubscriptionWithRetry`**

In `saveSubscriptionWithRetry`, after the existing `if (res.status === 401) { ... }` block insert:

```ts
      if (res.status === 403) {
        const body = await res.json().catch(() => null);
        if (body?.code === 'DEVICE_REQUIRED') {
          return {
            ok: false,
            error:
              'This browser is not registered as an admin device yet. Log out, log in again with the PIN, then enable push.',
          };
        }
      }
```

(Other 403 responses fall through to the existing generic `Kiosk rejected the subscription (HTTP 403)` message.)

- [ ] **Step 3: Add the Devices card markup**

In `src/public/admin/settings/index.html`, directly after the push card's closing `</div>` (the one right after the `pushMetaText` block, before `<div class="settings-footer">`), insert:

```html
              <!-- Admin Devices -->
              <div class="sg" id="adminDevicesCard">
                <div class="sg__head">
                  <h3 class="sg__title">Admin Devices</h3>
                </div>
                <div style="padding: 16px 24px 20px;">
                  <p class="field__hint" style="margin-bottom: 12px; font-size: 13px; line-height: 1.5;">
                    Every device that logs in with the PIN is listed here. Choose what each device is alerted about, rename it, or revoke a lost one.
                  </p>
                  <div id="adminDevicesList"></div>
                  <div class="field__hint" id="adminDevicesEmpty" style="font-size: 0.8rem; color: #94a3b8;">Loading devices...</div>
                </div>
              </div>
```

- [ ] **Step 4: Add the device UI logic**

In `src/public/admin/settings/app.ts`, directly above the line `let pushEventsInitialized = false;`, insert:

```ts
// ── Admin Devices UI ───────────────────────────────────────────────────────
interface AdminDeviceRow {
  id: string;
  label: string;
  minSeverity: 'critical' | 'warning';
  lastSeenAt: string;
  isCurrent: boolean;
  hasPush: boolean;
}

const adminDevicesList = document.getElementById('adminDevicesList') as HTMLElement | null;
const adminDevicesEmpty = document.getElementById('adminDevicesEmpty') as HTMLElement | null;
const DEVICE_NAME_PROMPTED_KEY = 'printbit.deviceNamePrompted';

async function patchDevice(
  id: string,
  body: { label?: string; minSeverity?: 'critical' | 'warning' },
): Promise<boolean> {
  const res = await apiFetch(`/api/admin/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    setMessage(data?.error || 'Failed to update device.');
  }
  return res.ok;
}

function renderAdminDevices(devices: AdminDeviceRow[]): void {
  if (!adminDevicesList) return;
  adminDevicesList.replaceChildren();
  if (adminDevicesEmpty) {
    adminDevicesEmpty.textContent = devices.length === 0 ? 'No devices registered yet.' : '';
  }

  for (const device of devices) {
    const row = document.createElement('div');
    row.dataset.deviceId = device.id;
    row.style.cssText =
      'display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);';

    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'field__input';
    label.maxLength = 40;
    label.value = device.label;
    label.setAttribute('aria-label', 'Device name');
    label.style.cssText = 'flex:1 1 160px;min-width:140px;';
    label.dataset.field = 'label';

    const severity = document.createElement('select');
    severity.className = 'field__input';
    severity.setAttribute('aria-label', 'Alert level');
    severity.dataset.field = 'severity';
    for (const [value, text] of [
      ['warning', 'Everything'],
      ['critical', 'Critical only'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      option.selected = device.minSeverity === value;
      severity.appendChild(option);
    }

    const meta = document.createElement('span');
    meta.className = 'field__hint';
    meta.style.cssText = 'font-size:0.75rem;color:#94a3b8;';
    const lastSeen = new Date(device.lastSeenAt);
    meta.textContent = [
      device.isCurrent ? 'This device' : '',
      device.hasPush ? 'Push on' : 'Push off',
      Number.isNaN(lastSeen.getTime()) ? '' : `Seen ${lastSeen.toLocaleString()}`,
    ]
      .filter(Boolean)
      .join(' · ');

    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'btn-pwa-install';
    revoke.dataset.action = 'revoke';
    revoke.textContent = 'Revoke';
    revoke.style.cssText =
      'color:#f87171;border-color:rgba(248,113,113,0.4);background:rgba(248,113,113,0.1);';

    row.append(label, severity, meta, revoke);
    adminDevicesList.appendChild(row);
  }
}

async function refreshAdminDevicesUI(): Promise<void> {
  if (!adminDevicesList) return;
  // Do not clobber a name the user is typing.
  if (adminDevicesList.contains(document.activeElement)) return;
  try {
    const res = await apiFetch('/api/admin/devices');
    if (!res.ok) return;
    const data = await res.json();
    renderAdminDevices(Array.isArray(data.devices) ? data.devices : []);
  } catch {
    // Ignore device list refresh failure
  }
}

let adminDevicesEventsInitialized = false;
function initAdminDevicesEvents(): void {
  if (adminDevicesEventsInitialized || !adminDevicesList) return;
  adminDevicesEventsInitialized = true;

  adminDevicesList.addEventListener('change', async (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const id = target.closest<HTMLElement>('[data-device-id]')?.dataset.deviceId;
    if (!id) return;
    if (target.dataset.field === 'label') {
      const value = target.value.trim();
      if (!value) {
        void refreshAdminDevicesUI();
        return;
      }
      if (await patchDevice(id, { label: value })) setMessage('Device renamed.');
    } else if (target.dataset.field === 'severity') {
      const minSeverity = target.value === 'critical' ? 'critical' : 'warning';
      if (await patchDevice(id, { minSeverity })) setMessage('Alert level updated.');
    }
    (document.activeElement as HTMLElement | null)?.blur();
    void refreshAdminDevicesUI();
  });

  adminDevicesList.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-action="revoke"]',
    );
    if (!button) return;
    const row = button.closest<HTMLElement>('[data-device-id]');
    const id = row?.dataset.deviceId;
    if (!id) return;
    const name = row?.querySelector<HTMLInputElement>('input[data-field="label"]')?.value ?? 'this device';
    if (!window.confirm(`Revoke "${name}"? It will stop receiving alerts and must log in with the PIN again.`)) {
      return;
    }
    button.disabled = true;
    const res = await apiFetch(`/api/admin/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      button.disabled = false;
      setMessage('Failed to revoke device.');
      return;
    }
    setMessage('Device revoked.');
    // Revoking the device we are on drops our own session: reload to the login screen.
    if (row?.querySelector('span')?.textContent?.startsWith('This device')) {
      window.location.reload();
      return;
    }
    void refreshAdminDevicesUI();
  });

  // Typing in a device row must not mark the settings form dirty.
  adminDevicesList.addEventListener('input', (event) => event.stopPropagation());
  adminDevicesList.addEventListener('change', (event) => event.stopPropagation());
}

async function offerDeviceNaming(): Promise<void> {
  try {
    if (localStorage.getItem(DEVICE_NAME_PROMPTED_KEY)) return;
  } catch {
    return;
  }
  try {
    const res = await apiFetch('/api/admin/push/status');
    if (!res.ok) return;
    const device = (await res.json()).device as { id: string; label: string } | null;
    if (!device) return;
    const name = window.prompt(
      'Name this device so you can tell it apart in the device list:',
      device.label,
    );
    try {
      localStorage.setItem(DEVICE_NAME_PROMPTED_KEY, '1');
    } catch {
      // ignore storage failure
    }
    const trimmed = name?.trim();
    if (trimmed && trimmed !== device.label) {
      await patchDevice(device.id, { label: trimmed });
    }
    void refreshAdminDevicesUI();
  } catch {
    // Naming is optional; ignore failures.
  }
}
```

Note: the two `stopPropagation` listeners are registered after the handlers above, so the handlers on the same element still run first; they only stop the event from reaching the form.

- [ ] **Step 5: Hook the card into the existing flows**

In `refreshPushSettingsUI`, at the end of the function (after the `try { ... } catch { ... }` that reads `/api/admin/push/status`) add:

```ts
  void refreshAdminDevicesUI();
```

In the `enablePushBtn` click handler, replace:

```ts
    if (res.ok) {
      setMessage('Push notifications enabled for this device.');
      void refreshPushSettingsUI();
    } else {
```

with:

```ts
    if (res.ok) {
      setMessage('Push notifications enabled for this device.');
      void refreshPushSettingsUI();
      void offerDeviceNaming();
    } else {
```

In `initPushSettingsEvents`, add as the first statement after the `pushEventsInitialized = true;` line:

```ts
  initAdminDevicesEvents();
```

- [ ] **Step 6: Typecheck and build the client bundle**

Run: `npx tsc --noEmit -p tsconfig.json && node scripts/build-client.js`
Expected: typecheck clean; the build finishes without errors.

- [ ] **Step 7: Commit**

```bash
git add src/public/admin/shared.ts src/public/admin/settings/index.html src/public/admin/settings/app.ts
git commit -m "feat(admin-ui): device list card, token refresh and DEVICE_REQUIRED message" -m $'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_014rjHKjm6C3YxohmSkjPZ3V'
```

---

### Task 8: Final verification

**Files:** none modified (graphify output aside).

- [ ] **Step 1: Full related test run**

Run: `npx jest src/services/admin-push.service.spec.ts src/services/admin-device.service.spec.ts src/utils src/middleware`
Expected: every suite PASS, no skipped tests.

- [ ] **Step 2: Whole-suite regression**

Run: `npx jest`
Expected: no new failures compared with the run before this work. If an unrelated suite already failed on `main`, record it by name in the report; do not hide it.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 4: Manual smoke test against a running server**

Start the dev server (`pnpm run dev`), then check each line below in a browser, and state in the report which ones you actually ran:
1. Log in with the PIN. In devtools, confirm the `adminDevice` and `adminToken` cookies exist. Open Settings: the Devices card lists this device marked "This device".
2. Enable push, accept the naming prompt. The row shows the new name and "Push on". Send a test push and confirm it arrives.
3. Restart the server. Reload Settings without re-entering the PIN: the page still works, and `adminToken` was reissued.
4. Set the device to "Critical only". Trigger a warning-level alert (for example `LOW_INK`): no push arrives. Trigger a critical one (for example `PAPER_JAM`): it arrives.
5. Log out and log in again: the old row remains and a new row appears; enabling push moves the subscription to the new row.
6. Revoke a second browser's device from the first: the second browser gets 401 on its next request.

- [ ] **Step 5: Update the knowledge graph**

Run: `graphify update .`
Expected: completes without error. Commit any tracked `graphify-out/` changes only if the repo normally tracks them (check `git status`).

- [ ] **Step 6: Report**

State plainly what was verified (test counts, typecheck, build) and what was not (any smoke steps not run, client UI has no unit tests). Mention the open follow-up: the Express `trust proxy` fix.
