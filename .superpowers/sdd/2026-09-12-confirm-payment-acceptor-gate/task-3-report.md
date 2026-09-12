# Task 3 Report: confirm-only payment-session HTTP boundary

## Implementation summary

Added a payment-session module with root-mounted `POST` endpoints for arm,
heartbeat, and cancel. The service accepts a capability only from
`req.cookies[CONFIRM_CAPABILITY_COOKIE]`, validates the allowed JSON shapes,
checks print-session state and resolves the active session before requesting a
lease from `PaymentAcceptorGate`, and translates its outcomes into the fixed
HTTP response payloads.

`/confirm` now issues a server-generated capability and sets it as an
`HttpOnly`, strict same-site, root-path cookie with a five-minute `maxAge`
before serving its HTML. App wiring supplies the same gate to both the page and
payment modules, protects `/api/payment-session` with the existing kiosk
write-protection middleware, and leaves `/scc`, `CoinSimulation`, financial,
and server integration untouched.

## Files changed

- Created `src/modules/payment/payment-session.service.ts`
- Created `src/modules/payment/payment-session.controller.ts`
- Created `src/modules/payment/payment-session.module.ts`
- Created `src/modules/payment/index.ts`
- Modified `src/modules/page/page.controller.ts`
- Modified `src/modules/page/page.module.ts`
- Modified `src/modules/page/index.ts`
- Modified `src/app.module.ts`
- Created `tests/modules/payment/payment-session.service.spec.ts`

## TDD evidence

### RED

Command:

```text
pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts
```

Exit code: `1`

Relevant output:

```text
FAIL tests/modules/payment/payment-session.service.spec.ts
TS2307: Cannot find module '../../../src/modules/payment/payment-session.service'
TS2353: 'paymentAcceptorGate' does not exist in type 'PageControllerDeps'
Test Suites: 1 failed, 1 total
Tests:       0 total
```

The first RED run also surfaced two test-fixture type omissions
(`publicBaseUrl` scope and `WorkerPrintEvent.timestampUtc`); those were fixed
before rerunning so the captured RED failure represented only the missing Task
3 module and page capability contract.

### GREEN

Command:

```text
pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts
```

Exit code: `0`

Exact output:

```text
Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
Snapshots:   0 total
Time:        8.136 s
```

The tests cover missing/body-only capability rejection, invalid mode and
amount, missing and expired print sessions, hardware rejection, valid lease
payload, heartbeat/cancel lease forwarding, confirm-cookie attributes and
ordering, resolved public-base-url session lookup, and the independent real
`CoinSimulation`/fake-worker path.

## Verification

| Command | Result |
| --- | --- |
| `pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts` | Exit 0; 1 suite, 8 tests passed. |
| `pnpm exec eslint src/modules/payment/payment-session.service.ts src/modules/payment/payment-session.controller.ts src/modules/payment/payment-session.module.ts src/modules/payment/index.ts src/modules/page/page.controller.ts src/modules/page/page.module.ts src/modules/page/index.ts src/app.module.ts tests/modules/payment/payment-session.service.spec.ts` | Exit 0; no output. |
| `pnpm exec tsc --noEmit` | Exit 0; no output. |
| `pnpm run build` | Exit 0; client bundles and `dist/server.js` built successfully. |
| `graphify update .` | Exit 0; graph refreshed with 5,091 nodes, 9,564 edges, and 333 communities. |

An initial passing focused run stayed open because importing the page controller
also imported the existing database idempotency cleanup interval. `--detectOpenHandles`
identified `src/core/database/idempotency.ts:152`; the route unit test now mocks
only its unrelated `@/services/db` dependency. The exact normal focused command
then exited 0 without an open-handle warning.

## Self-review

- Correctness: verified all required status outcomes, fixed response payloads,
  session validation sequence, root endpoint paths, and cookie-before-file
  ordering.
- Security: capability is never read from body, route, or referer; request
  bodies are allowlisted and type-checked; the capability cookie is HttpOnly,
  SameSite strict, root scoped, and finite lived; no token is returned in an API
  payload or log. Existing kiosk protection applies to the new API prefix.
- Architecture: the payment service owns HTTP validation while the existing
  gate retains capability, lease, and hardware authority. No server or
  financial integration files were changed.
- Readability/performance: no dependencies, database access, unbounded work,
  or additional hot-path polling were introduced.
- Diff hygiene: `git diff --check` was clean; only the Task 3 code/test files
  will be staged for the commit.

## Concerns

- Task 4 must pass the real composition-root `paymentAcceptorGate` into
  `registerAppModules`. Until then, this task's optional fail-closed fallback
  intentionally makes arm requests return 503 rather than risking a physical
  customer-payment unlock. This preserves the locked-by-default invariant
  without modifying the server file reserved for Task 4.
- Graphify reported community labels may be refreshed separately; it is a
  graph-metadata warning only and does not affect the implementation.

## Fix round 2: capability-bound heartbeat/cancel and failed expiry disarm

### Scope and correction

Heartbeat and cancel now validate the HttpOnly confirmation capability before
they enter the gate. The cancel path passes both capability and lease ID to a
capability-bound gate operation, so a different valid capability cannot disarm
another session's lease. If expiry discovers an active lease but hardware
refuses its safety disarm, the gate retains that lease and returns no new arm;
the HTTP service maps that fail-closed result to 503.

The SCC assertion now supplies the actual `PaymentAcceptorGate` to
`FinancialService` before exercising `POST /api/balance/add-test-coin`. It
uses the real module `coinSimulation` and a fake `SimulateCoin` worker sender,
then proves the injected customer-payment gate was not consulted.

Correction to the previous evidence: its claim of 8 tests was inaccurate. At
Task 3 fix commit `06d5d8d`, the file had 10 test declarations including one
two-case table, i.e. 11 executed tests. The concurrent Task 4 head
`fa55c25` had 13 declarations (14 executed tests) before this round; the
focused suite now executes 19 tests.

### TDD evidence

#### RED

Command:

```text
pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts
```

Exit code: `1`

Exact failure summary:

```text
FAIL tests/modules/payment/payment-session.service.spec.ts
  ● PaymentSessionService › rejects a forged capability heartbeat with 401 before forwarding to the gate
    Expected statusCode: 401
    Received statusCode: 409
  ● PaymentSessionService › rejects a expired capability heartbeat with 401 before forwarding to the gate
    Expected statusCode: 401
    Received statusCode: 409
  ● PaymentSessionService › does not allow a forged capability to cancel a known active lease
    Expected statusCode: 401
    Received statusCode: 200
  ● PaymentSessionService › does not allow a different valid capability to cancel another capability lease
    Expected statusCode: 409
    Received statusCode: 200
  ● PaymentSessionService › fails closed with 503 when an expired lease safety disarm fails
    Expected statusCode: 503
    Received statusCode: 200

Test Suites: 1 failed, 1 total
Tests:       5 failed, 14 passed, 19 total
```

#### GREEN

Command:

```text
pnpm test -- --runInBand tests/modules/payment/payment-session.service.spec.ts
```

Exit code: `0`

Exact output:

```text
Test Suites: 1 passed, 1 total
Tests:       19 passed, 19 total
Snapshots:   0 total
Time:        12.524 s, estimated 24 s
Ran all test suites matching tests/modules/payment/payment-session.service.spec.ts.
Jest did not exit one second after the test run has completed.
```

The warning is pre-existing test-process cleanup from
`src/core/database/idempotency.ts:152`'s module-level interval. The fresh
diagnostic run confirms it without masking the result:

```text
pnpm test -- --runInBand --detectOpenHandles tests/modules/payment/payment-session.service.spec.ts
Test Suites: 1 passed, 1 total
Tests:       19 passed, 19 total
Jest has detected the following 1 open handle potentially keeping Jest from exiting:
  ● Timeout
      at Object.<anonymous> (src/core/database/idempotency.ts:152:1)
```

### Focused verification

| Command | Exit code | Exact output |
| --- | --- | --- |
| `pnpm test -- --runInBand tests/services/payment-acceptor-gate.spec.ts` | 0 | `Test Suites: 1 passed, 1 total` / `Tests: 13 passed, 13 total` / `Time: 9.574 s` |
| `pnpm exec eslint src/modules/payment/payment-session.service.ts src/services/payment-acceptor-gate.ts` | 0 | No output. |
| `pnpm exec tsc --noEmit` | 0 | No output. |
| `pnpm exec eslint src/modules/payment/payment-session.service.ts src/services/payment-acceptor-gate.ts tests/modules/payment/payment-session.service.spec.ts` | 1 | Existing concurrent Task 4 test code reports one error: `tests/modules/payment/payment-session.service.spec.ts:530:9 'statusCode' is assigned a value but never used`; it also reports 9 pre-existing `no-explicit-any` warnings. No fix-round line triggered that lint error. |
| `graphify update .` | 0 | Re-extracted 286 code files. Graphify reported that saved labels cover 294 communities while the refreshed graph has 342, and suggested `graphify label`; this is graph metadata only. |

### Self-review

- Correctness: invalid and expired cookies return 401 before heartbeat/cancel
  dispatch; cancel requires matching capability plus lease; failed expiry
  disarm cannot be followed by a new arm.
- Security: the HTTP cookie remains the sole capability source; a guessed
  lease ID cannot cancel customer-payment hardware.
- Isolation: `/api/balance/add-test-coin` remains independent of customer
  payment while its test now observes the actual injected gate.
- Scope: no SCC or `CoinSimulation` production behavior changed. `git diff
  --check` completed without whitespace errors.
