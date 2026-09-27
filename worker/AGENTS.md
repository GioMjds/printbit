# AGENTS.md - PrintBit Hardware Service

> This file is the authoritative brief for any AI coding agent working in this repository.
> Read it in full before making any change. Update it before closing any task that modifies
> what this file documents. See [Section 7: Self-Maintenance Rules](#7-self-maintenance-rules).

---

## Table of Contents

1. [Project Identity & Domain Context](#1-project-identity--domain-context)
2. [Hardware Architecture Brief](#2-hardware-architecture-brief)
3. [Codebase Orientation](#3-codebase-orientation)
4. [State Machine Contract](#4-state-machine-contract)
5. [Agent Behavioral Rules](#5-agent-behavioral-rules)
6. [Edge Cases & Hardware Constraints](#6-edge-cases--hardware-constraints)
7. [Self-Maintenance Rules](#7-self-maintenance-rules)

---

## 1. Project Identity & Domain Context

**PrintBit** is a coin-operated self-service printing kiosk deployed on a Windows tablet in campus/institutional environments. This repository (`PrintBit.HardwareService`) is the .NET 10 Windows Service Worker focused on printer spooler orchestration and logging error messages from the Node.js app via named pipe.

### What this service is NOT

- It is **not a web API**. There are no HTTP controllers and no REST endpoints.
- It does **not** handle ESP32 coin/hopper hardware at runtime (printer-only mode).

### What this service IS

- A **printer bridge**: watches a print queue and dispatches print jobs through the Windows spooler.
- A **Windows Service**: startup/shutdown sequencing matters.
- An **IPC sink**: logs error messages sent from the Node.js app over a named pipe.
- An **IPC source**: emits print lifecycle events to the Node.js app over a named pipe.

### Why normal assumptions break here

| Assumption | Reality in PrintBit |
|---|---|
| Services can be scoped per request | Printer services are singleton; scoped/transient lifetimes can break job serialization. |
| I/O failures are retryable | Spooler failures are not auto-recovered; log and investigate. |
| Timeout can be tuned freely | 2-minute print timeout exists for slow Sumatra cold starts on tablets. |
| State lives in a database | Print pipeline state is in-memory only. |
| Logging is optional | Printer debugging depends on logs for print outcomes and Node error payloads. |

---

## 2. Hardware Architecture Brief

ESP32/coin/hopper paths are currently **not wired in the printer-only runtime**. The details below are retained for legacy context.

### Physical Wiring Overview

```
[Coin Acceptor]
  -> pulse signal on GPIO pin -> ESP32
        -> ESP32 maps pulse counts to denomination
        -> sends "COIN:<value>" via UART -> USB serial -> tablet

[Hopper]
  -> GPIO controlled by ESP32
        -> ESP32 receives "HOPPER_DISPENSE" from service
        -> sends "HOPPER:DONE" when dispense completes

[Epson L5290 Printer]
  -> USB to tablet
        -> dispatched via SumatraPDF.exe process
```

### ESP32 Role

ESP32 handles:
- Coin pulse debouncing (do not duplicate this in C#)
- Pulse-to-denomination mapping
- Hopper GPIO control
- `PING` keepalive messages

ESP32 does not handle pricing logic, file paths, or print lifecycle semantics.

### Serial Connection

| Property | Value |
|---|---|
| Default port | `COM3` (`HardwareSettings.Esp32Port`) |
| Baud rate | `115200` (`HardwareSettings.Esp32BaudRate`) |
| Protocol | Line-delimited ASCII (`ReadLine()` / `WriteLine()`) |
| Framing | No checksum, no ACK |

### Inbound Messages (ESP32 -> Service)

| Raw Message | `Esp32MessageType` | `Value` | Meaning |
|---|---|---|---|
| `COIN:<int>` | `CoinInserted` | denomination integer | Coin inserted |
| `HOPPER:DONE` | `HopperCompleted` | null | Hopper completed |
| `PING` | `Heartbeat` | null | ESP32 keepalive |
| anything else | `Unknown` | null | Logged and ignored |

### Outbound Commands (Service -> ESP32)

Defined in `Esp32Command`:

| Constant | Value | When to send |
|---|---|---|
| `Esp32Command.Ping` | `"PONG"` | On heartbeat receive |
| `Esp32Command.HopperDispense` | `"HOPPER_DISPENSE"` | When dispensing change |
| `Esp32Command.PrinterStart` | `"PRINTER_START"` | When print begins |
| `Esp32Command.PrinterComplete` | `"PRINTER_COMPLETE"` | On verified print success |

### Epson L5290 Print Dispatch

`JobOrchestrator` submits the prepared PDF sequentially copy-by-copy (`copies = 1` per dispatch):

```
SumatraPDF.exe -print-to "<printerName>" -print-settings "1x,<color|monochrome>,<pages>,paper=<size>,<portrait|landscape>,noscale,ignore-pdf-print-settings,collate" -silent "<filePath>"
```

Critical constraints:
- `SumatraPDF.exe` path comes from `HardwareSettings.SumatraPath` (default `C:\Users\printbit\bin\SumatraPDF.exe`).
- The physical printer identity comes from `HardwareSettings.PrinterName`; it is used for health monitoring and must exactly match Windows registration.
- The dispatch queue comes from `HardwareSettings.PrinterProfiles`: quality and orientation select `Standard`, `StandardLandscape`, `High`, or `HighLandscape`; Standard portrait falls back to `PrinterName`.
- Requested copies are dispatched sequentially copy-by-copy; the prepared PDF is reused across copies without redundant re-preprocessing. This provides granular per-copy progress, preflight health checks before each copy, and deterministic refund accounting on partial failures.
- Page selection and rotation are baked into the prepared PDF. `PrintJobSettings.Scaling` defaults to `fit`; `PrintLayout` fits once inside a 14.4 pt application inset on the selected A4/Letter/Legal target. Prepared dispatch uses `actual` (`noscale` in Sumatra) to avoid a second shrink. Direct unprepared dispatch still defaults to `fit`.
- Color, target paper, orientation, collation and `ignore-pdf-print-settings` are explicit Sumatra arguments. Paper orientation and quality also depend on the selected logical queue's Epson defaults. Driver Reduce/Enlarge must stay off; the application inset is not measured printer-margin data.
- Print jobs are serialized via `SemaphoreSlim(1, 1)` inside `DocumentPrinter`.
- Before dispatch, `JobOrchestrator` waits up to `PauseTimeoutMinutes` for `PrinterHealthMonitor.IsHealthy` to return true.
- Print quality is supplied by fixed Windows logical queues whose system-wide Epson Printing Defaults are preconfigured as Standard or High. `DocumentPrinter` does not mutate global `DEVMODE` settings per job.
- Timeout is 2 minutes (`HardwareSettings.PrintTimeoutSeconds = 120`), scaled dynamically for multi-page jobs (`Math.Max(PrintTimeoutSeconds, expectedPages * 90)` seconds).
- Exit code `0` is not enough: service also verifies spooler lifecycle (`Win32_PrintJob`) before returning success.
- Spooler verification inspects `Win32_PrintJob.StatusMask` for error, offline, paper-out, blocked-queue, and user-intervention flags, and checks `PrinterHealthMonitor` for fatal hardware errors.
- A spooler or hardware error pauses the same job for up to `PauseTimeoutMinutes`; recovery resumes it without submitting a replacement job.
- The expected page count is computed up front by `PdfPageCounter`, which parses the original PDF and falls back to `qpdf --show-npages` for compressed streams. qpdf is not used to split pages.
- `Win32_PrintJob.PagesPrinted` is captured as best-effort progress. It may remain zero or lag behind physical output.
- Active spooler jobs are polled every 500 ms so available progress reaches Node promptly.
- While a spooler job is actively printing without error (`!jobHasError && !fatalMonitorError && !isDeleting`), the verification deadline is continuously refreshed up to the document's active print deadline, preventing false timeouts when `PagesPrinted` does not increment while physical printing proceeds normally.
- When a cleared job's last positive `TotalPages` is lower than the selected-page count, verification fails with `PrintFailureStage.IncompleteOutput`.
- After each copy clears, `DocumentPrinter` keeps the configured 12-second post-clear hardware guard window before returning success.
- Page counts from WMI are unreliable and can lag behind job completion. If the job has cleared and the printer is completely healthy, the print is treated as a success even if the last polled page count was less than expected, provided the last polled spooler `TotalPages` is not less than the expected page count (a lower `TotalPages` indicates a truncated or aborted job).
- `PrinterHealthMonitor` checks WMI `DetectedErrorState`, `ExtendedPrinterStatus`, Epson popups, and WinSpool status, treating fatal codes (e.g. Paper Out code 4, Jam code 8, Door Open code 7) as fatal errors exposed via `IsHealthy` and `HasFatalHardwareError`.
- Hardware errors return `PrintFailureStage.HardwareError`; no spooler recovery is triggered for hardware errors.
- Any process or verification failure returns `Success = false` with stage detail.
- When verification fails, any matching print jobs in the Windows spooler queue are automatically cancelled/deleted via WMI to clear the printer's hardware queue and prevent subsequent jobs from being blocked.
- `JobOrchestrator` emits `PrintSucceeded` only after every requested copy completes. Partial or terminal failures emit `PrintFailed` with page/copy results and move the source PDF and sidecar to `failed/`.

### Named Pipe (Node Error Intake)

`ErrorPipeHostedService` listens on a named pipe and logs **line-delimited JSON** error messages from the Node.js app.

| Field | Required | Notes |
|---|---|---|
| `message` | Yes | Error message to log |
| `code` | No | Optional error code |
| `source` | No | Source identifier (e.g., kiosk UI) |
| `transactionId` | No | Optional transaction identifier for correlation |
| `spoolerCorrelationKey` | No | Optional spooler correlation key |
| `stack` | No | Optional stack trace |
| `timestampUtc` | No | ISO-8601 timestamp |

### Named Pipe (Service -> Node Return Pipe)

`WorkerEventPipeClient` connects to the Node return pipe and sends **line-delimited JSON** print events.

| Field | Required | Notes |
|---|---|---|
| `type` | Yes | `PrintStarted`, `PrintProgress`, `PrintSucceeded`, `PrintFailed`, `PrinterOffline`, `PrinterOnline`, or `PrinterError` |
| `transactionId` | No | Parsed from queue file name |
| `spoolerCorrelationKey` | No | Parsed from queue file name |
| `fileName` | No | Queue file name |
| `printerName` | No | Printer display name |
| `failureStage` | No | `PrintFailureStage` string when failed; `hardware_error` for `PrinterError` |
| `message` | No | Success summary or failure detail |
| `pagesPrinted` | No | Completed logical pages across copies; emitted live by `PrintProgress` and best effort on failure |
| `totalPages` | No | Total selected pages across copies on progress and terminal events |
| `pageCountConfidence` | No | `confirmed`, `best_effort`, or `unknown` |
| `pages` | No | Per-page/copy terminal states (`completed`, `failed`, or `cancelled`) |
| `timestampUtc` | Yes | ISO-8601 timestamp |

Printer monitor events use the same line-delimited JSON pipe. `PrinterError`
carries `failureStage = "hardware_error"` and a human-readable `message`
describing the detected error code. `PrinterOffline` / `PrinterOnline` are
emitted on the WMI `WorkOffline` state change. `PrinterOnline` is also emitted
when a previously reported hardware error clears while the configured printer
queue remains present, so Node can leave its error projection without a USB
replug. Additionally, `PrinterHealthMonitor` publishes periodic `PrinterStatusSnapshot`
heartbeats (every 15s) so the Node service syncs online/offline status promptly
whenever Node restarts without waiting for an error or USB state change.

### Named Pipe (Node -> Service Command Pipe)

`WorkerCommandPipeHostedService` listens on `IpcSettings.WorkerCommandPipeName` (`printbit-worker-commands`) and handles **line-delimited JSON** recovery and hardware commands from the administrative Node.js service.

Each connection receives one JSON line, dispatches one command, writes one single-line command-specific JSON response, flushes, and closes.

| Command Request Field | Required | Notes |
|---|---|---|
| `requestId` | Yes | Non-empty correlation identifier preserved in response |
| `type` | Yes | `GetPrinterRecoveryStatus`, `AttemptPrinterRecovery`, or a supported hardware command such as `SimulateCoin` |
| `timestampUtc` | No | ISO-8601 timestamp |

`SimulateCoin` additionally requires an accepted `coinValue` (`1`, `5`, `10`, or `20`) and `HardwareSettings:EnableCoinSimulation = true`. It injects a simulated `CoinInserted` return event without touching the serial coin acceptor, so physical coin-slot session locks do not reject the administrator's simulation.

Recovery commands return a `PrinterRecoveryResult` with the following fields:

| Recovery Response Field | Required | Notes |
|---|---|---|
| `requestId` | Yes | Matches request `requestId` |
| `type` | Yes | `GetPrinterRecoveryStatus` or `AttemptPrinterRecovery` |
| `outcome` | Yes | `healthy`, `recovered`, `manual_intervention_required`, `worker_busy`, `restart_failed`, or `invalid_request` |
| `action` | No | Executed repair action (e.g., `RestartSpooler` or null) |
| `spoolerState` | No | Spooler service status snapshot: `{ "isRunning": bool, "status": string, "errorMessage": string? }` |
| `printerState` | No | Typed printer state (`Healthy`, `Offline`, `Fault`, etc.) |
| `issueKind` | No | Typed issue classification (`None`, `PhysicalFault`, `WindowsQueueFault`) |
| `message` | No | User-safe explanation or error message |
| `startedAt` | Yes | UTC timestamp when request handling started |
| `completedAt` | Yes | UTC timestamp when request handling finished |

Hardware commands return command-specific response payloads. `SimulateCoin` returns a `HardwareCommandResponse`: `requestId` and `type` echo the request, `success` reports whether the simulated event was delivered, and `errorCode` / `message` describe disabled simulation or return-pipe delivery failures.

#### Command Outcome Mapping

| Outcome | Trigger Condition | Spooler Restarted? | Action Value | Meaning |
|---|---|---|---|---|
| `healthy` | Spooler running and printer diagnostic is healthy | No | `null` | Kiosk printer ready for printing. |
| `recovered` | Windows-side fault detected, Spooler restart succeeded, and printer diagnostic rechecked healthy within deadline | Yes | `"RestartSpooler"` | Printer restored to healthy operation. |
| `manual_intervention_required` | Physical printer error detected before or after restart (paper out, jam, door open, ink empty, service required, or Epson popup dialog) | No / Yes (if detected after) | `null` | Physical fault requires staff intervention. |
| `worker_busy` | Recovery lease cannot be acquired because an active print job or another recovery operation holds the lease | No | `null` | Active print protected; Node retries after print completes. |
| `restart_failed` | Spooler service failed to stop/start within timeout (30s), transition errored, or final recheck timed out without health | Yes | `"RestartSpooler"` | Spooler restart failed to clear fault. |
| `invalid_request` | Malformed JSON, payload > 8192 bytes, unknown command type, or missing required fields (`requestId`) | No | `null` | Client request rejected before processing. |

#### No-Job-Operation Policy

- Recovery does **not** cancel, delete, or modify spooler print jobs.
- Recovery does **not** purge spool files (`*.spl` / `*.shd`) from Windows system directories.
- Recovery does **not** reset PnP USB devices.
- Recovery does **not** launch Epson utilities or kill printer/spooler processes (`taskkill`).
- Automatic destructive recovery on print timeouts has been completely removed from `JobOrchestrator` and `PrinterHealthMonitor`.

#### Node Handoff Contract

The administrative Node.js service must satisfy the following operational contract:
- **Administrative Connection**: The Node client process must run as LocalSystem or as the exact account/SID configured by `IpcSettings.WorkerCommandAllowedClientIdentity`; `BUILTIN\Administrators` remains an allowed maintenance identity.
- **Response Timeout Deadline (>= 45s)**: The maximum duration of a worker recovery cycle is bounded by `SpoolerTransitionTimeoutSeconds` (30s) + `HealthRecheckTimeoutSeconds` (10s) + overhead (~5s). The Node client must configure an I/O response deadline of at least **45 seconds** before timing out the connection.
- **Audit & History Persistence**: Because the C# worker is stateless, the Node service is solely responsible for recording recovery attempts, timestamps, request IDs, and outcomes into durable disk-backed logs or a database for technician auditing.
- **Transaction Gating**: Node must keep customer transactions blocked (preventing coin acceptance / UI print flow) while printer status is unhealthy or while recovery is in flight, until a `healthy` or `recovered` outcome is received.

### Cross-Windows-Identity DACL

The kiosk runs the C# worker as `LocalSystem` and the Node service from an
Administrator PowerShell as `desktop-jhtg0bm\admin`. The worker needs no
per-user password or interactive sign-in, which keeps it available while
Windows Assigned Access restricts the kiosk account.

- **Node return pipe** (`printbit-worker-events`): the server binds with
  `readableAll: true, writableAll: true` (libuv `uv_pipe_chmod`), which
  sets a permissive DACL. This is the only DACL knob Node's `net` API
  exposes; see
  `src/services/worker-return-pipe.ts` `server.listen({ ... })`.
- **C# error pipe** (`printbit-node-errors`): the C# worker runs as
  `LocalSystem`, while the Node `admin` user is in
  `BUILTIN\Administrators`. The default DACL on a system-created pipe grants
  `Administrators` access, so the `admin` client can connect without
  any code change. `.NET 10`'s `NamedPipeServerStream` no longer
  exposes a public `PipeSecurity` constructor, so a more restrictive
  C# deployment would need P/Invoke to `SetSecurityInfo` on
  `SafePipeHandle`.
- **C# document conversion pipe** (`printbit-document-conversion`): Created using
  `NamedPipeServerFactory.Create` with Windows ACL granting `FullControl` to current identity,
  `ReadWrite | CreateNewInstance` to `AuthenticatedUserSid`, and `ReadWrite` to `WorldSid`.
  Uses a replacement-server listener pattern (`MaxAllowedServerInstances`) so the pipe
  remains continuously available during conversions without dropping connection attempts.
- **C# worker command pipe** (`printbit-worker-commands`): Created using
  `NamedPipeServerStreamAcl.Create` with strict Windows `PipeSecurity` configured
  via `WorkerCommandPipeSecurity`. Grants `FullControl` to current service identity
  and `LocalSystemSid`, `ReadWrite` to `BuiltinAdministratorsSid`, and optionally
  `ReadWrite` to the exact SID/account in `IpcSettings.WorkerCommandAllowedClientIdentity`.
  Invalid identities and broad principals (`WorldSid` / Everyone and
  `AuthenticatedUserSid`) are rejected; they are never silently widened.

The command listener creates a replacement server instance before dispatching an
accepted client and tracks handlers behind `WorkerCommandMaxConcurrency` (default
4). Client parse/I/O failures are isolated and do not stop the accept loop. The
worker acquires `IpcSettings.WorkerInstanceLockName` (`Global\PrintBitHardwareWorker`)
before host startup; a duplicate executable exits with code 2.

If the kiosk is re-deployed with the two processes under the same identity,
the cross-identity DACL considerations become inert (the default DACL is
sufficient).

---

## 3. Codebase Orientation

### Solution Structure

```
PrintBit.HardwareService   <- Host and background services
PrintBit.Application       <- State machine, handlers, orchestration, queue
PrintBit.Hardware          <- ESP32 abstractions and message parsing
PrintBit.Infrastructure    <- Serial, print, IPC, watchdog implementations
PrintBit.Shared            <- Enums and configuration models
```

Dependency direction:
`HardwareService` -> `Application` -> `Hardware` / `Infrastructure` -> `Shared`

### Key Classes & Responsibilities

| Class | Project | Responsibility |
|---|---|---|
| `PrintQueueWatcher` | HardwareService | Watches queue directory, delegates to `IJobOrchestrator`, and cleans up sidecar files |
| `ErrorPipeHostedService` | HardwareService | Reads Node.js error messages from named pipe and logs them |
| `PrinterHealthMonitor` | Infrastructure.Windows | Background service and unified monitor for printer status, Epson popup checks, offline status, and read-only typed health diagnostics (`GetDiagnostic`) |
| `DocumentPrinter` | Infrastructure | Quality-profile Sumatra dispatch and spooler verification for one whole-document copy, with progress telemetry, patience mode, post-clear guard, and print lock |
| `PrinterProfileResolver` | Infrastructure | Strictly maps `standard` and `high` job values to configured logical printer queues; High fails validation when its profile is absent |
| `IPrinterRecoveryService` / `PrinterRecoveryService` | Infrastructure / Infrastructure.Windows | Printer recovery service orchestrating typed diagnostics, physical fault avoidance, and bounded native Spooler restart |
| `IPrintSpoolerController` / `ServiceControllerSpoolerController` | Infrastructure.Windows | Native Windows ServiceController implementation managing Spooler service status and clean restarts |
| `IPrinterOperationCoordinator` | Infrastructure | Recovery contract and exclusive print/recovery lease gate; registered as singleton `PrintOperationCoordinator` in `Program.cs` |
| `WorkerCommandPipeHostedService` | HardwareService | Replacement-listener background service accepting up to `WorkerCommandMaxConcurrency` recovery/hardware clients and writing single-line JSON responses |
| `WorkerCommandPipeSecurity` | Infrastructure.IPC | Factory for strict Windows ACLs granting system/admin plus one configured client SID |
| `WorkerInstanceLock` | HardwareService | Machine-wide mutex that prevents service/debug duplicate ownership |
| `WorkerCommandParser` | Infrastructure.IPC | Strict command deserializer with byte-limit protection, enum validation, and `RequestId` preservation |
| `JobOrchestrator` | Infrastructure | Preprocesses source geometry, coordinates exclusive execution with recovery via `IPrinterOperationCoordinator`, dispatches print jobs sequentially copy-by-copy, maps progress to page/copy results, and emits lifecycle events |
| `DocumentPreprocessor` | Infrastructure | Selects pages, normalizes PDF orientation and rotation, pads odd duplex jobs, rasterizes supported images, and cleans temporary prepared PDFs before printer dispatch |
| `PrintJobSettings` | Infrastructure | Print job configuration model (copies, color, quality (`"standard"` / `"high"`), page range, orientation, rotation, paper size, scaling (`"fit"` default / `"actual"`)) |
| `PrintLayout` | Infrastructure | Shared-contract target geometry and aspect-preserving Fit inset; mirrored by Node `src/shared/print-configuration.ts` |

Legacy ESP32/orchestrator classes were removed when the runtime committed to
printer-only mode. The DI container hosts background services (`PrintQueueWatcher`,
`ErrorPipeHostedService`, `PrinterHealthMonitor`, `PowerMonitorService`, and `WorkerCommandPipeHostedService`).

### DI Registration (Program.cs)

All hardware services are singleton.

```csharp
builder.Services.Configure<HardwareSettings>(
    builder.Configuration.GetSection("HardwareSettings"));
builder.Services.Configure<IpcSettings>(
    builder.Configuration.GetSection("IpcSettings"));
builder.Services.Configure<DocumentConversionSettings>(
    builder.Configuration.GetSection("DocumentConversionSettings"));
builder.Services.Configure<PowerSettings>(
    builder.Configuration.GetSection("PowerSettings"));
builder.Services.Configure<PrinterRecoverySettings>(
    builder.Configuration.GetSection("PrinterRecoverySettings"));

builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "PrintBitHardware";
});

builder.Services.AddHostedService<ErrorPipeHostedService>();
builder.Services.AddSingleton<IDocumentConversionService, LibreOfficeDocumentConversionService>();
builder.Services.AddHostedService<DocumentConversionPipeHostedService>();
builder.Services.AddSingleton<IDocumentPreprocessor, DocumentPreprocessor>();

// Printer monitoring and whole-document spooler dispatch
builder.Services.AddSingleton<PrinterHealthMonitor>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<PrinterHealthMonitor>());
builder.Services.AddSingleton<IPrinterHealthMonitor>(sp => sp.GetRequiredService<PrinterHealthMonitor>());

// Printer recovery control plane
builder.Services.AddSingleton<IPrinterOperationCoordinator, PrintOperationCoordinator>();
builder.Services.AddSingleton<IPrintSpoolerController, ServiceControllerSpoolerController>();
builder.Services.AddSingleton<IPrinterRecoveryService, PrinterRecoveryService>();
builder.Services.AddHostedService<WorkerCommandPipeHostedService>();

// Power monitoring and dispatch safety gate
builder.Services.AddSingleton<IPowerStatusProvider, NativePowerStatusProvider>();
builder.Services.AddSingleton<IPowerSafetyGate, PowerSafetyGate>();
builder.Services.AddSingleton<PowerMonitorService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<PowerMonitorService>());

builder.Services.AddSingleton<IDocumentPrinter, DocumentPrinter>();
builder.Services.AddSingleton<IJobOrchestrator, JobOrchestrator>();
builder.Services.AddHostedService<PrintQueueWatcher>();

builder.Services.AddSingleton<WorkerEventPipeClient>();
builder.Services.AddSingleton<IWorkerEventPipeClient>(
    sp => sp.GetRequiredService<WorkerEventPipeClient>());
```

### Configuration

Bound from `appsettings.json` via `IOptions<HardwareSettings>`:

```json
{
  "HardwareSettings": {
    "Esp32Port": "COM3",
    "Esp32BaudRate": 115200,
    "PrintTimeoutSeconds": 120,
    "PrinterName": "EPSON L5290 Series",
    "PrinterProfiles": {
      "Standard": "EPSON L5290 Series",
      "High": "PrintBit - High",
      "StandardLandscape": "PrintBit - Landscape",
      "HighLandscape": "PrintBit - High - Landscape"
    },
    "PrintQueueDirectory": "C:\\Users\\printbit\\printbit-worker\\queue",
    "FailedDirectory": "C:\\Users\\printbit\\printbit-worker\\failed",
    "SumatraPath": "C:\\Users\\printbit\\bin\\SumatraPDF.exe",
    "QpdfPath": "C:\\Program Files\\qpdf 12.3.2\\bin\\qpdf.exe",
    "PauseTimeoutMinutes": 15,
    "PostClearGuardDelaySeconds": 3
  },
  "IpcSettings": {
    "PipeName": "printbit-node-errors",
    "MaxMessageBytes": 8192,
    "WorkerReturnPipeName": "printbit-worker-events",
    "WorkerCommandPipeName": "printbit-worker-commands",
    "WorkerCommandMaxConcurrency": 4,
    "WorkerCommandAllowedClientIdentity": null,
    "WorkerInstanceLockName": "Global\\PrintBitHardwareWorker"
  },
  "PrinterRecoverySettings": {
    "ServiceName": "Spooler",
    "SpoolerTransitionTimeoutSeconds": 30,
    "HealthRecheckTimeoutSeconds": 10,
    "HealthRecheckIntervalSeconds": 2
  }
  ,"DocumentConversionSettings": {
    "SofficePath": "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "DefaultTimeoutSeconds": 60,
    "PipeName": "printbit-document-conversion",
    "UserProfileDirectory": "C:\\ProgramData\\PrintBit\\lo-profile",
    "DefaultOutputDirectory": "C:\\ProgramData\\PrintBit\\converted"
  }
}
```

### Queue Design

`HardwareEventQueue` remains in the codebase for the legacy ESP32 path but is not used by the printer-only runtime.

---

## 4. State Machine Contract

`TransactionStateMachine` is the single source of truth for transaction state.

Printer-only runtime note: the transaction state machine is not wired in the current service host.

### State Diagram

```
Idle -> Pending -> ReadyToPrint -> Printing -> Verifying -> Success
  \                                               \
   \-> (failure from non-terminal state) ---------> Failed

Reset() from any state -> Idle
```

### Transition Rules

| Method | Valid From | Transitions To | Side Effects |
|---|---|---|---|
| `TryInsertCoin(amount)` | `Idle`, `Pending` | `Pending` or `ReadyToPrint` | Adds `CurrentBalance` |
| `TryStartPrinting()` | `ReadyToPrint` | `Printing` | Clears failure reason |
| `TryStartVerifying()` | `Printing` | `Verifying` | None |
| `TryMarkSuccess()` | `Verifying` | `Success` | Clears failure reason |
| `TryMarkFailed(reason)` | any non-terminal state | `Failed` | Sets `LastFailureReason` |
| `Reset()` | any state | `Idle` | Clears balance and failure reason |

### Lifecycle Constraints

- Start print only when `CurrentState == ReadyToPrint`.
- `HardwareOrchestrator` is the gate for all starts (ESP32 path and queue watcher path).
- Failed transactions remain in `Failed` until explicit reset (`PipeMessageType.ResetTransactionRequest`).
- Invalid transitions are rejected and logged.

### Payment Threshold

`balance >= 5` is hardcoded in `TryInsertCoin()`. Do not parameterize without explicit task.

---

## 5. Agent Behavioral Rules

### Agent MAY

- Extend `HardwareOrchestrator` routing for new message types.
- Add values to `Esp32MessageType` and update parser/docs.
- Add `Esp32Command` constants and update docs.
- Extend active non-stub classes.
- Add/extend tests for `TransactionStateMachine`, handlers, orchestrator gating, IPC reset, administrator coin simulation, whole-document dispatch, page-count confidence, print verification behavior, Epson popup event propagation, printer pre-flight/recovery status checking, and bounded native spooler recovery.
- Add new `IOptions<T>` config models in `PrintBit.Shared`.
- Extend `HardwareSettings` and sync docs.

### Agent MUST NOT

- Remove or bypass `SemaphoreSlim(1, 1)` in `DocumentPrinter`.
- Reduce the 2-minute print timeout.
- Hardcode serial settings, printer name, or paths when config is available.
- Register hardware services as scoped/transient.
- Use `Console.WriteLine`; use `ILogger<T>`.
- Reverse project dependency direction.
- Add `Infrastructure -> Application` references.
- Implement coin dedup/debounce logic in C#.
- Change channel options without explicit backpressure analysis.

### Stub Policy - Propose Only

Do not implement the following files with compilable code. Use structured proposal comments only.

Stub files:
- `PrintBit.Hardware/Devices/CoinAcceptor/CoinAcceptorDevice.cs`
- `PrintBit.Hardware/Devices/CoinAcceptor/ICoinAcceptor.cs`
- `PrintBit.Hardware/Devices/CoinAcceptor/CoinPulseEvent.cs`
- `PrintBit.Hardware/Devices/Hopper/HopperDevice.cs`
- `PrintBit.Hardware/Devices/Hopper/IHopper.cs`
- `PrintBit.Hardware/Devices/Printer/EpsonPrinterDevice.cs`
- `PrintBit.Hardware/Devices/Printer/IPrinterDevice.cs`
- `PrintBit.Hardware/StateMachine/HardwareStateMachine.cs`
- `PrintBit.Hardware/StateMachine/PrintJobStateMachine.cs`
- `PrintBit.Infrastructure/Services/IPC/NamedPipeServer.cs`
- `PrintBit.Infrastructure/Services/IPC/SocketServer.cs`
- `PrintBit.Infrastructure/Services/IPC/MessageDispatcher.cs`
- `PrintBit.Infrastructure/Services/TransactionService/TransactionService.cs`
- `PrintBit.Infrastructure/Services/PrintService/GhostScriptRunner.cs`
- `PrintBit.Shared/Models/TransactionDto.cs`
- `PrintBit.Shared/Models/HardwareStatusDto.cs`
- `PrintBit.Shared/Models/PrinterStatusDto.cs`
- `PrintBit.Shared/Models/Esp32MessageDto.cs`
- `PrintBit.Shared/Enums/HardwareState.cs`
- `PrintBit.Shared/Enums/PrinterState.cs`
- `PrintBit.Shared/Constants/HardwareConstants.cs`
- `PrintBit.Application/Handlers/HopperDispenseHandler.cs`
- `PrintBit.Application/Handlers/PrintCompletedHandler.cs`
- `PrintBit.Application/Events/HardwareHeartbeatEvent.cs`

Proposal comment format:

```csharp
// AGENT PROPOSAL:
// Interface suggestion:
//   Task DispenseAsync(int coins, CancellationToken ct = default);
//   event EventHandler<HopperCompletedEvent>? DispenseCompleted;
//
// Implementation notes:
//   - Send Esp32Command.HopperDispense via IEsp32Device.SendCommand()
//   - Await HopperCompleted message via HardwareEventQueue (or dedicated channel)
//   - Register as Singleton in Program.cs
//   - Wire into HardwareOrchestrator after CoinInserted path
//
// Depends on: IEsp32Device, HardwareEventQueue
// Blocks: DispensingChange state in TransactionStateMachine
```

---

## 6. Edge Cases & Hardware Constraints

ESP32/coin/hopper constraints below are legacy context and not used in the current printer-only runtime.

### Coin Acceptor

- Debounce is done by ESP32.
- Coin value is integer (`Esp32Message.Value`), converted to decimal in state machine path.
- Rapid insertion is valid; queue burst handling is intentional.

### Hopper

- `HOPPER:DONE` can be delayed or missed across reconnect scenarios.
- Hopper completion handling must be idempotent when implemented.

### Serial

- Reconnection is not implemented.
- `ReadLine()` is blocking on serial callback thread; keep event path lightweight.

### Print Pipeline

- Sumatra cold-start may take 15-30 seconds.
- Exact printer-name matching is required.
- Standard/High and portrait/landscape combinations use four logical queues for the same physical printer. Quality and paper orientation come from each queue's saved system-wide Epson Printing Defaults, not Sumatra content-orientation options or a generic DPI/`DEVMODE` mapping.
- Spooler tracking and cancellation use the selected logical queue; physical health checks continue to use `HardwareSettings.PrinterName`.
- The prepared PDF is submitted sequentially copy-by-copy with `copies = 1` per dispatch, ensuring accurate copy-level progress and refund accounting.
- `JobOrchestrator` preprocesses queued sources before dispatch. Page selection, native plus explicit rotation, target geometry, Fit/Actual scaling, image rasterization, and duplex padding are baked into a temporary PDF; color and printer-profile selection remain driver settings. Prepared dispatch uses `noscale` and suppresses embedded PDF print preferences.
- PDF preparation uses the visible CropBox/MediaBox intersection, preserving its origin and applying native rotation once. Image Fit preserves pixel aspect ratio regardless of unequal X/Y DPI tags. Internal image Actual uses one pixel per PDF point, not metadata physical size.
- A4 (595.28 x 841.89 pt), Letter (612 x 792 pt) and Legal (612 x 1008 pt) remain distinct physical targets. Staff must load matching stock. The 14.4 pt safety inset and all four profile defaults require physical Epson acceptance testing.
- Print execution is single-job serialized (`SemaphoreSlim(1, 1)` in `DocumentPrinter`).
- Success requires both process success and spooler lifecycle verification.
- Spooler verification checks `Win32_PrintJob.StatusMask` for error, offline, paper-out, blocked-queue, and user-intervention flags and checks `PrinterHealthMonitor` for fatal hardware errors. Hardware errors return `PrintFailureStage.HardwareError` without triggering spooler recovery. An actively printing spooler job without errors extends the verification deadline up to the document's active print deadline, ensuring slow or multi-page output does not trigger false timeouts due to WMI `PagesPrinted` update lag.
- Upon any spooler verification failure, matching print jobs are programmatically cancelled from the Windows spooler queue (via WMI) to ensure the printer queue remains clean.
- `DocumentPrinter` enforces one configured 12-second post-clear guard window per copy to detect delayed Epson popup/hardware faults.
- If the spooler job clears and the printer is completely healthy (no error reported via WMI, Epson popups, or direct WinSpool checks), the print is treated as a success regardless of WMI page count reporting lag, provided the last polled spooler `TotalPages` is not less than the expected page count (a lower `TotalPages` indicates a truncated/aborted job).
- `Win32_PrintJob.PagesPrinted` is best-effort telemetry, not proof that a sheet physically exited. Terminal events label the count `confirmed`, `best_effort`, or `unknown`.
- Before dispatch, `JobOrchestrator` waits up to `PauseTimeoutMinutes` for `PrinterHealthMonitor.IsHealthy`; an in-flight job with recoverable status flags remains in the spooler and resumes after health returns.
- `PrinterHealthMonitor` reports fatal driver/WMI error states (such as Paper Out) to Node.js as `PrinterError` and exposes them to in-flight print verification.
- Queue watcher requests go directly to `JobOrchestrator` (no transaction gate).

### State Machine

- No persistence across service restart.
- Failed transactions stay in `Failed` until explicit named-pipe reset.

---

## 7. Self-Maintenance Rules

Before closing any task, diff what changed against this file and update stale sections.

### Triggers -> Required Updates

| What changed | Section(s) to update |
|---|---|
| `Esp32Command` constants changed | Section 2 outbound commands |
| `Esp32MessageType` changed | Section 2 inbound messages, Section 3 key classes |
| `HardwareSettings` changed | Section 3 configuration |
| DI registration changed | Section 3 DI registration |
| `TransactionState` or transitions changed | Section 4 |
| New package added to a `.csproj` | Section 3 orientation/dependencies |
| Stub promoted to implementation | Section 5 stub list |
| New stub added | Section 5 stub list |
| Print timeout/semaphore/arguments changed | Sections 2 and 6 |
| Print dispatch granularity or page-count confidence changed | Sections 2, 3, and 6 |
| Serial defaults/framing changed | Section 2 serial connection |
| `appsettings` keys changed | Section 3 configuration |
| New tests documenting behavior | Section 5 Agent MAY |
| Public interface in Section 3 changed | Section 3 key classes |
| Named-pipe DACL/ACL behaviour changed | Section 2 cross-Windows-identity DACL |

### Update Format

- Keep tables and code blocks aligned with source.
- Keep statements factual and terse.
- Rewrite sections when needed; do not leave contradictions.

### Commit Message Convention

When updating this file:

```
docs: update AGENTS.md - <what changed>
```
