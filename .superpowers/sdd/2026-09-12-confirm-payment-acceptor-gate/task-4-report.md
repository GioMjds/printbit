# Task 4 Fix Round 1 — Confirm-Only Coin Acceptor Gate

## Scope and base

- Requested base: `459ee56b9f88d3c7aa6093ec44115fe0395ae380`
- Existing concurrent Task 4 commit retained: `fa55c25`
- User-owned untracked files were preserved: `codex-ARM-coin-acceptor.md`,
  `codex-Scan-One-Time.md`, and `tests/public/confirm-payment-gate.spec.ts`.

## Review findings resolved

1. `FinancialService.confirmPayment` now calls the injected singleton gate's
   `disarm(paymentLeaseId, 'confirm_payment')` whenever the customer-payment
   gate is present, before idempotency, validation, settlement, or print queue
   work. A missing lease is forwarded as `undefined`; an active lease rejects
   it, returning the existing retryable `503 PAYMENT_DISARM_FAILED` response.
2. The Task 3 implementation already retains `PaymentAcceptorGate.activeLease`
   until the physical disarm acknowledgement succeeds. A new regression test
   proves a failed disarm retry sends the same lease through a second physical
   disarm instead of succeeding locally.
3. Startup now throws when
   `hardwareStateProjection.initializeCustomerPaymentLock()` returns `false`.
   The initialization error is caught by the established startup handler, so
   readiness remains failed rather than becoming ready without worker lock
   acknowledgement.
4. Removed all confirm-page `lockCoinSlot` and `unlockCoinSlot` Socket.IO
   emissions, including the idle-timeout unlock. The page keeps only local
   visual payment-state updates. The server-side generic unlock listener was
   already absent and remains absent; power-safety and gate-controlled hardware
   paths are unchanged.

## Test-first evidence

### RED

Command:

```text
pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts tests/services/payment-acceptor-gate.spec.ts
```

Exit: `1`

Relevant output:

```text
FAIL tests/modules/payment/payment-session.service.spec.ts
● fails closed before settlement or dispatch when an active payment omits its lease id
  Expected: undefined, "confirm_payment"
  Number of calls: 0

● does not emit generic coin-slot socket controls from the confirm browser page
  Expected pattern: not /emit\(\s*['"]unlockCoinSlot['"]/

● requires a physical customer-payment lock acknowledgement before startup can become ready
  Expected pattern: /if\s*\(\s*!\s*await\s+hardwareStateProjection\.initializeCustomerPaymentLock\(\)\s*\)/

Test Suites: 1 failed, 1 passed, 2 total
Tests: 3 failed, 33 passed, 36 total
```

### GREEN

Command:

```text
pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts tests/services/payment-acceptor-gate.spec.ts
```

Exit: `0`

Output:

```text
Test Suites: 2 passed, 2 total
Tests:       36 passed, 36 total
Snapshots:   0 total
```

The existing Jest process printed its pre-existing post-run open-handle notice;
the subsequent diagnostic command identified the existing global idempotency
cleanup interval as its source:

```text
pnpm test -- --runInBand --detectOpenHandles tests/modules/payment/payment-session.service.spec.ts tests/services/payment-acceptor-gate.spec.ts
# exit 0; 2 suites passed, 36 tests passed

Jest has detected the following 1 open handle potentially keeping Jest from exiting:
● Timeout at src/core/database/idempotency.ts:152 (global setInterval cleanup)
```

## Additional verification

```text
pnpm test -- --runInBand tests/public/confirm-payment-gate.spec.ts  # exit 0
pnpm exec tsc --noEmit                                               # exit 0
pnpm lint                                                            # exit 0
pnpm run build                                                       # exit 0
graphify update .                                                    # exit 0
```

The build rebuilt the confirm client and server successfully. No generated
artifact changes were staged. `/scc` and production CoinSimulation behavior
remain covered by the focused payment-session suite and were not changed.

## Self-review

- Correctness: verified missing and failed leases stop settlement, enqueueing,
  and direct printer dispatch; verified retained lease state after failed
  physical disarm acknowledgement.
- Architecture: the existing Node singleton remains the only customer-payment
  hardware authority; power-safety paths and printer fault/shutdown hooks
  remain independent.
- Security: browser controls no longer provide generic coin-slot authority;
  untrusted omission of `paymentLeaseId` is fail-closed whenever a gate is
  present.
- Readability and performance: implementation is three small control-flow
  edits, with no dependencies, extra I/O, or new hot-path work.

---

# Task 4 Fix Round 2 — Finalization Disarm Test Reachability

## Scope and base

- Base HEAD: `046cfb8c37b86988ec36009981270f683a907947`
- Scope is test/report-only: production behavior, `/scc`, and CoinSimulation
  were not changed.
- User-owned untracked files remain preserved.

## Review finding resolved

The finalization disarm tests now construct a valid print confirmation:
an active upload session with a completed one-page PDF analysis, an existing
converted-document path, ready printer telemetry, sufficient balance, a
successful settlement result, and a successful worker queue enqueue result.
Therefore settlement and worker dispatch are reachable in the success path,
and the failed-disarm assertions prove that the gate stops each before they
occur. The legacy direct `printFile` boundary remains mocked and asserted
untouched for the failed path.

The successful finalization test records side-effect order and requires:

```text
disarm -> settlement -> queue-dispatch
```

## Test-first evidence

### Initial RED while completing the valid fixture

Command:

```text
pnpm exec jest --runInBand --verbose tests/modules/payment/payment-session.service.spec.ts
```

Exit: `1`

Relevant output:

```text
TypeError: Cannot read properties of undefined (reading 'pricing')
at AdminService.getPricingSettings
at buildPrintQuote
```

The new request reached real quote calculation; the test database double was
then completed with the production pricing and job-stat fields needed by that
valid finalization route.

### Regression mutation RED

After the valid fixture was green, the existing physical-disarm expression
was temporarily replaced with `const disarmed = true` (without committing the
mutation), then restored exactly.

Command:

```text
pnpm exec jest --runInBand --verbose tests/modules/payment/payment-session.service.spec.ts --testNamePattern "disarms before settlement and worker queue dispatch"
```

Exit: `1`

Relevant output:

```text
Expected: "test-lease-id", "confirm_payment"
Number of calls: 0
```

This proves the new valid-finalization test fails if production finalization
skips the payment-acceptor disarm before settlement and dispatch.

### Restored GREEN

Command:

```text
pnpm exec jest --runInBand --verbose tests/modules/payment/payment-session.service.spec.ts tests/services/payment-acceptor-gate.spec.ts
```

Exit: `0`

Output:

```text
Test Suites: 2 passed, 2 total
Tests:       36 passed, 36 total
Snapshots:   0 total
```

The suite still prints its pre-existing open-handle notice after completion;
Fix Round 1 identified the global idempotency cleanup interval as its source.

### Type-check

```text
pnpm exec tsc --noEmit
```

Exit: `0`
