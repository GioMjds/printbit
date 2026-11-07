# Admin Device Identity and Alert Routing: Design

Date: 2026-11-07
Status: Draft for review

## Problem

The admin panel uses one shared PIN. Login creates an anonymous in-memory session (`createAdminSession()` in `src/utils/admin-session.ts`), and push subscriptions (`AdminPushSubscriptionEntry`) carry no owner or label. As a result:

- `broadcastCriticalAlert` sends every alert to every stored endpoint. A device cannot choose what it receives.
- The admin cannot tell which stored subscription belongs to which device.
- Sessions live only in memory with a 24h TTL. A server restart invalidates every session, and subscribe or status calls then fail with 401. This is a likely contributor to the "push works only sometimes" report.
- Any session can unsubscribe or test any endpoint.

## Agreed Understanding

- One admin with several devices (for example "Phone", "Shop laptop"). No roles and no user accounts.
- The PIN remains the single login and the enrolment step. Identity moves to the device.
- Each device controls one setting: a severity filter, either everything or critical only.
- Approach chosen: a persisted device record with a long-lived device token issued after PIN login.

## Success Criteria

1. Each push subscription is linked to a named device.
2. A device set to "critical only" does not receive `warning` alerts. A device set to "everything" receives all alerts.
3. A server restart does not log a known device out.
4. A device can subscribe, test and unsubscribe only its own subscription.
5. Any logged-in device can list, rename, change the severity of, and revoke any device.
6. The existing push delivery behaviour (retry, timeout, pruning, cooldown restore) is unchanged.

## Data Model

New collection `adminDevices` in the db, added to `DEFAULT_DATA` and the normalizer in `src/core/database/db.ts`, next to `adminPushSubscriptions`:

```ts
interface AdminDeviceEntry {
  id: string;
  label: string; // trimmed, max 40 chars
  tokenHash: string; // sha256 of the cookie secret
  minSeverity: 'critical' | 'warning'; // default 'warning' (receives everything)
  createdAt: string;
  lastSeenAt: string;
}
```

`AdminPushSubscriptionEntry` gains a `deviceId: string`. Legacy entries without one are treated as receive-all until their device re-registers.

## Login and Session Flow

Both PIN login paths in `admin.controller.ts` (around lines 938 and 977) do the following after the PIN is accepted:

1. If the request carries a valid `adminDevice` cookie of the form `<id>.<secret>` and the hash of the secret matches the stored `tokenHash` (compared with `timingSafeEqual`), reuse that device and update `lastSeenAt`.
2. Otherwise create a device. The label comes from an optional `deviceLabel` in the request body, or falls back to a name derived from the user agent. Set the `adminDevice` cookie: httpOnly, sameSite strict, 90 days, sliding.
3. Create the normal 24h `adminToken` session and record `deviceId` on it.

`requireAdminPin` (`src/middleware/admin-auth.ts`) gains a fallback. If the session token is missing or unknown but the `adminDevice` cookie is valid, it mints a new session, sets the `adminToken` cookie, sets `req.adminDeviceId` and continues. An invalid or tampered cookie is ignored, and the request gets the usual 401.

Clients that send only the `x-admin-token` header and no cookies keep working as anonymous sessions. They cannot register push, because push requires a device.

Security trade-off: a device cookie bypasses the PIN for up to 90 days of inactivity. A lost device stays logged in until it is revoked from the settings list. This is accepted for a single-admin deployment.

## Push Linkage and Routing

- `subscribe()` takes the device from the request, never from the body, and upserts by endpoint. When a device registers a new endpoint, its previous subscription is replaced, which prevents stale duplicates.
- `broadcastCriticalAlert` applies one check per subscription: `device.minSeverity === 'warning' || alert.severity === 'critical'`. Skipped devices are not failures and are not pruned. The return value becomes `{ sent, pruned, skipped }`.
- The cooldown stays per alert code and global. If nothing was delivered, the cooldown is restored as before.
- Retry, timeout and pruning are unchanged.
- Unsubscribe, test push and status only operate on a subscription whose `deviceId` matches the caller. Another device receives 404. A test push ignores `minSeverity`.

## API

All routes use `requireAdminLocalAccess` and `requireAdminPin`.

- `GET /api/admin/devices`: list with `id`, `label`, `minSeverity`, `lastSeenAt`, `isCurrent`, `hasPush`.
- `PATCH /api/admin/devices/:id`: update `label` and `minSeverity`, validated.
- `DELETE /api/admin/devices/:id`: revoke the device and delete its subscriptions. Revoking the current device clears its cookies.
- `GET /api/admin/push/status` additionally returns `device: { id, label, minSeverity }`.
- Login bodies accept an optional `deviceLabel`.

Push subscribe, test and unsubscribe are strictly own-device. Device list management is open to any logged-in device so that one device can revoke a lost one.

## Settings UI

A "Devices" card under push settings in `src/public/admin/settings/app.ts`: one row per device, the current device marked "This device", an inline label field, a severity select ("Everything" or "Critical only"), last seen time, and a Revoke button with confirmation. The existing 10s refresh also reloads the list. On first enable, a device that still has a generated label is offered a naming prompt. The client bundle is rebuilt with `scripts/build-client.js`.

## Error Handling

- Invalid or tampered device cookie: ignored, normal 401.
- The device list is capped at 20. At the cap, the least recently seen device is evicted together with its subscriptions.
- Labels are trimmed and limited to 40 characters. `minSeverity` is validated against the two allowed values.
- PIN lockout and attempt limits are unchanged.

## Code Layout

- New: `src/services/admin-device.service.ts` (create, verify, touch, rename, revoke, cap).
- Changed: `src/utils/admin-session.ts`, `src/middleware/admin-auth.ts`, `src/modules/admin/admin.controller.ts`, `src/modules/admin/admin.schema.ts`, `src/core/database/db.ts`, `src/services/admin-push.service.ts`, `src/public/admin/shared.ts`, `src/public/admin/settings/app.ts`.

## Testing

Written test-first with jest:

- Device service: create, reuse, bad secret rejected, revoke, cap eviction.
- Auth fallback: an empty session map (simulated restart) with a valid cookie still passes.
- Routing: a `warning` alert skips a critical-only device; a `critical` alert reaches all devices.
- Ownership: another device gets 404 for subscribe, test and unsubscribe.
- The existing `admin-push.service.spec.ts` tests stay green.

## Out of Scope

- Per-alert-code choices, roles, pairing codes.
- Retry on `sendTestNotification`.
- The Express `trust proxy` fix. It is a separate security item: through the tunnel, `adminLocalOnly` can currently be bypassed. It should be fixed right after this work.
