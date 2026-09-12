# Scan Soft-Copy Delivery Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-memory scan download bearer link with a durable, server-authoritative lease that binds the first claiming browser/device and exposes a live expiry countdown.

**Architecture:** Store lease state and hashed delivery/device tokens in SQLite, keeping transient scan files on disk. Move payment authorization and delivery creation into one lease-aware scanner-service flow, expose public claim/state routes outside the kiosk-only API guard, and render the same server-derived expiry on the kiosk success overlay and mobile claim page.

**Tech Stack:** TypeScript 6, Node.js `node:sqlite`, Express 5, SQLite WAL transactions, Jest 30 with ts-jest, esbuild client bundles, vanilla TypeScript DOM UI, existing `qrcode` package.

**Spec:** `docs/superpowers/specs/2026-09-12-scan-soft-copy-delivery-lease-design.md`

## Global Constraints

- Preserve Node engine `>=22.5.0`, strict TypeScript, and the existing `node:sqlite` storage layer; add no dependency.
- The default delivery lease is `15 * 60 * 1000` milliseconds and uses `PRINTBIT_SCAN_DOWNLOAD_TTL_MS` when it is a positive value.
- The first browser/device that explicitly claims a lease may download repeatedly until server expiry; other browser/device cookies must be rejected.
- Store only SHA-256 hashes of delivery tokens and device-claim cookie values; never log raw values.
- Do not bind delivery authorization to IP address, user-agent, referrer, or QR-scanner identity.
- QR codes must target `/scan/access/:token`; direct file download requires a matching device cookie and an unexpired lease.
- Use `/api/scan-delivery/:token` for phone-facing API calls because `/api/scanner/*` is protected by the kiosk middleware in `src/app.module.ts`.
- Expired or revoked leases must remain inaccessible even when physical file deletion is delayed; cleanup failures are retryable and observable.
- Preserve receipt QR behavior, scan format selection, scan page-count messaging, and unrelated print/copy flows.
- Path-specific staging and commits are required so pre-existing worktree/staged changes are not included.

---

### Task 1: Add durable lease and token persistence

**Files:**

- Create: `src/core/database/models/scan-delivery.model.ts`
- Modify: `src/core/database/sqlite-storage.ts:ensureSchema()` and export section
- Test: `tests/database/scan-delivery.model.spec.ts`

**Interfaces:**

- Consumes: `getSqliteDb()` and `withTransaction()` from `src/core/database/sqlite-storage.ts`.
- Produces: `ScanDeliveryLeaseSqliteStore`, `scanDeliveryLeaseStore`, `ScanDeliveryLeaseEntry`, `ScanDeliveryLeaseStatus`, `ScanDeliveryPaymentState`, and the token/claim result types used by Tasks 2–4.

- [ ] **Step 1: Write the failing persistence tests**

Create tests for the durable state transitions. Use a generated `test-${randomUUID()}` idempotency key and delete only rows created by the test in `afterEach`; do not reset the entire SQLite database.

Define the test fixture used by the examples before the cases:

```ts
const pendingInput = (
  id: string,
  idempotencyKey: string,
): CreatePendingLeaseInput => ({
  id,
  idempotencyKey,
  transactionId: `scan-${id}`,
  filename: `${id}.pdf`,
  filePath: `uploads/scans/${id}.pdf`,
  requiredAmount: 10,
  createdAt: '2026-09-12T00:00:00.000Z',
});
```

```ts
it('persists a pending lease and finds it after a fresh store instance', () => {
  const store = new ScanDeliveryLeaseSqliteStore();
  store.createPending({
    id: 'lease-1',
    idempotencyKey: 'test-key-1',
    transactionId: 'scan-tx-1',
    filename: 'scan-1.pdf',
    filePath: 'uploads/scans/scan-1.pdf',
    requiredAmount: 10,
    createdAt: '2026-09-12T00:00:00.000Z',
  });

  expect(
    new ScanDeliveryLeaseSqliteStore().findByIdempotencyKey('test-key-1'),
  ).toMatchObject({
    id: 'lease-1',
    status: 'pending',
    paymentState: 'unsettled',
    filename: 'scan-1.pdf',
  });
});

it('atomically lets only one device claim a lease', () => {
  const store = new ScanDeliveryLeaseSqliteStore();
  store.createPending(pendingInput('lease-2', 'test-key-2'));
  store.activate({
    leaseId: 'lease-2',
    tokenHash: 'token-hash-2',
    paidAt: '2026-09-12T00:00:00.000Z',
    expiresAt: '2026-09-12T00:15:00.000Z',
    chargedAmount: 10,
    settlementJson: '{}',
  });

  expect(
    store.claimByDevice(
      'token-hash-2',
      'device-a',
      new Date('2026-09-12T00:01:00.000Z'),
    ).kind,
  ).toBe('claimed');
  expect(
    store.claimByDevice(
      'token-hash-2',
      'device-b',
      new Date('2026-09-12T00:01:01.000Z'),
    ).kind,
  ).toBe('conflict');
});
```

Also cover same-device repeat claim, expiry denial, download-count increment only after authorized access, token lookup through a child token row, cleanup candidate selection, and an expired lease that remains inaccessible when its file-delete marker is null.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec jest tests/database/scan-delivery.model.spec.ts --runInBand`

Expected: FAIL because the store, table, and lease types do not exist yet.

- [ ] **Step 3: Add the SQLite schema and store implementation**

Add these tables inside `ensureSchema()` using `CREATE TABLE IF NOT EXISTS`, so existing installations migrate on startup without dropping data:

```sql
CREATE TABLE IF NOT EXISTS scan_delivery_leases (
  lease_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  transaction_id TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'claimed', 'expired', 'revoked')),
  payment_state TEXT NOT NULL CHECK (payment_state IN ('unsettled', 'settled')),
  required_amount INTEGER NOT NULL,
  charged_amount INTEGER NOT NULL DEFAULT 0,
  settlement_json TEXT NOT NULL DEFAULT '{}',
  paid_at TEXT,
  expires_at TEXT,
  claimed_at TEXT,
  claimed_device_hash TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at TEXT,
  artifact_deleted_at TEXT,
  cleanup_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_delivery_lease_tokens (
  token_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (lease_id) REFERENCES scan_delivery_leases(lease_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);
```

Add indexes on `(status, expires_at)`, `(filename, status)`, and
`(lease_id, revoked_at)`. Map database rows into strict TypeScript types and
normalize unknown status/payment values to safe defaults rather than exposing
raw database values.

Implement these store methods with `withTransaction()` where an update and
its dependent read must be atomic:

```ts
createPending(input: CreatePendingLeaseInput): ScanDeliveryLeaseEntry;
findByIdempotencyKey(key: string): ScanDeliveryLeaseEntry | null;
findByTransactionId(transactionId: string): ScanDeliveryLeaseEntry | null;
findByTokenHash(tokenHash: string): ScanDeliveryLeaseEntry | null;
findProtectedFilename(filename: string): boolean;
activate(input: ActivateLeaseInput): ScanDeliveryLeaseEntry;
saveSettlement(leaseId: string, input: SettlementSnapshotInput): ScanDeliveryLeaseEntry;
revoke(leaseId: string, updatedAt: string): boolean;
claimByDevice(tokenHash: string, deviceHash: string, now: Date): ScanDeliveryClaimResult;
authorizeDownload(tokenHash: string, deviceHash: string, now: Date): ScanDeliveryLeaseEntry | null;
listCleanupCandidates(now: Date): ScanDeliveryLeaseEntry[];
markExpired(leaseId: string, now: Date): boolean;
markArtifactDeleted(leaseId: string, deletedAt: string): void;
markCleanupError(leaseId: string, message: string, updatedAt: string): void;
```

`claimByDevice()` must perform a conditional update equivalent to
`claimed_device_hash IS NULL OR claimed_device_hash = ?` and return
`claimed`, `owned`, `conflict`, `expired`, or `missing`. `authorizeDownload()`
must conditionally increment `download_count` only when the token hash,
device hash, status, and expiry all authorize the stream. Keep old token rows
valid until their lease is revoked/expired; this lets a QR survive restart
while a charge retry can issue a fresh token row without storing a raw token.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm exec jest tests/database/scan-delivery.model.spec.ts --runInBand`

Expected: PASS for persistence, atomic claim, expiry, token lookup, and cleanup-marker cases.

- [ ] **Step 5: Commit the persistence slice**

```bash
git add -- src/core/database/models/scan-delivery.model.ts src/core/database/sqlite-storage.ts tests/database/scan-delivery.model.spec.ts
git commit --only -m "feat: persist scan delivery leases" -- src/core/database/models/scan-delivery.model.ts src/core/database/sqlite-storage.ts tests/database/scan-delivery.model.spec.ts
```

### Task 2: Replace in-memory scan delivery with lease service behavior

**Files:**

- Modify: `src/services/scan-delivery.ts`
- Create: `tests/services/scan-delivery.spec.ts`

**Interfaces:**

- Consumes: `scanDeliveryLeaseStore` and `deleteTransientScanFile()`.
- Produces: `ScanDeliveryService`, `scanDeliveryService`, `ScanDownloadLink`, `ScanDeliveryAccessState`, `ScanDeliveryClaimResponse`, `SCAN_DEVICE_COOKIE_NAME`, and `startScanDeliveryCleanup()` for scanner/controller modules. Task 7 wires the scheduler into module startup.

- [ ] **Step 1: Write failing service tests**

Test token hashing, access URL construction, server remaining seconds, explicit claim, same-device repeat, different-device conflict, missing file behavior, and cleanup ordering. Use a service constructor that accepts the store and file-deletion function so tests do not touch real scan files.

Define `store`, `sha256`, and `makeService()` in the test fixture. `makeService()` must construct `new ScanDeliveryService({ store, deleteFile })`, where `deleteFile` defaults to a resolved `deleteTransientScanFile` mock and can be overridden per test. `FakeScanDeliveryLeaseStore` implements the public store interface from Task 1; seed `lease-1` as an active lease and `expired-hash` as an expired lease before the examples.

```ts
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
type DeleteScanFile = (filename: string) => Promise<{
  deleted: boolean;
  alreadyMissing: boolean;
  fileName: string;
}>;
const store = new FakeScanDeliveryLeaseStore();
const makeService = (overrides: { deleteFile?: DeleteScanFile } = {}) =>
  new ScanDeliveryService({
    store,
    deleteFile: overrides.deleteFile ?? jest.fn().mockResolvedValue({ deleted: true }),
  });
```

```ts
it('returns a QR access URL and keeps the raw token out of the persisted lease', () => {
  const service = makeService();
  const link = service.activateDelivery({
    leaseId: 'lease-1',
    publicBaseUrl: new URL('http://printbit.local'),
    paidAt: new Date('2026-09-12T00:00:00.000Z'),
    settlement: settlementSnapshot(10),
  });

  expect(link.downloadUrl).toMatch(/^http:\/\/printbit\.local\/scan\/access\//);
  expect(link.remainingSeconds).toBe(900);
  expect(store.findByTokenHash(sha256(link.token))).toBeTruthy();
  expect(store.findByTokenHash(link.token)).toBeNull();
});

it('marks expired before attempting file deletion', async () => {
  const deleteFile = jest.fn().mockResolvedValue({ deleted: true });
  const service = makeService({ deleteFile });
  await service.cleanupExpiredDeliveries(new Date('2026-09-12T00:16:00.000Z'));

  expect(store.findByTokenHash('expired-hash')?.status).toBe('expired');
  expect(deleteFile).toHaveBeenCalledWith('scan-1.pdf');
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec jest tests/services/scan-delivery.spec.ts --runInBand`

Expected: FAIL because the current service only owns an in-memory `Map` and returns direct `/scan/download` bearer links.

- [ ] **Step 3: Implement token, claim, authorization, and cleanup services**

Refactor `src/services/scan-delivery.ts` so it no longer stores active download sessions in a process-local map. Generate delivery tokens and device cookies with `randomBytes(32).toString('base64url')`; hash them with `createHash('sha256').update(value).digest('hex')` before passing them to SQLite.

Use these public shapes:

```ts
export interface ScanDownloadLink {
  token: string;
  downloadUrl: string; // QR access-page URL, never the direct file URL
  expiresAt: string;
  remainingSeconds: number;
}

export type ScanDeliveryAccessState =
  | 'available'
  | 'claimed_by_this_device'
  | 'claimed_by_other_device'
  | 'expired'
  | 'revoked'
  | 'unavailable';

getAccessState(token: string, deviceCookie: string | undefined, now?: Date): ScanDeliveryAccessView;
claim(token: string, existingDeviceCookie: string | undefined, now?: Date): ScanDeliveryClaimResponse;
authorizeDownload(token: string, deviceCookie: string | undefined, now?: Date): AuthorizedScanDownload | null;
createPendingDelivery(input: CreatePendingDeliveryInput): ScanDeliveryLeaseEntry;
activateDelivery(input: ActivateDeliveryInput): ScanDownloadLink;
cleanupExpiredDeliveries(now?: Date): Promise<ScanDeliveryCleanupResult>;
```

`getAccessState()` may expose expiry, remaining seconds, and non-sensitive format metadata, but not filesystem paths or unrelated filename existence. `claim()` generates a cookie only for a successful first claim, returns no cookie for a conflict, and returns the same lease for the owning cookie. All access paths re-check `expiresAt` using `Date.now()`/the supplied `Date`.

Cleanup must first mark eligible active/claimed leases expired, then call `deleteTransientScanFile(filename)`. Mark successful deletion with `artifact_deleted_at`; retain an inaccessible expired row and `cleanup_error` when unlink fails so the next run retries. Emit structured admin logs with lease/transaction IDs only.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm exec jest tests/services/scan-delivery.spec.ts --runInBand`

Expected: PASS for hashed tokens, access-state mapping, same-device reuse, conflict handling, expiry, and retryable cleanup.

- [ ] **Step 5: Commit the service slice**

```bash
git add -- src/services/scan-delivery.ts tests/services/scan-delivery.spec.ts
git commit --only -m "feat: authorize scan delivery leases" -- src/services/scan-delivery.ts tests/services/scan-delivery.spec.ts
```

### Task 3: Make soft-copy charging idempotent and lease-backed

**Files:**

- Modify: `src/modules/scanner/scanner.service.ts:SoftCopyChargeInput`, `SoftCopyChargeResult`, `chargeSoftCopy()`, release-token helpers, and download resolution
- Modify: `src/modules/scanner/scanner.controller.ts:chargeSoftCopy()` request mapping
- Modify: `src/public/confirm/app.ts` scan payment branch around the `POST /api/scanner/soft-copy/charge` call
- Test: `tests/services/scanner-soft-copy-delivery.spec.ts`

**Interfaces:**

- Consumes: Task 1 persistence and Task 2 `ScanDeliveryService` APIs; existing `settlementService`, `financialLedgerService`, and `ReceiptService`.
- Produces: `SoftCopyChargeInput` with `idempotencyKey`, `orientation`, and `rotationDeg`; a `SoftCopyChargeResult` whose `downloadLink.downloadUrl` is the access-page URL; and a charge path that never returns success without an active lease.

- [ ] **Step 1: Write failing scanner-service tests**

Cover these concrete cases. Mock `settlementService.settle`, `financialLedgerService.append`, `ReceiptService`, and the scan-delivery service at their module boundaries; define `fakeIo`, `baseUrl`, `makeScannerServiceWithSameStore()`, and `input()` in the fixture so each case uses the same durable store and a fresh `ScannerService` instance.

Define the test fixture before the cases:

```ts
const fakeIo = { emit: jest.fn() } as unknown as SocketIOServer;
const baseUrl = new URL('http://printbit.local');
const makeScannerServiceWithSameStore = (): ScannerService => new ScannerService();
const input = (idempotencyKey: string): SoftCopyChargeInput => ({
  filename: 'scan-1.pdf',
  io: fakeIo,
  publicBaseUrl: 'http://printbit.local',
  idempotencyKey,
  orientation: 'portrait',
  rotationDeg: 0,
});
const service = makeScannerServiceWithSameStore();
```

```ts
it('creates one lease and does not settle twice for a repeated idempotency key', async () => {
  const first = await service.chargeSoftCopy(input('scan-charge-key'));
  const second = await service.chargeSoftCopy(input('scan-charge-key'));

  expect(settlementService.settle).toHaveBeenCalledTimes(1);
  expect(second.transactionId).toBe(first.transactionId);
  expect(second.downloadLink?.downloadUrl).toContain('/scan/access/');
});

it('resumes a durable settled lease after the process-local idempotency cache is absent', async () => {
  const first = await service.chargeSoftCopy(input('restart-key'));
  const restartedService = makeScannerServiceWithSameStore();
  const retry = await restartedService.chargeSoftCopy(input('restart-key'));

  expect(settlementService.settle).toHaveBeenCalledTimes(1);
  expect(retry.transactionId).toBe(first.transactionId);
});

it('does not create a link from a filename-only call', async () => {
  await expect(
    service.createWirelessLink('scan-1.pdf', baseUrl),
  ).rejects.toMatchObject({ code: 'SCAN_DELIVERY_LEASE_REQUIRED' });
});
```

Also cover insufficient balance, trusted-time failure, transform validation, zero-price scans, successful lease activation, payment-settled-but-response-retried recovery, and release-token protection while a pending/paid lease owns the artifact.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec jest tests/services/scanner-soft-copy-delivery.spec.ts --runInBand`

Expected: FAIL because `chargeSoftCopy()` currently uses a 30-minute in-memory filename marker and swallows link-generation failures.

- [ ] **Step 3: Refactor the charge flow around a durable lease**

Add `idempotencyKey` to the controller/service input and read it from the `Idempotency-Key` header. The confirm page must always send the existing persisted `paymentIdempotencyKey`; if an older client omits the header, generate a request-local key and do not claim restart-safe retry semantics for that request.

Use the durable lease's unique idempotency key and transaction ID as the stable payment identity. The sequence in `chargeSoftCopy()` must be:

```text
validate safe filename and source file
find or create pending lease by idempotencyKey
if lease is active/claimed: issue a fresh token row and replay its stored settlement snapshot
if lease is pending with paymentState=settled: activate delivery without settling again
apply requested rotation/orientation before settlement
assert trusted time
append job_started using transactionId as the stable reference
settle with jobContext.transactionId
on insufficient balance: keep the unpaid lease retryable and return the existing 402 payload
persist settlement snapshot and paid_at
activate lease, create hashed token row, and revoke the pre-payment release token
append job_completed and generate the existing receipt snapshot/token
return a lease-backed download link with expiresAt and remainingSeconds
```

Remove `CHARGED_SCAN_TTL_MS`, `chargedScanFiles`, `markSoftCopyPaid()`, and the old paid-filename authorization path. Pass `orientation` and `rotationDeg` in `SoftCopyChargeInput` so the charge endpoint applies the selected output transform before lease activation; the confirm page must not need a filename-only fallback.

Replace `createWirelessLink()` with either a private lease-only helper or remove it after all callers are migrated. If retained for internal use, it must accept a lease ID/token context and reject a filename-only invocation with `SCAN_DELIVERY_LEASE_REQUIRED`.

Update `releaseScanFileByToken()` to consult the durable lease before unlinking. A pending unpaid lease may be revoked and released; an active/claimed or payment-settled lease must block release and rely on lease cleanup. Activation must invalidate all in-memory release tokens for that filename so a late kiosk timeout cannot delete the paid artifact.

- [ ] **Step 4: Add the confirm request contract and remove the link fallback**

In `src/public/confirm/app.ts`, initialize `paymentIdempotencyKey` before the scan request, call `syncPendingPaymentSessionState()`, and send:

```ts
headers: {
  'Content-Type': 'application/json',
  'Idempotency-Key': paymentIdempotencyKey,
},
body: JSON.stringify({
  filename: config.scanFilename,
  orientation: config.orientation,
  rotationDeg: config.rotationDeg,
}),
```

Capture the returned `downloadLink` and fail the UI flow if the successful response has no lease-backed link. Delete the `/api/scanner/wireless-link` fallback request entirely. Keep receipt capture and the existing final success path after a valid lease response.

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `pnpm exec jest tests/services/scanner-soft-copy-delivery.spec.ts --runInBand`

Expected: PASS with exactly one settlement for repeated keys and no filename-only link creation.

- [ ] **Step 6: Commit the payment integration slice**

```bash
git add -- src/modules/scanner/scanner.service.ts src/modules/scanner/scanner.controller.ts src/public/confirm/app.ts tests/services/scanner-soft-copy-delivery.spec.ts
git commit --only -m "feat: tie scan soft-copy payment to delivery leases" -- src/modules/scanner/scanner.service.ts src/modules/scanner/scanner.controller.ts src/public/confirm/app.ts tests/services/scanner-soft-copy-delivery.spec.ts
```

### Task 4: Expose public claim/state/download routes safely

**Files:**

- Modify: `src/modules/scanner/scanner.controller.ts:initializeRoutes()`, delivery handlers, and download handler
- Test: `tests/controllers/scan-delivery.controller.spec.ts`

**Interfaces:**

- Consumes: Task 2 `getAccessState()`, `claim()`, and `authorizeDownload()`.
- Produces: public `GET /api/scan-delivery/:token`, public `POST /api/scan-delivery/:token/claim`, and cookie-protected `GET /scan/download/:token`.

- [ ] **Step 1: Write failing controller tests**

Use an Express router test harness with a fake `ScannerService`/delivery service and Node 22's built-in `fetch` against an ephemeral `http.createServer`; do not add `supertest`. Define `app`, `server`, and `baseUrl` in `beforeAll`, call `server.listen(0, '127.0.0.1')`, derive `baseUrl` from `server.address()`, and close the server in `afterAll`.

```ts
const responseFor = async (
  path: string,
  init?: RequestInit,
): Promise<Response> =>
  fetch(`${baseUrl}${path}`, { ...init, redirect: 'manual' });

it('sets a device cookie only after an explicit successful claim', async () => {
  const access = await responseFor('/api/scan-delivery/token-a');
  expect(access.status).toBe(200);
  expect((await access.json()).status).toBe('available');
  expect(access.headers.get('set-cookie')).toBeNull();

  const claim = await responseFor('/api/scan-delivery/token-a/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(claim.status).toBe(200);
  expect(claim.headers.get('set-cookie')).toMatch(/printbit_scan_device=/);
});

it('rejects a different device and never streams the file', async () => {
  const response = await responseFor('/scan/download/token-a', {
    headers: { Cookie: 'printbit_scan_device=other-device' },
  });

  expect(response.status).toBe(409);
  expect(await response.text()).toContain('another device');
});
```

Also cover expired (410), revoked (410), unavailable file (410 with `Scan delivery is no longer available.`), missing cookie (403), no-store headers, rate limits, and a valid same-device download with the existing customer filename/content-type behavior.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec jest tests/controllers/scan-delivery.controller.spec.ts --runInBand`

Expected: FAIL because the public claim/state routes and device-cookie authorization do not exist.

- [ ] **Step 3: Register and implement the public delivery handlers**

Add rate limits with separate prefixes for state/claim and download. Register:

```ts
this.router.get(
  '/api/scan-delivery/:token',
  scanDeliveryStateRateLimit,
  this.getDeliveryState,
);
this.router.post(
  '/api/scan-delivery/:token/claim',
  scanDeliveryClaimRateLimit,
  this.claimDelivery,
);
this.router.get(
  '/scan/download/:token',
  scanDownloadRateLimit,
  this.downloadByToken,
);
```

Read the device cookie through `req.cookies?.[SCAN_DEVICE_COOKIE_NAME]`. Set the cookie only when the service returns a successful first claim, with `httpOnly: true`, a lease-aligned `maxAge`, a narrow delivery path, `sameSite: 'lax'` or stricter same-origin behavior, and `secure: true` only for HTTPS deployment. Set `Cache-Control: no-store` on state, claim, and download responses.

`downloadByToken()` must pass both the URL token and device cookie to `authorizeDownload()`. On failure, return stable responses for missing cookie, ownership conflict, expiry, revocation, and missing file; never call `res.sendFile()` unless authorization returned a validated file path. Add `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` to the stream response.

Remove the public `POST /api/scanner/wireless-link` registration and handler after Task 3 has removed its caller. Keep scan preview and USB routes unchanged.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm exec jest tests/controllers/scan-delivery.controller.spec.ts --runInBand`

Expected: PASS for explicit claim, cookie ownership, error statuses, secure headers, and authorized file streaming.

- [ ] **Step 5: Commit the public-route slice**

```bash
git add -- src/modules/scanner/scanner.controller.ts tests/controllers/scan-delivery.controller.spec.ts
git commit --only -m "feat: protect scan downloads by device claim" -- src/modules/scanner/scanner.controller.ts tests/controllers/scan-delivery.controller.spec.ts
```

### Task 5: Add the mobile access page and static route

**Files:**

- Create: `src/public/scan-delivery/index.html`
- Create: `src/public/scan-delivery/app.ts`
- Create: `src/public/scan-delivery/styles.css`
- Modify: `src/config/http.config.ts:PUBLIC_PAGE_ROUTES`
- Modify: `src/modules/page/page.controller.ts:PageRoute` response headers
- Modify: `scripts/build-client.js:entryPoints`
- Test: `tests/public/scan-delivery-page.spec.ts`

**Interfaces:**

- Consumes: `GET /api/scan-delivery/:token` and `POST /api/scan-delivery/:token/claim`.
- Produces: a public `/scan/access/:token` page with an explicit claim action, mobile download action, and clear ownership/error states. Task 6 adds the shared live countdown.

- [ ] **Step 1: Write failing page-contract tests**

Read `src/public/scan-delivery/index.html` with `fs.readFileSync()` into `accessPageHtml` and import `PUBLIC_DIR`, `PUBLIC_PAGE_ROUTES`, and `KIOSK_ONLY_PAGE_ROUTES` for the route assertion. Assert that the static route is not in `KIOSK_ONLY_PAGE_ROUTES` and that the page references `/scan-delivery/app.js` and `/scan-delivery/styles.css`:

```ts
it('does not require kiosk access for QR recipients', () => {
  expect(PUBLIC_PAGE_ROUTES).toContainEqual({
    route: '/scan/access/:token',
    filePath: path.join(PUBLIC_DIR, 'scan-delivery', 'index.html'),
    noStore: true,
  });
});

it('renders an explicit claim button before any claim request', () => {
  expect(accessPageHtml).toContain('id="claimDeliveryBtn"');
  expect(accessPageHtml).toContain('id="deliveryCountdown"');
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec jest tests/public/scan-delivery-page.spec.ts --runInBand`

Expected: FAIL because the route, page files, and client bundle entry do not exist.

- [ ] **Step 3: Implement the public page and route configuration**

Add `{ route: '/scan/access/:token', filePath: path.join(PUBLIC_DIR, 'scan-delivery', 'index.html'), noStore: true }` to `PUBLIC_PAGE_ROUTES`. Extend `PageRoute` with `noStore?: boolean` and set `Cache-Control: no-store` before serving flagged pages. Do not add the route to `KIOSK_ONLY_PAGE_ROUTES`.

The HTML must include a loading region, an available/claim region, a claimed/download region, an ownership-conflict region, and an expired/unavailable region. Use a real `<button>` for claiming, a real `<a download>` for downloading, `aria-live="polite"` for status/countdown text, and a visible explanation that the QR is limited to the first claimed device.

In `app.ts`, parse and URI-decode the last pathname segment, fetch the public state with `credentials: 'same-origin'`, render the state, and never claim from page load. On the button click, POST an empty JSON body, then render the returned owned state and download URL. Use `Cache-Control`-compatible fetch behavior (`cache: 'no-store'`) and stop the timer for terminal states.

Add the page entry to `scripts/build-client.js`:

```js
{ in: 'src/public/scan-delivery/app.ts', out: 'src/public/scan-delivery/app.js' },
```

Style the page for a phone connected to the PrintBit hotspot, with a constrained card, high-contrast status colors, large touch targets, and no kiosk-only idle overlay.

- [ ] **Step 4: Run the focused tests and client build**

Run: `pnpm exec jest tests/public/scan-delivery-page.spec.ts --runInBand`

Expected: PASS for route/page contracts.

Run: `pnpm run build`

Expected: PASS and creation of `src/public/scan-delivery/app.js`; do not stage generated bundles unless they are tracked by the repository's existing build policy.

- [ ] **Step 5: Commit the mobile-page slice**

```bash
git add -- src/public/scan-delivery/index.html src/public/scan-delivery/app.ts src/public/scan-delivery/styles.css src/config/http.config.ts src/modules/page/page.controller.ts scripts/build-client.js tests/public/scan-delivery-page.spec.ts
git commit --only -m "feat: add scan delivery claim page" -- src/public/scan-delivery/index.html src/public/scan-delivery/app.ts src/public/scan-delivery/styles.css src/config/http.config.ts src/modules/page/page.controller.ts scripts/build-client.js tests/public/scan-delivery-page.spec.ts
```

### Task 6: Share and render the live lease countdown

**Files:**

- Create: `src/public/shared/delivery-countdown.ts`
- Modify: `src/public/confirm/index.html` scan QR card
- Modify: `src/public/confirm/app.ts:renderScanDownloadCta()`, scan-link capture, success reset/cleanup
- Modify: `src/public/confirm/styles.css`
- Modify: `src/public/scan-delivery/app.ts`
- Test: `tests/public/delivery-countdown.spec.ts`

**Interfaces:**

- Consumes: server `expiresAt` and `remainingSeconds` values from Task 3/4.
- Produces: pure countdown helpers used by both browser surfaces.

- [ ] **Step 1: Write failing countdown tests**

```ts
import {
  formatDeliveryCountdown,
  getRemainingDeliverySeconds,
} from '@/public/shared/delivery-countdown';

it('formats lease seconds as mm:ss', () => {
  expect(formatDeliveryCountdown(899)).toBe('14:59');
  expect(formatDeliveryCountdown(-1)).toBe('0:00');
});

it('decreases from the server baseline using elapsed wall time', () => {
  expect(getRemainingDeliverySeconds(900, 1_000, 61_000)).toBe(840);
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec jest tests/public/delivery-countdown.spec.ts --runInBand`

Expected: FAIL because the shared helper does not exist.

- [ ] **Step 3: Implement the pure helper and kiosk countdown**

Implement:

```ts
export function formatDeliveryCountdown(seconds: number): string;
export function getRemainingDeliverySeconds(
  baselineSeconds: number,
  syncedAtMs: number,
  nowMs?: number,
): number;
```

Clamp to zero and floor elapsed seconds. In `confirm/app.ts`, store `currentScanDownloadRemainingSeconds`, `currentScanDownloadSyncedAtMs`, and a `scanDownloadCountdownHandle`. Start one interval when a lease link is captured, update `scanDownloadQrExpiry` as `Download available for ${formatDeliveryCountdown(remaining)}`, add a warning class and “Finish downloading soon” message at `<= 60`, and at zero clear/disable the canvas and announce `Soft-copy download expired.` Stop and reset the interval when the success overlay is dismissed, a new job starts, or the flow errors.

Add a visually hidden or adjacent live-region element in `confirm/index.html` with an explicit label such as `Soft-copy download availability`. Keep the receipt QR independent. Update styles for warning/expired states without changing print/copy success layout.

- [ ] **Step 4: Wire the same countdown into the mobile page**

Use `remainingSeconds` as the initial baseline and `expiresAt` as a resynchronization authority. The mobile UI must display `Available for 14:59` before claim and `Download available for 14:59` after claim, warn in the final minute, and replace the download action with an expired state at zero. Refresh state after claim and after a rejected/expired download response; never treat the client timer as authorization.

- [ ] **Step 5: Run countdown tests and build**

Run: `pnpm exec jest tests/public/delivery-countdown.spec.ts --runInBand`

Expected: PASS for formatting, elapsed-time math, clamping, and zero behavior.

Run: `pnpm run build`

Expected: PASS with both confirm and scan-delivery bundles compiling.

- [ ] **Step 6: Commit the countdown slice**

```bash
git add -- src/public/shared/delivery-countdown.ts src/public/confirm/index.html src/public/confirm/app.ts src/public/confirm/styles.css src/public/scan-delivery/app.ts tests/public/delivery-countdown.spec.ts
git commit --only -m "feat: show scan delivery lease countdown" -- src/public/shared/delivery-countdown.ts src/public/confirm/index.html src/public/confirm/app.ts src/public/confirm/styles.css src/public/scan-delivery/app.ts tests/public/delivery-countdown.spec.ts
```

### Task 7: Start cleanup, protect artifacts, and add operational telemetry

**Files:**

- Modify: `src/modules/scanner/scanner.module.ts`
- Modify: `src/services/scan-delivery.ts` to expose the scheduler started by this task
- Modify: `src/services/scan-storage.ts` to skip filenames protected by active/claimed/settled pending leases
- Test: `tests/services/scan-delivery-cleanup.spec.ts`

**Interfaces:**

- Consumes: Task 1 `findProtectedFilename()` and Task 2 `startScanDeliveryCleanup()`/`cleanupExpiredDeliveries()`.
- Produces: startup cleanup, two-minute retry cleanup, and retention cleanup that cannot delete an active delivery artifact.

- [ ] **Step 1: Write failing lifecycle and retention tests**

Define `cleanupExpiredDeliveries`, `protectedNames`, and `unlink` as spies in the fixture: mock `scanDeliveryService.cleanupExpiredDeliveries`, make `scanDeliveryLeaseStore.findProtectedFilename` return `protectedNames.has(filename)`, and spy on `fs.promises.unlink`. The scheduler test must restore fake timers after each case so the module-level timer does not leak across Jest files.

```ts
it('runs startup cleanup once and schedules unref interval cleanup', () => {
  const timer = jest.spyOn(global, 'setInterval');
  startScanDeliveryCleanup();
  startScanDeliveryCleanup();

  expect(cleanupExpiredDeliveries).toHaveBeenCalledTimes(1);
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 2 * 60 * 1000);
});

it('does not delete an active lease file through age retention', async () => {
  protectedNames.add('active-scan.pdf');
  await scanStorageService.cleanup();

  expect(unlink).not.toHaveBeenCalledWith(
    expect.stringContaining('active-scan.pdf'),
  );
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec jest tests/services/scan-delivery-cleanup.spec.ts --runInBand`

Expected: FAIL because cleanup is currently only an in-memory download-map purge and generic file-age cleanup does not know about leases.

- [ ] **Step 3: Implement startup/interval cleanup and protection**

Start the scheduler from `registerScannerModule()` after constructing the shared scanner/delivery services, with an idempotent module-level timer and `timer.unref?.()`. Run one startup cleanup cycle before scheduling the interval. Log startup/interval counts and failures under stable admin-log event names without tokens.

Update `ScanStorageService.cleanup()` to call the lease protection query before unlinking an old file. Skip a filename with an active/claimed lease or a paid pending lease. Expired lease cleanup remains responsible for deletion and marks its database row before retrying unlink. Do not allow generic retention to recreate access or change an expired lease back to active.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm exec jest tests/services/scan-delivery-cleanup.spec.ts --runInBand`

Expected: PASS for idempotent scheduler startup, retry behavior, and active-file protection.

- [ ] **Step 5: Commit the cleanup slice**

```bash
git add -- src/modules/scanner/scanner.module.ts src/services/scan-delivery.ts src/services/scan-storage.ts src/server.ts tests/services/scan-delivery-cleanup.spec.ts
git commit --only -m "feat: clean up expired scan deliveries safely" -- src/modules/scanner/scanner.module.ts src/services/scan-delivery.ts src/services/scan-storage.ts src/server.ts tests/services/scan-delivery-cleanup.spec.ts
```

### Task 8: Run the complete regression and security verification

**Files:**

- Modify: only files required to correct failures found by the checks
- Test: all existing tests plus the new scan-delivery tests

**Interfaces:**

- Consumes: all completed lease, payment, route, UI, and cleanup slices.
- Produces: verified end-to-end behavior and a clean implementation handoff.

- [ ] **Step 1: Run focused lease and scanner tests together**

Run: `pnpm exec jest tests/database/scan-delivery.model.spec.ts tests/services/scan-delivery.spec.ts tests/services/scanner-soft-copy-delivery.spec.ts tests/controllers/scan-delivery.controller.spec.ts tests/services/scan-delivery-cleanup.spec.ts tests/public/delivery-countdown.spec.ts --runInBand`

Expected: PASS with no second settlement for duplicate idempotency keys, exactly one winning device claim, and no raw token assertions in logs.

- [ ] **Step 2: Run the full test suite and lint**

Run: `pnpm test -- --runInBand`

Expected: PASS for existing print/copy/receipt behavior and all new delivery tests.

Run: `pnpm run lint`

Expected: PASS with no new TypeScript or ESLint errors.

- [ ] **Step 3: Build the production bundles**

Run: `pnpm run build`

Expected: PASS for the server bundle, confirm bundle, scan-delivery bundle, and existing public assets.

- [ ] **Step 4: Exercise the HTTP flow in a real browser**

Use the browser-testing skill against a running local server and verify:

```text
scan -> confirm -> pay -> kiosk success QR targets /scan/access/:token
phone A opens the access page -> claim button -> device cookie -> download
phone A downloads a second time before expiry
phone B opens the same QR -> ownership conflict and no download
countdown reaches final-minute warning and zero-expiry state
expired link returns 410 and cleanup removes the transient file
server restart preserves a still-active QR lease
```

Expected: the QR page is reachable without kiosk credentials, `/api/scanner/*` remains kiosk-protected, and the direct download route never streams without the matching cookie.

- [ ] **Step 5: Run graph maintenance after code changes**

Run: `graphify update .`

Expected: `graphify-out/` reflects the new lease model, service, controller, and public-page relationships.

- [ ] **Step 6: Review the final diff and commit any verification fixes separately**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; unrelated pre-existing changes remain identifiable and are not included. If verification required a correction, commit only the corrected files with a focused message such as `fix: close scan delivery lease edge case`.

## Spec coverage checklist

- Durable SQLite lease and restart recovery: Tasks 1–3.
- Hashed opaque delivery/device tokens: Tasks 1–2.
- First explicit claim, same-device repeat, different-device rejection, and concurrent race: Tasks 1, 2, and 4.
- Public access-page route outside kiosk middleware: Task 5.
- Server-authoritative kiosk/mobile countdown and expiry state: Task 6.
- Filename-only link removal/protection: Task 3 and Task 4.
- Release-token supersession and file cleanup retry: Tasks 3 and 7.
- No-store/security headers and rate limits: Task 4.
- Payment idempotency and settled-but-response-lost recovery: Task 3.
- Receipt/non-scan regression coverage: Task 8.
- Observability and startup/periodic cleanup: Task 2 and Task 7.
