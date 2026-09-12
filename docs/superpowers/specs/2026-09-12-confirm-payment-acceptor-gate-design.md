# Confirm-Only Coin Acceptor Gate

## Status

Approved design for implementation planning.

## Problem

PrintBit currently uses the hardware coin-slot lock primarily for power safety
and for the confirm page's balance threshold. Once power safety becomes
operational, the physical acceptor can be unlocked while the customer is still
on `/config`, `/print`, or another kiosk page. The browser's route and a generic
Socket.IO `unlockCoinSlot` event are not sufficient authority to enable
physical payment hardware.

The local Smart Coin Console (`/scc`) is an administrator/testing surface. Its
`/api/balance/add-test-coin` flow simulates a worker coin event and must remain
usable independently of the physical customer acceptor lock.

## Goals

1. Keep the physical coin acceptor disabled unless an active payment session is
   explicitly armed from `/confirm`.
2. Make the Node.js backend the authority for arming, lease expiry, and
   disarming the physical acceptor.
3. Preserve the existing power-safety lock as an independent fail-safe lock.
4. Ensure payment hardware is disarmed when the confirm session ends, times
   out, loses its heartbeat, completes payment, encounters a printer failure,
   disconnects, or the application shuts down.
5. Leave the local `/scc` test-coin endpoint and `CoinSimulation` behavior
   unchanged, apart from retaining its existing power-safety protection.

## Non-goals

- This slice does not replace the existing `/api/confirm-payment` finalization
  flow with a persistent `CONFIGURED → AWAITING_PAYMENT → PAID` transaction
  database model.
- This slice does not redesign ESP32 denomination detection, hopper behavior,
  or C# printing.
- This slice does not make `/scc` simulate a customer payment session.

## Proposed design

### Server-owned confirmation capability and payment lease

The `/confirm` page route will issue a short-lived, server-generated
confirmation capability tied to the kiosk session. The capability is stored in
an HttpOnly, SameSite cookie and is not supplied by browser route state.

The confirm page will call a dedicated backend arm endpoint after it has loaded
the quote and confirmed printer readiness. The backend will validate:

- the capability issued by the `/confirm` route;
- the active print/copy session and its ownership;
- a positive, valid quote amount;
- power safety availability;
- printer readiness; and
- the worker/hardware connection required to dispatch the lock command.

On success, the backend creates or refreshes one in-memory payment lease,
marks it as awaiting payment, and dispatches `UnlockCoinSlot` to the worker.
The lock map remains authoritative for physical state: any active lock,
including `power-safety`, keeps the acceptor disabled.

The lease has a short expiration window. The confirm page sends a heartbeat
every few seconds while it remains the active payment screen. The server
disarms the acceptor when the lease expires or when the lease owner explicitly
cancels/completes it. The server also disarms all customer-payment leases on
shutdown.

Only the lease service may dispatch the customer-payment unlock command. The
generic client `unlockCoinSlot` Socket.IO event will no longer be an arming
authority. Client-side lock requests may remain available only where they are
safe and necessary; an arbitrary kiosk page must never be able to unlock the
acceptor.

### Confirm-page lifecycle

The confirm page will:

1. remain physically locked while configuration, quote, printer, or power
   checks are incomplete;
2. call the arm endpoint only after those checks pass;
3. keep the lease alive with a heartbeat while awaiting payment;
4. disarm after the required balance is reached before starting final payment
   processing; and
5. best-effort cancel/disarm on page exit, cancel, timeout, terminal failure,
   printer failure, or navigation away.

The existing UI may continue to render balance updates, but UI state will not
be treated as proof that the acceptor is armed. Physical state comes from the
server-owned lease and worker command path.

### Startup and safety behavior

The hardware projection starts with a non-confirm customer lock in addition to
the existing `power-safety` lock. A normal power-status recovery only removes
the power-safety lock; it does not remove the customer-payment lock. The
customer lock is removed only after successful backend lease validation and
worker command dispatch.

If validation fails, the lease is not armed and the physical acceptor remains
disabled. If worker communication fails during arm or heartbeat handling, the
server fails closed by retaining or restoring the customer lock.

### Smart Coin Console isolation

No customer payment lease or physical acceptor lock check will be added to
`/api/balance/add-test-coin`, `CoinSimulation`, or the `/scc` UI. The test path
will continue to send `SimulateCoin` to the C# worker and wait for the matching
simulated return event. Its existing power-emergency rejection remains intact.

This keeps local accounting/worker integration testing independent of whether
the physical acceptor is locked because the browser is outside `/confirm`.

## Error handling

- Invalid or missing confirmation capability: reject arm with an authorization
  response and keep the acceptor locked.
- Missing, expired, or owner-mismatched customer session: reject arm and keep
  the acceptor locked.
- Invalid or non-positive quote: reject arm and keep the acceptor locked.
- Printer, power, or worker unavailable: reject arm with a retryable service
  response and keep the acceptor locked.
- Expired heartbeat: disarm and mark the lease inactive.
- Duplicate arm/heartbeat/cancel requests: make them idempotent for the lease
  owner and never issue an unlock for an invalid lease.
- Shutdown: synchronously/best-effort dispatch the customer lock before worker
  pipes and sockets are closed.

## Testing strategy

Tests will cover the behavior rather than only implementation calls:

- startup/non-confirm state keeps the physical acceptor locked;
- an untrusted generic socket cannot unlock the acceptor;
- arm fails for missing/invalid capability, invalid amount, unavailable
  printer, unavailable worker, inactive session, and power emergency;
- valid `/confirm` arm unlocks only after all backend checks pass;
- heartbeat refreshes a valid lease and cannot revive an expired or foreign
  lease;
- payment completion, cancel, timeout, disconnect, printer failure, and
  shutdown disarm the acceptor;
- the acceptor is locked again after the target balance is reached; and
- `/api/balance/add-test-coin` plus the `CoinSimulation` event correlation path
  continue to work while the physical customer acceptor remains locked.

## Acceptance criteria

The change is complete when:

1. A customer on `/config` or any non-confirm page cannot cause an
   `UnlockCoinSlot` command.
2. A valid active `/confirm` payment lease is the only customer path that can
   cause `UnlockCoinSlot`.
3. Leaving or losing the confirm lease causes `LockCoinSlot` within the lease
   timeout, with best-effort immediate cleanup on page exit.
4. Power safety can still independently lock the slot and recovery cannot
   bypass the active customer-payment gate.
5. The `/scc` local coin console remains functional and is not blocked by the
   customer acceptor gate.
