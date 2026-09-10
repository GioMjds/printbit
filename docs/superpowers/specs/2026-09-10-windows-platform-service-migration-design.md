# Phase 4 Windows Platform Service Migration Design

**Date:** 2026-09-10

**Status:** Approved for implementation planning

**Scope:** The `printbit` Node.js kiosk application and the sibling `../printbit-worker` .NET Windows Service

## Objective

Prepare both repositories for manual implementation of Phase 4 from `CSHARP_SERVICE_MIGRATION.md` without disrupting the running kiosk.

Phase 4 moves Windows Defender inspection, removable-drive operations, trusted-time observation, and Windows hotspot support behind the C# worker boundary. Node retains application policy, customer workflow, financial enforcement, hotspot configuration, and ESP32 registration.

The preparation must compile and pass tests before the native C# methods are implemented. Existing Node behavior remains active by default and provides a temporary migration fallback.

## Ownership Boundary

### C# worker ownership

The worker owns Windows-specific mechanisms:

- Locate and execute `MpCmdRun.exe`.
- Read Microsoft Defender health and signature freshness.
- Discover removable USB volumes.
- Copy an authorized scan file to a validated USB destination.
- Observe USB insertion and removal.
- Query Windows clock synchronization and NTP drift.
- Inspect Windows network interfaces used by the ESP32 subnet.
- Ensure the configured inbound firewall rule exists.

### Node ownership

Node retains application decisions and orchestration:

- Decide whether an upload is accepted, rejected, or quarantined.
- Authorize scan export and manage scan-session/customer delivery state.
- Cache trusted-time observations and decide whether financial work is allowed.
- Create trusted timestamps and financial audit records.
- Own hotspot API configuration, lifecycle state, watchdog reporting, and ESP32 HTTP/serial registration.
- Select legacy or worker backends during migration.

The guiding boundary is: Node decides what the kiosk wants to do; C# performs privileged Windows operations and reports observations.

## Migration Strategy

Use a contract-first, dormant-adapter migration.

1. Add typed worker contracts, service interfaces, compilable placeholder implementations, dependency-injection registration, and Node adapters.
2. Keep worker routing disabled independently for Defender, USB, trusted time, and networking.
3. Preserve the existing Node implementations as temporary fallbacks.
4. Allow each capability to be implemented, tested, enabled, observed, and retired independently.
5. Remove only `src/services/powershell-runspace.ts` during preparation because it has no remaining callers.

This phase does not perform the Phase 6 IPC-client consolidation. The new adapter uses the existing `worker-command-pipe.ts` transport.

## Worker Components

### Security

Create `PrintBit.Infrastructure.Windows/Security/` containing:

- `IAntivirusScanner.cs`
- `WindowsDefenderScanner.cs`
- `DefenderHealth.cs`
- `DefenderScanResult.cs`

The placeholder scanner returns a typed `NOT_IMPLEMENTED` result. A `PHASE 4 IMPLEMENTATION` comment in `WindowsDefenderScanner.cs` documents path resolution, health inspection, process timeout, exit-code mapping, detection-name parsing, logging, and cancellation requirements.

### Storage

Create `PrintBit.Infrastructure.Windows/Storage/` containing:

- `IUsbStorageService.cs`
- `UsbDriveMonitor.cs`
- `RemovableDrive.cs`
- `UsbExportResult.cs`

`UsbDriveMonitor` is both the storage abstraction and the eventual hosted monitor. Its placeholder methods return an empty drive set or a typed `NOT_IMPLEMENTED` export result and perform no background polling. The implementation comment documents WMI discovery, volume normalization, insertion/removal diffing, collision-safe filenames, and file-copy cancellation.

### Trusted time

Create `PrintBit.Infrastructure.Windows/Time/` containing:

- `ITrustedTimeProvider.cs`
- `WindowsTrustedTimeProvider.cs`
- `TrustedTimeSnapshot.cs`

The placeholder provider returns an unsynchronized `NOT_IMPLEMENTED` snapshot. The implementation comment documents Windows Time status inspection, NTP target validation, offset measurement, locale-independent parsing requirements, timeouts, and cancellation.

The C# provider reports observations only. It does not decide whether payments, refunds, or recovery operations are permitted.

### Networking

Create `PrintBit.Infrastructure.Windows/Networking/` containing:

- `IKioskNetworkPlatform.cs`
- `WindowsKioskNetworkPlatform.cs`
- `KioskNetworkSnapshot.cs`

The placeholder returns a typed `NOT_IMPLEMENTED` result. The implementation comment documents interface enumeration, preferred-subnet selection, firewall-rule inspection/creation, administrator requirements, idempotency, and structured error reporting.

C# does not contact the ESP32, publish kiosk URLs, manage Node watchdog state, or own hotspot credentials.

## IPC Contracts

Add a focused `WorkerPlatformCommands.cs` alongside the existing worker IPC contracts. Extend the strict parser and command dispatcher with:

| Command                  | Purpose                                                   | Response                                                                |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GetDefenderHealth`      | Read Defender availability and signature freshness        | Status, signature age, detail                                           |
| `ScanFileSecurity`       | Scan one authorized staged file                           | Clean/infected/unavailable/stale/timeout/failed, detection name, detail |
| `ListUsbDrives`          | List removable volumes                                    | Normalized drive records                                                |
| `ExportScanToUsb`        | Copy one authorized scan to a removable volume            | Export path, drive, or typed failure                                    |
| `GetTrustedTimeStatus`   | Observe Windows/NTP synchronization                       | Source, synchronization, offset, timestamps, detail                     |
| `PrepareHotspotPlatform` | Ensure firewall readiness and resolve the kiosk interface | Kiosk IP, firewall state, detail                                        |

Every command and response carries the incoming `requestId`. Placeholder handlers return `success: false` and `errorCode: "NOT_IMPLEMENTED"` where an operation cannot yet be performed.

Extend the worker event contract with:

- `UsbInserted`
- `UsbRemoved`
- `NetworkStatusSnapshot`

The event shapes are defined during preparation, but placeholder services emit no events. Manual implementations will publish them through the existing worker event pipe.

## Node Components

### Platform worker adapter

Create `src/services/platform-worker-client.ts`. It uses `sendWorkerRequest` and provides typed functions corresponding to the six Phase 4 commands. It contains transport and response-shape handling only; it does not contain business policy.

Extend `WorkerCommandType` and payload typing in `worker-command-pipe.ts` without restructuring the transport.

### Capability selection

Add four independent environment flags, all disabled by default:

- `PRINTBIT_WORKER_DEFENDER_ENABLED`
- `PRINTBIT_WORKER_USB_ENABLED`
- `PRINTBIT_WORKER_TRUSTED_TIME_ENABLED`
- `PRINTBIT_WORKER_NETWORKING_ENABLED`

Each existing public service API remains stable. When its worker flag is disabled, it uses the current Node mechanism. When enabled, it calls the worker adapter. During this migration phase, an unavailable transport, malformed response, or `NOT_IMPLEMENTED` response logs a warning and invokes the legacy Node mechanism.

Fallbacks must be visible in logs and must not silently reinterpret a worker result. A valid worker result, including a valid negative result such as `infected`, `unsynchronized`, or `drive not found`, is authoritative and does not trigger fallback.

### Defender seam

Keep the `DefenderScanner` interface and `createDefenderScanner()` contract used by file validation. Separate backend selection from upload policy. The current Node scanner remains the legacy backend; the worker adapter maps IPC results into the existing `DefenderHealth` and `DefenderScanResult` shapes.

### USB seam

Keep `listRemovableDrives()` and `exportScanToUsbDrive()` stable for `scanner.service.ts`. The adapter maps worker drive and export responses into the current Node types. Session authorization and scan ownership checks remain in the scanner module.

### Trusted-time seam

Keep `TrustedTimeStatus`, `getTrustedTimestamp()`, `assertTrustedTimeForFinancialOperation()`, and monitoring callbacks in Node. Only the observation performed by `verifyTrustedClockSync()` becomes backend-selectable.

The configured-offset path remains a Node test/operations override and takes precedence over either observer. Worker snapshots are mapped into the existing status cache; Node applies `PRINTBIT_TRUSTED_TIME_MAX_DRIFT_MS`, enforcement, freshness, and financial policy.

### Networking seam

Keep hotspot configuration and ESP32 registration in Node. Worker-backed hotspot startup first requests `PrepareHotspotPlatform`, stores the returned network snapshot in a small in-memory projection, and then performs existing ESP32 registration using the reported kiosk IP.

Synchronous consumers read the latest projected IP. Until a valid worker snapshot exists, the migration fallback uses the existing Node interface detection. Configuration overrides continue to take precedence.

## Safety and Validation

The scaffold establishes validation boundaries before native code is added:

- Defender file paths must be absolute and inside configured scan roots.
- USB drive identifiers must match a normalized drive-letter contract.
- USB source paths must be absolute and inside configured scan roots.
- USB destinations are derived by the worker, never supplied as arbitrary paths by Node.
- NTP targets accept only the restricted hostname/address format already used by Node.
- Network subnet prefixes and ports are validated.
- Firewall rule names and allowed ports come from worker configuration, not arbitrary IPC input.
- Existing command-pipe ACLs, maximum message size, newline framing, strict command parsing, and request correlation remain unchanged.
- No general-purpose shell, PowerShell, or command-execution IPC endpoint is introduced.

The dispatcher catches service exceptions, logs through `ILogger<T>`, and returns typed failures without terminating the hosted listener.

## Manual Implementation Markers

Each of the four C# implementation classes contains one structured `PHASE 4 IMPLEMENTATION` block describing:

- Required inputs and validated assumptions
- Expected success and error mappings
- Timeout and cancellation behavior
- Logging expectations
- Platform edge cases
- Tests that must be enabled or extended before cutover

The placeholders use safe return values instead of `throw new NotImplementedException()`. This keeps the worker buildable and prevents accidental host termination.

## Testing Strategy

### Worker tests

Add green scaffold tests for:

- Strict parsing of all six command types
- Rejection of invalid or oversized inputs
- JSON response property names and request correlation
- Dependency-injection registration of all four platform services
- Safe placeholder outcomes
- Event-type serialization for USB and network events

These tests verify scaffolding and contracts, not native Windows behavior.

### Node tests

Add or extend tests for:

- Default selection of each legacy backend
- Worker selection when a capability flag is enabled
- Fallback after transport failure, malformed response, or `NOT_IMPLEMENTED`
- No fallback for valid authoritative negative results
- Stable public Defender, USB, trusted-time, and hotspot contracts
- Network snapshot projection and configured-IP precedence

Existing Defender and middleware tests must continue to pass without flag changes.

### Verification commands

Run:

```text
dotnet test ../printbit-worker/printbit-worker.slnx --no-restore
dotnet build ../printbit-worker/printbit-worker.slnx --no-restore
pnpm test -- --runInBand
pnpm run lint
pnpm run build
git -C ../printbit-worker diff --check
git diff --check
graphify update .
```

## Completion Criteria

Preparation is complete when:

1. Both repositories build and their existing test suites pass.
2. All Phase 4 IPC contracts round-trip with stable JSON shapes.
3. All four C# implementation classes are registered and return safe placeholder results.
4. All four Node worker paths are independently selectable but disabled by default.
5. Current kiosk behavior remains unchanged with default configuration.
6. Worker failures visibly fall back to legacy Node mechanisms during migration.
7. `powershell-runspace.ts` is deleted with no remaining imports.
8. No native Defender, WMI USB, trusted-time, or firewall implementation has been written; those method bodies remain ready for manual coding.
9. Both repositories' `AGENTS.md` files are updated if their documented contracts, configuration, DI, or tests change.

## Deferred Work

The following work is explicitly outside this preparation:

- Implementing the native Windows behavior in the four C# classes
- Enabling worker flags in production
- Retiring `defender-scanner.ts`, `usb-drives.ts`, or the legacy observation portions of `time-source.ts` and `hotspot.ts`
- Removing migration fallback behavior
- Consolidating all named-pipe clients into the Phase 6 `WorkerClient`
- Changing upload, quarantine, scan authorization, financial, or ESP32 registration policy
