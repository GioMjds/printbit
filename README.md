# PrintBit Hardware Service

A .NET 10 Windows Service Worker focused on the printer spooler and print queue for the PrintBit kiosk system. It also logs error messages received from the Node.js app over a named pipe.

---

## Architecture

```
PrintBit.HardwareService    ← Worker Service host (entry point)
├── PrintBit.Application    ← State machine, orchestration, event handlers
├── PrintBit.Hardware       ← ESP32 device abstraction, message parsing
├── PrintBit.Infrastructure ← Serial comms, print dispatch, watchdog
└── PrintBit.Shared         ← Enums, DTOs, configuration models
```

### Request Flow

```
Print queue → PrintQueueWatcherService → PrintService (SumatraPDF + spooler verify)
Node.js errors → ErrorPipeHostedService (named pipe) → ILogger
```

---

## Projects

### `PrintBit.HardwareService`
Worker Service host. Runs printer-only background services.

| Service | Role |
|---|---|
| `PrintQueueWatcherService` | Watches the queue directory and submits print jobs |
| `ErrorPipeHostedService` | Reads Node.js error messages from a named pipe and logs them |
| `PrinterMonitorService` | Logs printer status and job state from Windows spooler |

### `PrintBit.Application`
Business logic layer (present but not wired in the printer-only runtime). No direct I/O dependencies.

| Class | Role |
|---|---|
| `TransactionStateMachine` | Tracks `TransactionState` (Idle → WaitingForCoins → ReadyToPrint → Printing → Completed) and `CurrentBalance` |
| `HardwareOrchestrator` | Routes `Esp32Message` types to the correct handler |
| `CoinInsertedHandler` | Delegates coin events to `TransactionStateMachine.InsertCoin()` |
| `StartPrintHandler` | Drives state machine through print lifecycle; calls `IPrintService` |
| `HardwareEventQueue` | Bounded `Channel<Esp32Message>` (1024 capacity, single-reader) |

### `PrintBit.Hardware`
Hardware abstraction layer (not wired in the printer-only runtime).

| Class | Role |
|---|---|
| `Esp32Device` | Wraps `ISerialConnection`; parses raw serial strings into typed `Esp32Message` |
| `Esp32Message` | Typed message: `Type`, `Value`, `Raw`, `TimestampUtc` |
| `Esp32MessageType` | `CoinInserted`, `HopperCompleted`, `Heartbeat`, `Unknown`, etc. |
| `Esp32Command` | Static command strings sent back to ESP32 (`HOPPER_DISPENSE`, `PONG`, etc.) |

### `PrintBit.Infrastructure`
I/O services (print process, printer monitoring, IPC helpers).

| Class | Role |
|---|---|
| `SerialConnection` | Wraps `System.IO.Ports.SerialPort`; exposes `DataReceived` event |
| `PrintService` | Spawns `SumatraPDF.exe` process with `-print-to`; uses `SemaphoreSlim(1,1)` to serialize jobs; 2-minute timeout |
| `WatchdogService` | Heartbeat logger (wired for future hardware health checks) |

### `PrintBit.Shared`
Cross-cutting types with no dependencies.

- `HardwareSettings` — printer configuration bound from `appsettings.json`
- `IpcSettings` — named pipe configuration for Node error + return events

---

## Configuration

`appsettings.json`:

```json
{
  "HardwareSettings": {
    "PrintTimeoutSeconds": 120,
    "PrinterName": "EPSON L5290 Series",
    "PrinterProfiles": {
      "Standard": "EPSON L5290 Series",
      "High": "PrintBit - High"
    },
    "PrintQueueDirectory": "C:\\Users\\printbit\\printbit-worker\\queue"
  },
  "IpcSettings": {
    "PipeName": "printbit-node-errors",
    "MaxMessageBytes": 8192,
    "WorkerReturnPipeName": "printbit-worker-events",
    "WorkerCommandPipeName": "printbit-worker-commands",
    "WorkerCommandMaxConcurrency": 4,
    "WorkerCommandAllowedClientIdentity": null,
    "WorkerInstanceLockName": "Global\\PrintBitHardwareWorker"
  }
}
```

| Key | Default | Description |
|---|---|---|
| `PrintTimeoutSeconds` | `120` | Print timeout in seconds |
| `PrinterName` | `EPSON L5290 Series` | Physical printer identity used for health monitoring |
| `PrinterProfiles.Standard` | `EPSON L5290 Series` | Logical queue for Standard jobs; falls back to `PrinterName` when omitted |
| `PrinterProfiles.High` | `PrintBit - High` | Logical queue with system-wide Epson Printing Defaults saved as High; required for High jobs |
| `PrintQueueDirectory` | `C:\\Users\\printbit\\printbit-worker\\queue` | Directory watched for PDFs |
| `IpcSettings.PipeName` | `printbit-node-errors` | Named pipe for Node error messages |
| `IpcSettings.MaxMessageBytes` | `8192` | Max bytes per error line |
| `IpcSettings.WorkerReturnPipeName` | `printbit-worker-events` | Named pipe for worker return events |
| `IpcSettings.WorkerCommandPipeName` | `printbit-worker-commands` | Node-to-worker command pipe |
| `IpcSettings.WorkerCommandMaxConcurrency` | `4` | Maximum active command handlers |
| `IpcSettings.WorkerCommandAllowedClientIdentity` | empty | Optional exact account name or SID granted read/write access |
| `IpcSettings.WorkerInstanceLockName` | `Global\\PrintBitHardwareWorker` | Machine-wide duplicate-worker lock |

---

## Print Pipeline

`PrintService` resolves the job's `quality` (`standard` or `high`) to a fixed
Windows logical queue, then dispatches to `SumatraPDF.exe`:

```
SumatraPDF.exe -print-to "<resolved profile queue>" -print-settings "<copies>" "<filePath>"
```

- Standard queue: `EPSON L5290 Series`
- High queue: `PrintBit - High`
- Concurrency: serialized via `SemaphoreSlim(1, 1)` — one job at a time
- Timeout: 2 minutes via linked `CancellationTokenSource`
- Exit code `!= 0` → `PrintJobResult { Success = false }`

Both queues point to the same physical Epson and still share the worker's one global
print lock. Configure each queue's paper type and quality in its system-wide
**Printing Defaults** (Printer properties > Advanced), then verify the effective
settings from the Windows identity that runs the worker. The worker does not mutate
global driver preferences per job, and SumatraPDF has no dedicated Epson
Standard/High command-line option.

To create the High logical queue after confirming the installed driver and port:

```powershell
Get-Printer | Where-Object Name -like "*L5290*" | Format-List Name,DriverName,PortName
Add-Printer -Name "PrintBit - High" -DriverName "EPSON L5290 Series" -PortName "USB001"
```

Replace the example driver and port with the exact values returned on the kiosk,
then manually save **High** in that queue's Printing Defaults and verify it with
the same PDF used for the Standard queue. See Microsoft's
[`Add-Printer`](https://learn.microsoft.com/en-us/powershell/module/printmanagement/add-printer)
documentation and SumatraPDF's
[command-line reference](https://www.sumatrapdfreader.org/docs/Command-line-arguments).

`SumatraPDF.exe` must be on `PATH` or in the working directory.

---

## Kiosk Installation

The supported installation flow has two parts. Run both from **PowerShell opened
with Run as administrator**.

### 1. Install the Node.js kiosk

From the Node.js repository:

```powershell
pnpm run install-kiosk
```

That script owns the Node.js kiosk installation. Do not duplicate its startup or
kiosk-shell setup from this repository.

### 2. Publish and install the hardware worker

From `C:\Users\printbit\printbit-worker`:

```powershell
dotnet publish .\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -o .\publish  

$workerExe = (Resolve-Path '.\publish\PrintBit.HardwareService.exe').Path
$workerBinPath = '"' + $workerExe + '"'
sc.exe create PrintBitHardware `
  binPath= $workerBinPath `
  start= auto `
  depend= Spooler `
  obj= LocalSystem `
  DisplayName= "PrintBit Hardware Service"

sc.exe start PrintBitHardware
sc.exe queryex PrintBitHardware
```

The worker runs as the built-in `LocalSystem` account, so installation does not
depend on a kiosk-user password or the **Log on as a service** right. `SYSTEM`
must retain access to the configured queue, failed, and executable paths.
Success means `sc.exe create` reports `CreateService SUCCESS` and the final
query reaches `STATE: 4 RUNNING`.

The default LocalSystem service does not need an optional client SID because the
Node startup task also runs as SYSTEM in `-AtStartup` mode. For Assigned Access
deployments that launch Node at kiosk-account logon, register the Node task with
`install-startup.ps1 -KioskUser .\printbit`; that installer resolves the account
SID and persists it as machine-scoped `Ipc__WorkerCommandAllowedClientIdentity`.

After installation or an update, run `pnpm run worker-pipe:verify` from the Node
repository. It checks service state, automatic startup, exactly one worker
process, scheduled-task identity, configured SID, and a harmless command-pipe
request/response.

The command listener keeps a replacement pipe instance ready while a request is
processed and handles up to `WorkerCommandMaxConcurrency` clients. A second
worker executable cannot acquire `Global\PrintBitHardwareWorker`; it logs a
critical startup error and exits with code 2.

Always publish the worker `.csproj` directly. Publishing the solution with one
shared `--output` directory can produce `NETSDK1194` and unnecessarily restores
the test project.

The `publish/` and `publish-kiosk/` directories are generated deployment output
and are ignored by Git. A self-contained executable can exceed 100 MB; never add
it to a commit. Recreate it on the kiosk with `dotnet publish`.

### Updating an installed worker

Do not run `sc.exe create` again. Stop the service, republish, and restart it:

```powershell
sc.exe stop PrintBitHardware
# Wait until: sc.exe query PrintBitHardware reports STATE: 1 STOPPED

dotnet publish .\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -o .\publish

sc.exe start PrintBitHardware
sc.exe queryex PrintBitHardware
```

Common failures:

| Error | Cause | Action |
|---|---|---|
| `NU1301` | NuGet is unreachable | Check internet, proxy, firewall, and NuGet source access. |
| `NETSDK1194` | The solution was published into one output directory | Publish the worker `.csproj` with the command above. |
| `OpenSCManager FAILED 5` | PowerShell is not elevated | Reopen PowerShell with Run as administrator. |
| `FAILED 1060` | The service does not exist | Run the create command using the exact name `PrintBitHardware`. |
| `FAILED 1073` | The service already exists | Use the update procedure instead. |
| Start error `1069` | A stale per-user service credential remains configured | Run `sc.exe config PrintBitHardware obj= LocalSystem password= ""`, then start the service again. |
| Start error `1053` or `1067` | The worker exited during startup | Check the Application and System logs in Event Viewer. |

References: [Microsoft .NET Windows Service installation](https://learn.microsoft.com/en-us/dotnet/core/extensions/windows-service),
[`sc.exe create` syntax](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/sc-create),
and [solution-level `--output` restrictions](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/7.0/solution-level-output-no-longer-valid).

## Running Locally

```bash
# Development
cd src/PrintBit.HardwareService
dotnet run
```

The project references `Microsoft.Extensions.Hosting.WindowsServices`, so the host
automatically handles Windows Service Control Manager lifecycle signals.

---

## Known Gaps / In Progress

| Area | Status |
|---|---|
| `HopperDevice` / `IHopper` | Stub — dispense logic not implemented (not wired in printer-only runtime) |
| `EpsonPrinterDevice` / `IPrinterDevice` | Stub — direct WIA/ESC-P integration not implemented |
| `CoinAcceptorDevice` / `ICoinAcceptor` | Stub — direct Arduino path not implemented (not wired) |
| `HardwareStateMachine` / `PrintJobStateMachine` | Stubs — merged into `TransactionStateMachine` for now (not wired) |
| `TransactionService` | Stub — persistence not wired |
| `NamedPipeServer` / `SocketServer` / `MessageDispatcher` | Stubs — legacy IPC server unused; error pipe uses `ErrorPipeHostedService` |
| Shared DTOs (`TransactionDto`, `HardwareStatusDto`, etc.) | Empty — not yet used |
| `HopperDispenseHandler` / `PrintCompletedHandler` | Stubs — post-print change flow not wired |

---

## Dependencies

| Package | Version | Used In |
|---|---|---|
| `Microsoft.Extensions.Hosting` | 10.0.8 | HardwareService |
| `Microsoft.Extensions.Hosting.WindowsServices` | 10.0.8 | HardwareService |
| `Microsoft.Extensions.Logging` | 10.0.8 | Application, Hardware, Infrastructure |
| `System.IO.Ports` | 10.0.8 | Infrastructure, Hardware |
| `System.Text.Json` | 10.0.8 | HardwareService |
| `Serilog` + `Serilog.Sinks.File` | 4.3.1 / 7.0.0 | HardwareService |

---

## Project Structure

```
src/
├── PrintBit.Application/
│   ├── Events/              # CoinInsertedEvent, StartPrintEvent
│   ├── Handlers/            # CoinInsertedHandler, StartPrintHandler
│   ├── Queues/              # HardwareEventQueue (Channel<Esp32Message>)
│   ├── Services/            # HardwareOrchestrator
│   └── StateMachine/        # TransactionStateMachine
├── PrintBit.Hardware/
│   └── Devices/
│       ├── ESP32/           # Esp32Device, Esp32Message, IEsp32Device
│       ├── CoinAcceptor/    # (stub)
│       ├── Hopper/          # (stub)
│       └── Printer/         # (stub)
├── PrintBit.HardwareService/
│   ├── Services/            # PrintQueueWatcherService, ErrorPipeHostedService
│   └── Program.cs           # DI registration
├── PrintBit.Infrastructure/
│   └── Services/
│       ├── PrintService/    # IPrintService, PrintService (SumatraPDF)
│       ├── SerialService/   # ISerialConnection, SerialConnection (unused)
│       ├── WatchdogService/ # WatchdogService (unused)
│       ├── IPC/             # Node error parsing helpers + legacy stubs
│       └── TransactionService/ # (stub)
└── PrintBit.Shared/
    ├── Configurations/      # HardwareSettings
    ├── Constants/           # (stub)
    ├── Enums/               # TransactionState
    └── Models/              # (stubs: DTOs)
```
