# Worker Command Pipe Reliability Design

## Goal

Make Node.js-to-C# worker commands reliable during kiosk startup, normal concurrent use, and worker restarts without weakening the named-pipe security boundary or replaying hardware side effects.

## Scope

This change covers the Node command-pipe transport, the C# command-pipe listener, the pipe access-control configuration, single-worker enforcement, deployment validation, and cross-process regression tests. It does not change command payload semantics, add a general message broker, or alter the worker event/return pipes.

## Current Failure Modes

- Node performs one `net.connect` attempt. A normal startup race or the worker's brief listener-recreation gap becomes an immediate `ENOENT` result.
- The C# worker creates one pipe instance, processes one request, disposes it, and only then creates the next listener. Concurrent callers and the disposal/recreation window can observe no available endpoint.
- The command pipe grants the worker identity, LocalSystem, and Administrators. A Node backend launched as a limited kiosk account is denied even when the worker is healthy.
- A second worker process can start, fail to own the pipes, and retry forever. This produces noisy partial startup and makes ownership ambiguous.

## Design

### Node transport

`sendWorkerRequest` will use a single overall deadline and make bounded connection attempts with exponential backoff and jitter. The defaults will tolerate ordinary service startup while remaining below the existing request timeout. Retryable pre-connect errors are `ENOENT`, `ECONNREFUSED`, and `EBUSY`; access errors such as `EACCES` or `EPERM` fail immediately because waiting cannot repair an ACL mismatch.

The transport records whether a connection was established and whether a write was attempted. Once connected, it never opens a replacement connection for that request. A write error, response timeout, malformed response, or disconnect therefore returns `null` without replaying a command that may already have caused a hardware side effect. Existing callers and response types remain compatible. Tests use real local named-pipe servers rather than asserting mock call counts.

### C# listener lifecycle

The worker command service will separate accepting connections from processing requests. After accepting a client, it will create the replacement server instance before dispatching that client for processing. Connected clients are handled concurrently up to a small configured limit; excess clients receive normal Windows pipe-busy behavior, which the Node pre-connect retry policy handles.

Each client remains one newline-delimited request followed by one newline-delimited response. Client exceptions are isolated so one malformed request or disconnect cannot stop the accept loop. Shutdown stops accepting, cancels active handlers, disposes listeners, and waits for tracked handlers to finish within the host cancellation path.

### Identity and ACL

The command pipe remains deny-by-default. Its ACL grants full control to the worker identity and LocalSystem, read/write to Administrators, and read/write to one optional configured Node backend identity. The configured value is resolved to a Windows SID during startup; an invalid or unresolvable identity is a startup configuration error, not a fallback to `Everyone` or `Authenticated Users`.

Production installation will explicitly align identities: the recommended topology runs both the worker service and Node backend as LocalSystem. If the supported `-KioskUser` backend mode is selected, the installer passes that exact account into the worker's allowed-client identity configuration. Assigned Access governs the browser shell and does not itself determine pipe authorization.

### Single worker ownership

The hardware worker will acquire a machine-wide named single-instance lock before hosted services start. If another instance owns the lock, startup logs one critical error and exits non-zero instead of starting retry loops. This applies equally to a Windows-service instance and an accidentally launched debug executable. The lock is held for the process lifetime and released on orderly shutdown.

Installation and verification scripts will ensure `PrintBitHardware` is installed, configured for automatic startup, and running before the Node backend task is considered ready. Diagnostics will report the service state, backend task identity, configured pipe client identity, and duplicate-instance failure distinctly.

## Error Handling and Observability

- Node logs retryable connection failures at a concise diagnostic level and emits one terminal warning containing the pipe name, attempt count, elapsed time, and final error code.
- ACL errors are labeled as authorization/configuration failures and are not retried.
- The worker logs listener creation, accepted-client count, active-handler count, and clean shutdown without including payload paths or sensitive command data.
- Duplicate ownership is a fatal startup condition with a distinct event message.

## Security Model

The named pipe crosses a local process-identity trust boundary. Spoofing and elevation-of-privilege risks are controlled with explicit SID allowlisting; denial-of-service is bounded by message-size limits, request timeouts, and handler concurrency; replay risk is controlled by allowing retries only before connection. No broad Windows principal is introduced. Existing command parsing and size validation remain mandatory for every client.

## Testing

Node integration tests will prove:

- a request succeeds when the server appears after an initial `ENOENT`;
- concurrent requests succeed while a real named-pipe server accepts them;
- `EPERM`/`EACCES` and post-connect failures are not retried;
- the overall timeout bounds all attempts and cleans up sockets/timers.

C# tests will prove:

- a replacement listener is available while an earlier request is still processing;
- multiple clients are processed up to the configured concurrency;
- client failure does not terminate the listener;
- shutdown disposes listeners and completes tracked handlers;
- ACL construction includes the configured SID and excludes broad principals;
- duplicate single-instance acquisition fails deterministically.

A Windows-only smoke test will start the real worker under the intended service identity, issue commands from the configured Node identity, restart the worker during probing, and verify recovery without `ENOENT` escaping the retry window. Deployment-script tests will exercise both `-AtStartup` and `-KioskUser` identity mappings.

## Rollout

Ship the worker listener and identity configuration before or together with the Node retry change. Install or upgrade the worker service, stop any debug worker, verify the service identity and pipe access, then start the Node backend. Rollback is independent: the Node retry behavior is backward-compatible with the old worker, and the new worker keeps the existing request/response protocol.

## Acceptance Criteria

- No observable listener gap during normal sequential or concurrent command traffic below the configured capacity.
- Node survives delayed worker startup and a short worker restart within its configured overall deadline.
- No command is automatically replayed after connection or write may have occurred.
- The limited kiosk backend works only when its exact SID is configured.
- A second worker instance exits instead of retrying pipe ownership.
- Automated Node, C#, ACL, instance-lock, and deployment tests pass, followed by successful builds of both repositories.
