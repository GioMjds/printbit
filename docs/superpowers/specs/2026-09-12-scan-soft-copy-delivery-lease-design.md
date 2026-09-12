# Scan Soft-Copy Delivery Lease

## Status

Approved design for implementation planning.

## Problem

PrintBit charges for a scanned soft copy on `/confirm` and then places a QR
code in the success overlay. The current download link is an in-memory,
15-minute bearer session. It has no live countdown, does not survive a server
restart, does not bind the first scanner to one device, and link expiry does
not remove the scanned file. The filename-based wireless-link route also
creates an access path that is not sufficiently tied to a paid delivery.

The desired behavior is a durable one-device delivery lease: after payment,
one customer browser/device can claim and repeatedly download the soft copy
until the lease expires. Other devices must not be able to use the same QR
code.

## Goals

1. Create a durable, server-authoritative delivery lease after successful
   soft-copy payment.
2. Show a live countdown on the kiosk success overlay and on the phone
   delivery page.
3. Bind the lease to the first browser/device that explicitly claims it, then
   allow that device to download repeatedly until expiry.
4. Expire and clean up the delivery lease and its transient scan file.
5. Keep the lease valid across application restarts and make cleanup retryable.
6. Make payment completion and delivery creation idempotent so a retry cannot
   charge the customer twice or create ambiguous delivery ownership.
7. Remove or protect filename-only link creation so an unpaid scan cannot mint
   a delivery URL.

## Non-goals

- This does not cryptographically prove that the device belongs to the payer.
  It provides practical first-browser/device binding without requiring login,
  phone verification, or an external identity provider.
- This does not bind access to IP address or user-agent. Both can change during
  a legitimate mobile session and are not reliable device identity signals.
- This does not redesign the separate receipt QR flow.
- This does not make a delivery unlimited or transferable after its lease
  expires.
- This does not replace the broader payment ledger with a new transaction
  system; it adds durable delivery state to the existing flow.

## Existing behavior

- `src/public/confirm/app.ts` charges with
  `POST /api/scanner/soft-copy/charge`, renders the returned download QR, and
  currently displays an expiry timestamp or the fallback text “Valid for 15
  minutes”. It has no live countdown.
- `src/modules/scanner/scanner.service.ts` keeps a paid filename marker in
  memory for 30 minutes and creates a wireless download link after settlement.
  Link-generation errors are currently swallowed after payment succeeds.
- `src/services/scan-delivery.ts` keeps download sessions in memory with a
  configurable 15-minute default TTL. Expiry purges the session map but does
  not delete the scan file.
- `src/modules/scanner/scanner.controller.ts` streams a file for a valid
  download token and currently exposes a filename-based wireless-link route.
- `src/public/upload/app.ts` and `src/public/print/app.ts` provide the existing
  server-supplied countdown pattern that can be reused for countdown math and
  warning behavior.

## Proposed design

### Durable delivery lease

After the charge request identifies the scan artifact, the server creates a
pending delivery record before payment settlement. The record is activated
only when settlement succeeds and a durable download token has been persisted.
The charge operation returns the lease's download URL, expiry, remaining
seconds, and transaction ID.

The lease owns the paid delivery identity, rather than treating a filename as
the authorization boundary. A stable scan-artifact or payment-delivery ID is
used for idempotency. Repeated requests for the same paid delivery return the
existing active lease and do not charge again.

The default lease duration is 15 minutes and remains configurable through the
existing scan-download TTL setting. The expiry timestamp is calculated by the
server and is the only authority for access and countdown completion.

### Suggested SQLite record

Add a durable `scan_delivery_leases` model/table with fields equivalent to:

- `id`: internal unique lease ID;
- `transaction_id`: unique PrintBit transaction reference;
- `filename` and `file_path`: the validated transient scan artifact;
- `token_hash`: hash of the opaque delivery token, never the raw token;
- `status`: `pending`, `active`, `claimed`, `expired`, or `revoked`;
- `paid_at`: settlement timestamp;
- `expires_at`: server-authoritative lease expiry;
- `claimed_at`: first successful claim timestamp;
- `claimed_device_hash`: hash of the device-claim cookie value;
- `download_count` and `last_downloaded_at`: delivery telemetry.

Recommended constraints and indexes:

- unique `transaction_id`;
- unique `token_hash`;
- index on `(status, expires_at)` for cleanup;
- index on `filename` only where needed for artifact cleanup and diagnostics.

The raw delivery token is generated with a cryptographically secure random
source and is shown only in the URL/QR. The database stores only its hash.
The same applies to the device-claim cookie value.

### Lease lifecycle

1. The scan page creates a transient scan file and receives its existing
   release token.
2. The customer reaches `/confirm` and selects soft-copy delivery.
3. The server validates the scan artifact and creates a pending delivery
   record. The pre-payment release token remains associated with the artifact
   while payment is in progress.
4. The server settles the payment exactly once. On success it records `paid_at`,
   creates the opaque delivery token, sets `expires_at`, activates the lease,
   and revokes the pre-payment release token as one coordinated operation.
5. The kiosk displays the QR for `/scan/access/:token`, not a direct file URL.
6. The first phone opens the access page and explicitly presses a claim/download
   action. The server atomically binds the lease to that browser's claim
   cookie, changing status to `claimed`.
7. Requests with the same claim cookie can download repeatedly while the lease
   is unexpired. A different claim cookie receives an ownership conflict.
8. At expiry, access is denied and the lease becomes `expired`. Cleanup deletes
   the transient file and removes or marks the delivery record according to
   retention policy.
9. Startup cleanup and a periodic cleanup job find expired/pending-stale
   records. File deletion and status updates are retryable; a failed cleanup
   must not silently restore access.

If a durable lease cannot be activated after payment settlement, the server
must not return a successful delivery response without a recoverable lease.
The implementation must either make lease activation part of the same local
transaction boundary or mark the payment for explicit operational recovery
and retain the artifact safely until recovery completes. It must never silently
swallow link persistence errors as the current flow does.

### One-device claim

The QR target is a claim page. Opening the page must not automatically claim
the lease, because browser prefetching, QR scanners, or link previews could
consume the one-device binding.

On the explicit claim request, the server issues an opaque random HttpOnly
cookie, stores only its hash, and atomically claims the lease with logic
equivalent to:

```text
claim when status is active/claimed, not expired, and
(claimed_device_hash is empty OR claimed_device_hash equals this cookie hash)
```

The first successful claimant owns the lease. A later request from the same
cookie succeeds; a request from another cookie returns a clear “already claimed
by another device” response. Claiming must be atomic so two phones racing to
scan the QR cannot both win.

The cookie should be HttpOnly and SameSite appropriate for the kiosk's delivery
origin. Set `Secure` when the deployment uses HTTPS; preserve the deployment's
local HTTP compatibility where HTTPS is not available. Use a narrow path and
short lifetime aligned with the lease. Do not log raw token or cookie values.

This is a practical one-browser/device lease, not a proof of customer identity.
If stronger identity is required later, an optional OTP or authenticated
account flow can be added as a separate delivery mode.

### API shape

Keep the existing charge endpoint but change its delivery behavior:

- `POST /api/scanner/soft-copy/charge`
  - validates the scan artifact and amount;
  - idempotently creates or resumes the pending delivery;
  - settles payment once;
  - activates the durable lease;
  - returns `transactionId`, `downloadUrl`, `expiresAt`,
    `remainingSeconds`, and any existing format/filename display metadata.

Add or adapt the following delivery routes:

- `GET /scan/access/:token`: renders the claim/download page without exposing
  unnecessary payment or filesystem details;
- `POST /api/scanner/soft-copy/deliveries/:token/claim`: explicitly claims the
  lease and sets the device cookie;
- `GET /scan/download/:token`: requires an active, unexpired lease and a
  matching device cookie before streaming the file.

The filename-based `POST /api/scanner/wireless-link` route must be removed from
the customer path or changed to an internal/paid-delivery-only operation. No
caller should be able to create a new soft-copy delivery by knowing a scan
filename alone. The confirm-page fallback that mints a link after charge
should be removed once the charge endpoint guarantees a lease-backed link.

Download responses should include `Cache-Control: no-store`,
`Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. Preserve
the existing download rate limit and add claim/access rate limits as needed.

### Countdown UX

The confirm success overlay remains the primary kiosk countdown surface. It
should display a server-derived countdown such as `Download available for
14:59`, update once per second using the existing local ticker pattern, and
show a warning state during the final minute. At zero it must replace or
disable the QR and explain that the delivery has expired.

The phone access page should display the same expiry and countdown, refresh its
server state on claim/download responses, and show clear states for:

- available to claim;
- claimed by this device;
- claimed by another device;
- expired;
- revoked; and
- missing or unavailable scan file.

The countdown is informational in the browser; every claim and download is
revalidated against the server's `expires_at`.

Keep the receipt QR separate from the soft-copy QR, and preserve the selected
file format and page-count information in the success messaging where already
available.

## Security and privacy

- Use high-entropy opaque tokens and store only hashes at rest.
- Keep delivery tokens out of application logs, analytics URLs, and error
  messages.
- Validate the referenced file through the existing transient-scan path
  safeguards; never accept an arbitrary filesystem path from the client.
- Use atomic claim/update logic and re-check expiry in the same authorization
  path as download.
- Do not rely on IP address, user-agent, referrer, or QR scanner identity as
  device binding.
- Prevent browser caching and referrer leakage from the delivery page and file
  response.
- Ensure release-token cleanup cannot delete an activated paid artifact; lease
  ownership must supersede the pre-payment release lifecycle.
- Avoid returning whether an unrelated filename exists through the protected
  delivery routes.

## Error handling and race conditions

- Missing, invalid, or already-consumed scan artifact: reject before charging.
- Duplicate charge retry: return the existing active/pending delivery state and
  do not append a second successful charge.
- Payment failure: mark the pending delivery failed/revoked and retain the
  normal release cleanup behavior.
- Lease activation failure after settlement: retain a recoverable record and
  artifact, raise an operational error, and do not report a completed delivery
  without a URL.
- Concurrent claim: exactly one device wins; all losers receive a stable
  ownership response.
- Same-device retry: return the active lease and increment download telemetry
  only after a file stream is authorized.
- Missing file after a valid lease: deny access, mark the lease unavailable or
  expired, and record the cleanup/consistency failure.
- Expired or revoked lease: return a non-retryable access response and never
  recreate it from the token.
- Cleanup failure: keep the lease inaccessible and retry deletion/update on the
  next cleanup pass or startup.

## Testing strategy

Tests should cover behavior at the service, persistence, controller, and UI
boundaries:

- lease creation, activation, persistence, restart recovery, and expiry;
- configurable TTL and server-derived remaining seconds;
- duplicate charge/idempotency behavior;
- payment failure and activation-persistence failure handling;
- release-token revocation when a lease activates;
- first-device claim, same-device repeat claim/download, and different-device
  rejection;
- concurrent claim race with exactly one winner;
- expired, revoked, missing-file, and cleanup-retry behavior;
- unpaid filename cannot create or access a soft-copy delivery;
- download headers and rate limits;
- countdown rendering, final-minute warning, and zero-expiry UI;
- QR access-page flow on a mobile-sized browser; and
- preservation of the existing receipt QR and non-scan print/copy flows.

## Observability

Record structured events keyed by lease ID and transaction ID, without raw
tokens or cookie values:

- lease pending, activated, claimed, downloaded, expired, revoked;
- claim conflict and rejected download;
- duplicate charge reuse;
- missing-artifact and cleanup failures; and
- activation persistence failures requiring recovery.

Useful metrics include active leases, claim conflicts, successful downloads,
expired-without-download leases, cleanup failures, and payment-to-claim
conversion. Retain only the minimum metadata needed for support and audit.

## Acceptance criteria

The change is complete when:

1. A successful soft-copy payment always returns a durable, lease-backed QR
   delivery with a server expiry timestamp.
2. The lease survives an application restart and remains inaccessible after
   its expiry.
3. The first explicitly claiming browser/device can download repeatedly until
   expiry, while another browser/device cannot claim or download it.
4. Claim and download authorization does not depend on filename, IP address,
   or user-agent.
5. The kiosk and phone surfaces show a live countdown and an unambiguous
   expired state.
6. Expiry cleanup removes the transient scan artifact with retryable failure
   handling, and pre-payment release cleanup cannot remove an active paid
   delivery.
7. Duplicate payment requests do not double-charge or create competing active
   leases.
8. The customer cannot mint a soft-copy link through the filename-only wireless
   route, and all delivery routes enforce lease authorization.
9. Existing receipt QR, scan format selection, and unrelated print/copy flows
   continue to work.
