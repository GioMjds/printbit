# Confirm-Only Coin Acceptor Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the physical coin acceptor disabled outside `/confirm`, enable it only through a server-validated confirmation lease, and leave the `/scc` local coin simulator independent.

**Architecture:** Add a server-owned `PaymentAcceptorGate` with a short-lived capability issued only by the `/confirm` page handler and a heartbeat-backed lease. Extend the hardware projection with a dedicated customer-payment lock owner; power safety remains a separate lock. Remove client-controlled Socket.IO unlocking, add payment-session HTTP endpoints, and have the confirm page use those endpoints for arm/heartbeat/disarm lifecycle operations.

**Tech Stack:** TypeScript, Express 5, Socket.IO 4, Jest 30 with ts-jest, existing Windows named-pipe worker command protocol, existing `SessionStore`, printer projection, and hardware projection.

**Spec:** [docs/superpowers/specs/2026-09-12-confirm-payment-acceptor-gate-design.md](../specs/2026-09-12-confirm-payment-acceptor-gate-design.md)

## Global Constraints

- Keep the physical coin acceptor disabled unless an active payment session is explicitly armed from `/confirm`.
- Make the Node.js backend the authority for arming, lease expiry, and disarming the physical acceptor.
- Preserve the existing power-safety lock as an independent fail-safe lock.
- Leave the local `/scc` test-coin endpoint and `CoinSimulation` behavior unchanged, apart from retaining its existing power-safety protection.
- This slice does not replace the existing `/api/confirm-payment` finalization flow with a persistent `CONFIGURED → AWAITING_PAYMENT → PAID` transaction database model.
- This slice does not redesign ESP32 denomination detection, hopper behavior, or C# printing.
- Production code is written only after a focused failing test has been observed.

## File Map

Create:

- `src/services/payment-acceptor-gate.ts` — confirmation capability storage, one active payment lease, heartbeat expiry, validation callbacks, and hardware arm/disarm orchestration.
- `src/modules/payment/payment-session.service.ts` — HTTP input/session validation and translation to gate operations.
- `src/modules/payment/payment-session.controller.ts` — `/api/payment-session/{arm,heartbeat,cancel}` routes.
- `src/modules/payment/payment-session.module.ts` and `src/modules/payment/index.ts` — module registration and exports.
- `tests/services/payment-acceptor-gate.spec.ts` — pure lease/capability/safety behavior.
- `tests/services/hardware-state-projection.spec.ts` — dedicated customer lock ownership and worker command acknowledgement behavior.
- `tests/modules/payment/payment-session.service.spec.ts` — HTTP-facing payment-session validation and `/scc` isolation checks.

Modify:

- `src/services/hardware-state-projection.ts` — introduce the default customer-payment lock and acknowledged customer arm/disarm methods.
- `src/modules/page/page.controller.ts`, `src/modules/page/page.module.ts`, `src/modules/page/index.ts` — issue the capability cookie when serving `/confirm`.
- `src/app.module.ts` — protect and register the payment-session endpoints and pass the gate to page/financial modules.
- `src/modules/financial/financial.module.ts`, `src/modules/financial/financial.service.ts` — inject the gate and disarm the active lease before final payment processing.
- `src/server.ts` — initialize the customer lock, remove generic client unlock authority, disarm on printer faults/shutdown, and wire the gate dependencies.
- `src/public/confirm/app.ts` — replace Socket.IO lock/unlock calls with arm, heartbeat, and disarm requests.

## Interfaces shared between tasks

The following names and shapes are fixed before implementation so later tasks do not invent incompatible variants:

```ts
export const CONFIRM_CAPABILITY_COOKIE = 'printbit_confirm_capability';
export const CUSTOMER_PAYMENT_LOCK_OWNER = 'customer-payment';

export interface PaymentArmInput {
  capability: string;
  mode: 'print' | 'copy';
  amount: number;
  sessionId: string | null;
}

export interface PaymentLease {
  leaseId: string;
  capability: string;
  mode: 'print' | 'copy';
  amount: number;
  sessionId: string | null;
  expiresAt: number;
}

export interface PaymentAcceptorHardware {
  armCustomerPayment: () => Promise<boolean>;
  disarmCustomerPayment: (reason: string) => Promise<boolean>;
}

export interface PaymentAcceptorGateChecks {
  canAcceptCustomerWork: () => boolean;
  isPrinterReady: () => boolean;
  isSerialConnected: () => boolean;
  getBalance: () => number;
}
```

The gate exposes `issueConfirmCapability()`, `arm(input)`,
`heartbeat(capability, leaseId)`, `disarm(leaseId, reason)`,
`disarmForSafety(reason)`, and `shutdown()`. `arm()` returns a lease only after
all checks pass and the hardware arm command acknowledges success.

### Task 1: Add an acknowledged customer-payment hardware lock

**Files:**

- Modify: `src/services/hardware-state-projection.ts`
- Test: `tests/services/hardware-state-projection.spec.ts`

**Interfaces:**

- Consumes: existing `sendWorkerCommand()` and the existing `coinSlotLocks` map.
- Produces: `CUSTOMER_PAYMENT_LOCK_OWNER`, `initializeCustomerPaymentLock(): Promise<boolean>`, `armCustomerPayment(): Promise<boolean>`, and `disarmCustomerPayment(reason: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('customer payment coin-slot lock', () => {
  it('starts locked by the customer-payment owner', () => {
    const projection = new HardwareStateProjection({
      sendWorkerCommand: successfulCommand,
    });

    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      true,
    );
    expect(projection.isCoinSlotLocked()).toBe(true);
  });

  it('removes only the customer-payment lock after an acknowledged arm', async () => {
    const commands: Record<string, unknown>[] = [];
    const projection = new HardwareStateProjection({
      sendWorkerCommand: async (command) => {
        commands.push(command);
        return { success: true };
      },
    });
    projection.lockCoinSlot('power-safety');

    expect(await projection.armCustomerPayment()).toBe(true);

    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      false,
    );
    expect(projection.isCoinSlotLockedBy('power-safety')).toBe(true);
    expect(commands.at(-1)).toMatchObject({
      type: 'UnlockCoinSlot',
      ownerId: CUSTOMER_PAYMENT_LOCK_OWNER,
    });
  });

  it('retains the lock when the worker does not acknowledge arm', async () => {
    const projection = new HardwareStateProjection({
      sendWorkerCommand: async () => null,
    });

    expect(await projection.armCustomerPayment()).toBe(false);
    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      true,
    );
  });

  it('locks before returning from customer disarm', async () => {
    const projection = new HardwareStateProjection({
      sendWorkerCommand: successfulCommand,
    });
    await projection.armCustomerPayment();

    expect(await projection.disarmCustomerPayment('page_exit')).toBe(true);
    expect(projection.isCoinSlotLockedBy(CUSTOMER_PAYMENT_LOCK_OWNER)).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `pnpm test -- --runInBand tests/services/hardware-state-projection.spec.ts`

Expected: FAIL because `HardwareStateProjection` does not yet accept an injectable command sender and does not expose the customer-payment methods.

- [ ] **Step 3: Implement the minimal hardware boundary**

Add an optional constructor dependency:

```ts
interface HardwareStateProjectionDeps {
  sendWorkerCommand?: (
    command: Record<string, unknown>,
  ) => Promise<WorkerHardwareResponse | null>;
  now?: () => string;
}
```

Initialize `coinSlotLocks` with `CUSTOMER_PAYMENT_LOCK_OWNER`. Route the three
new customer methods through the injected sender, mutate the customer lock
only after an acknowledged arm, and set the lock before sending a disarm
command. Keep existing power-safety `lockCoinSlot()` and
`unlockOwnedCoinSlot()` behavior intact. Use `reason` in the worker payload
for auditability and return `false` for a missing/failed worker acknowledgement.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm test -- --runInBand tests/services/hardware-state-projection.spec.ts`

Expected: PASS with no changes to `CoinSimulation` or `/scc` code.

- [ ] **Step 5: Commit the isolated hardware change**

```bash
git add -- src/services/hardware-state-projection.ts tests/services/hardware-state-projection.spec.ts
git commit -m "feat: add customer payment coin-slot lock"
```

### Task 2: Build the server-owned capability and lease gate

**Files:**

- Create: `src/services/payment-acceptor-gate.ts`
- Test: `tests/services/payment-acceptor-gate.spec.ts`

**Interfaces:**

- Consumes: Task 1 `PaymentAcceptorHardware` and `PaymentAcceptorGateChecks`.
- Produces: the gate methods listed in the shared interface section and the
  `PaymentLease` response used by the HTTP service and confirm page.

- [ ] **Step 1: Write failing lease tests**

Cover these exact behaviors:

```ts
it('rejects arm without a capability');
it('rejects arm while power, printer, serial, or balance checks fail');
it('rejects zero and non-finite amounts');
it('arms exactly once for a valid capability and returns a lease id');
it('returns the same lease for an idempotent repeated arm');
it('rejects a second active lease from a different capability');
it('refreshes expiry only for the matching heartbeat');
it('disarms when the heartbeat lease expires');
it('does not revive an expired lease with a late heartbeat');
it('disarms an active lease on explicit cancel and shutdown');
```

Use an injected `now(): number`, `leaseDurationMs: 15_000`, and Jest fake
timers. Assert both the returned state and the hardware sender calls; do not
assert only that a mock was invoked.

- [ ] **Step 2: Run the focused test and verify it fails for missing behavior**

Run: `pnpm test -- --runInBand tests/services/payment-acceptor-gate.spec.ts`

Expected: FAIL because the gate file and lease methods do not exist.

- [ ] **Step 3: Implement capability issuance and lease state**

Use `randomUUID()` for capabilities and lease IDs. Store only short-lived
capabilities in memory. `issueConfirmCapability()` must expire the token after
five minutes; successful heartbeat refreshes the token while the lease is
active. `arm()` must execute checks in this order: capability, amount, power,
printer, serial, current balance, active-lease conflict, then hardware arm.
If hardware arm returns `false`, keep the lease absent and return a retryable
failure. A timer must call `disarmForSafety('heartbeat_timeout')` at lease
expiry. `disarm()` is idempotent for an already inactive lease and must never
call hardware arm.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm test -- --runInBand tests/services/payment-acceptor-gate.spec.ts`

Expected: PASS, including expiry and shutdown disarm behavior.

- [ ] **Step 5: Commit the gate**

```bash
git add -- src/services/payment-acceptor-gate.ts tests/services/payment-acceptor-gate.spec.ts
git commit -m "feat: add server-owned payment acceptor lease"
```

### Task 3: Issue the capability only from `/confirm` and expose payment-session APIs

**Files:**

- Create: `src/modules/payment/payment-session.service.ts`
- Create: `src/modules/payment/payment-session.controller.ts`
- Create: `src/modules/payment/payment-session.module.ts`
- Create: `src/modules/payment/index.ts`
- Modify: `src/modules/page/page.controller.ts`
- Modify: `src/modules/page/page.module.ts`
- Modify: `src/modules/page/index.ts`
- Modify: `src/app.module.ts`
- Test: `tests/modules/payment/payment-session.service.spec.ts`

**Interfaces:**

- Consumes: `PaymentAcceptorGate`, `SessionStore`, and the capability cookie
  name from Task 2.
- Produces: `POST /api/payment-session/arm`,
  `POST /api/payment-session/heartbeat`, and
  `POST /api/payment-session/cancel`; `/confirm` sets the HttpOnly capability
  cookie.

- [ ] **Step 1: Write failing service and route tests**

Test that the service returns 401 with no capability cookie, 400 for an
invalid mode/amount, 410 or 404 for an expired/missing print session, 503 when
the gate rejects hardware, and the lease payload for a valid request. Test
heartbeat/cancel forwarding with the returned `leaseId`. Test the `/confirm`
route handler calls `res.cookie(CONFIRM_CAPABILITY_COOKIE, token, options)`
with `httpOnly: true`, `sameSite: 'strict'`, `path: '/'`, and a finite `maxAge`.

Test the local console boundary with a real `CoinSimulation` instance and a
fake `SimulateCoin` sender: the service must never call or inspect the
customer-payment gate for `/api/balance/add-test-coin`.

- [ ] **Step 2: Run the focused tests and verify the expected failures**

Run: `pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts`

Expected: FAIL because the payment module, capability cookie, and routes do
not exist.

- [ ] **Step 3: Implement the payment-session service and controller**

For arm input, accept only `{ mode: 'print' | 'copy', amount, sessionId }`.
Require a finite positive amount. For print mode, require a non-empty session
ID whose `SessionStore.getSessionState()` is not `missing` or `expired`, then
call `tryGetSession()` with `resolvePublicBaseUrl(req)` before invoking the
gate. Read the capability only from
`req.cookies?.[CONFIRM_CAPABILITY_COOKIE]`; do not trust a route name,
`Referer`, or a client-supplied capability body field.

Return `{ ok: true, status: 'AWAITING_PAYMENT', leaseId, amount, expiresAt }`
on arm, `{ ok: true, status: 'AWAITING_PAYMENT', expiresAt }` on heartbeat,
and `{ ok: true, status: 'DISARMED' }` on cancel. Use 401/400/404/410/409/503
consistently for the validation failures above. Register the router at root
paths so the final URLs are exactly the three `/api/payment-session/*` paths.

In `PageController`, special-case the configured `/confirm` route so it calls
`paymentAcceptorGate.issueConfirmCapability()` and sets the cookie before
`res.sendFile(page.filePath)`. Leave every other page route unchanged.

- [ ] **Step 4: Register and test the module**

Pass the same gate instance to `registerPageModule()` and
`registerPaymentModule()`. Add `/api/payment-session` to the existing kiosk
write-protection list. Run:

```bash
pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts
```

Expected: PASS, including the unchanged `/scc` simulation path.

- [ ] **Step 5: Commit the HTTP boundary**

```bash
git add -- src/modules/payment src/modules/page/page.controller.ts src/modules/page/page.module.ts src/modules/page/index.ts src/app.module.ts tests/modules/payment/payment-session.service.spec.ts
git commit -m "feat: add confirm-only payment session endpoints"
```

### Task 4: Wire startup, worker safety events, and remove generic client unlock authority

**Files:**

- Modify: `src/server.ts`
- Modify: `src/app.module.ts`
- Modify: `src/modules/financial/financial.module.ts`
- Modify: `src/modules/financial/financial.service.ts`
- Test: extend `tests/modules/payment/payment-session.service.spec.ts` with finalization disarm coverage.

**Interfaces:**

- Consumes: Task 1 hardware methods and Task 2 gate methods.
- Produces: one configured `paymentAcceptorGate` singleton shared by routes,
  page capability issuance, worker event handling, and shutdown.

- [ ] **Step 1: Write the failing finalization and authority tests**

Add a test proving final payment calls `disarm(leaseId, 'confirm_payment')`
before any charge/print dispatch. Add a test proving a failed disarm returns a
503 and does not dispatch the final job. Add a source-level integration test
around the Socket.IO control registration (or extract the registration into a
small testable function) proving a client `unlockCoinSlot` event cannot call
`UnlockCoinSlot`. The only remaining customer unlock call must be the gate's
`arm()` path.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts`

Expected: FAIL because finalization does not yet know about the lease and the
server still registers a generic client unlock listener.

- [ ] **Step 3: Wire the singleton and startup lock**

Construct the gate once in the server composition root with these callbacks:

```ts
{
  armCustomerPayment: () => hardwareStateProjection.armCustomerPayment(),
  disarmCustomerPayment: (reason) => hardwareStateProjection.disarmCustomerPayment(reason),
  canAcceptCustomerWork: () => powerSafetyService.canAcceptCustomerWork(),
  isPrinterReady: () => {
    const telemetry = getPrinterTelemetry();
    return telemetry.connected && !BLOCKED_STATUSES.has(telemetry.status);
  },
  isSerialConnected: () => getSerialStatus().connected,
  getBalance: () => db.data?.balance ?? 0,
}
```

After `workerReturnPipe.ready`, call and await
`hardwareStateProjection.initializeCustomerPaymentLock()` before marking
startup ready. The in-memory lock is already present during module startup;
this awaited command synchronizes the physical worker state.

- [ ] **Step 4: Remove generic Socket.IO unlock and add server-side safety hooks**

Delete the `unlockCoinSlot` listener and the disconnect path that calls
`unlockOwnedCoinSlot(socket.id)`. Remove the confirm page's dependency on those
events. A client may not produce an `UnlockCoinSlot` command through the
control socket. Keep initial `coinSlotLocked` status emission and all
power-safety lock/recovery calls. On `PrinterOffline`, `PrinterError`, and
other printer-fault paths in the worker event callback, call
`void paymentAcceptorGate.disarmForSafety('printer_unavailable')`. In
`gracefulShutdown()`, await `paymentAcceptorGate.shutdown()` before closing
the HTTP server and worker return pipe.

- [ ] **Step 5: Disarm before final payment and run focused tests**

Add `paymentLeaseId?: string` to `ConfirmPaymentBody`. At the beginning of
`confirmPayment`, after the power check and before idempotency/charge work,
call `await this.paymentAcceptorGate.disarm(paymentLeaseId, 'confirm_payment')`
when a lease ID is present. A failed hardware disarm returns a retryable 503.
Pass the gate through `FinancialModuleDeps` and `FinancialServiceDeps`.

Run: `pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts`

Expected: PASS, including finalization disarm and rejection of generic socket
unlock attempts.

- [ ] **Step 6: Commit server authority wiring**

```bash
git add -- src/server.ts src/app.module.ts src/modules/financial/financial.module.ts src/modules/financial/financial.service.ts tests/modules/payment/payment-session.service.spec.ts
git commit -m "fix: make payment acceptor server-owned"
```

### Task 5: Move the confirm page to lease lifecycle control

**Files:**

- Modify: `src/public/confirm/app.ts`
- Test: `tests/public/confirm-payment-gate.spec.ts`

**Interfaces:**

- Consumes: the three payment-session endpoints from Task 3 and the
  `PaymentLease` JSON shape.
- Produces: no physical hardware command calls from browser code; the page
  starts/refreshes/releases only its server lease.

- [ ] **Step 1: Add a failing browser-state regression check**

Add a focused test or deterministic source-level check that the confirm bundle
contains calls to `/api/payment-session/arm`, `/heartbeat`, and `/cancel`,
includes `paymentLeaseId` in `/api/confirm-payment`, and contains no
`emit('unlockCoinSlot'` or `emit('lockCoinSlot'` calls. The check must also
assert that `src/public/scc/app.ts` still posts to
`/api/balance/add-test-coin`.

- [ ] **Step 2: Run the check and verify it fails**

Run: `pnpm test -- --runInBand tests/public/confirm-payment-gate.spec.ts`

Expected: FAIL because the current confirm page still emits Socket.IO lock and
unlock events.

- [ ] **Step 3: Implement the confirm lease client**

Add these module-level values and functions:

```ts
let paymentLeaseId: string | null = null;
let paymentLeaseExpiresAt = 0;
let paymentArmInFlight = false;
let paymentHeartbeatTimer: number | null = null;

async function armPaymentLease(): Promise<void>;
async function sendPaymentHeartbeat(): Promise<void>;
async function releasePaymentLease(
  reason: string,
  keepalive?: boolean,
): Promise<void>;
function syncPaymentLeaseState(): void;
```

`syncPaymentLeaseState()` may arm only when the mode is `print` or `copy`,
pricing is loaded, the total is positive, the printer is ready, no fatal or
recoverable printer error is shown, the current balance is below the total, and
no payment/job request is running. Serialize repeated calls with
`paymentArmInFlight`. On success, store the lease ID, start a 3-second
heartbeat, and render the coin acceptor as ready. On any arm/heartbeat failure,
render it locked and leave the physical decision to the server.

Replace `syncCoinSlotLockState()` calls with `syncPaymentLeaseState()`. Remove
all browser `lockCoinSlot`/`unlockCoinSlot` emits. On balance reaching the
required amount, stop heartbeats and await `releasePaymentLease('target_reached')`.
Before the existing `/api/confirm-payment` request, await
`releasePaymentLease('confirm_payment')` and include the returned lease ID in
the request body. Use a `keepalive` fetch on `pagehide`, cancellation, idle
timeout, printer failure, and terminal completion; clear the local lease state
immediately so a late UI event cannot re-arm it.

- [ ] **Step 4: Run the client regression and build the browser bundle**

Run:

```bash
pnpm test -- --runInBand tests/public/confirm-payment-gate.spec.ts
pnpm run build
```

Expected: PASS; the client build must complete without TypeScript or bundling
errors, and `/scc` output remains present in the built assets.

- [ ] **Step 5: Commit confirm lifecycle changes**

```bash
git add -- src/public/confirm/app.ts tests/public/confirm-payment-gate.spec.ts
git commit -m "feat: control coin acceptor through confirm lease"
```

### Task 6: Full verification and graph maintenance

**Files:**

- Modify: graphify-generated files only as produced by `graphify update .`.

- [ ] **Step 1: Run the complete automated suite**

Run: `pnpm test -- --runInBand`

Expected: all existing and new tests pass, including the untouched
`CoinSimulation` tests and loading-animation test.

- [ ] **Step 2: Run lint and production build**

Run:

```bash
pnpm run lint
pnpm run build
```

Expected: both commands exit successfully without new warnings or errors.

- [ ] **Step 3: Verify the critical authority paths textually**

Run:

```bash
rg -n "unlockCoinSlot|lockCoinSlot|UnlockCoinSlot|LockCoinSlot|payment-session|add-test-coin" src --glob '!src/public/vendor/**'
```

Expected: browser code references only payment-session HTTP endpoints; worker
unlock appears only in the server-owned hardware/gate path; `/scc` continues
to reference `/api/balance/add-test-coin`.

- [ ] **Step 4: Update the knowledge graph after code changes**

Run: `graphify update .`

Expected: graphify refreshes the repository graph without changing unrelated
source files.

- [ ] **Step 5: Review the final diff and status**

Run:

```bash
git diff --check HEAD~5..HEAD
git status --short
```

Confirm that only the new acceptor-gate implementation, its tests, approved
plan/spec documents, and graphify outputs changed; do not stage or alter the
user's pre-existing dirty files.
