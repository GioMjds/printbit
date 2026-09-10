# C# Service Migration

Yes. I audited the current **57 files** under `printbit/src/services` and compared their responsibilities against the current `printbit-worker` architecture.

The main conclusion is that your migration is **partially complete, but the ownership boundary is still inconsistent**.

Your own architecture already points toward the correct separation:

- **Node.js**: HTTP/API, uploads, sessions, pricing, transaction persistence, financial accounting, admin logic, UI/realtime orchestration.
- **C# Worker**: Windows integration, printer, spooler, scanner, serial/COM, ESP32/hardware, system monitoring, native process execution, document conversion.
- The C# design document also explicitly places scanner, printer, spooler, Windows monitoring, file conversion, and hardware integration in the Worker.

However, the running C# host currently registers mainly document conversion, printer monitoring/recovery, power monitoring, printing, and IPC. Serial, hopper, scanner, Defender, USB, and trusted-time functionality are not yet part of the running host.

## Classification

I would use these classifications:

| Status         | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| **KEEP NODE**  | Correctly belongs to the Node application                           |
| **MIGRATE C#** | Machine/system responsibility should move completely                |
| **SPLIT**      | Keep business/API portion in Node, move system/device portion to C# |
| **KEEP IPC**   | Node-side Worker communication adapter                              |
| **RETIRE**     | Remove after C# equivalent becomes authoritative                    |
| **REFACTOR**   | Architectural cleanup rather than migration                         |

---

# 1. Business, transaction, and application services

These generally should **not** move to C#.

| Node service                | Decision                        | Reason                                                                                                                                       |
| --------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin.ts`                  | **SPLIT**                       | Admin data/settings stay Node. Any restart-spooler, printer maintenance, hardware reset commands must call C#.                               |
| `anomaly.ts`                | **KEEP NODE**                   | Transaction/audit anomaly detection is application logic.                                                                                    |
| `consumable-estimator.ts`   | **KEEP NODE**                   | Estimation/reporting logic, not direct hardware control.                                                                                     |
| `db.ts`                     | **REFACTOR**                    | Database ownership should remain Node. Eventually remove the compatibility facade and import the actual database layer directly.             |
| `feedback.ts`               | **KEEP NODE**                   | Application persistence/domain logic.                                                                                                        |
| `financial-ledger.ts`       | **KEEP NODE**                   | Financial accounting must remain with Node's transaction database.                                                                           |
| `idle-timeout.ts`           | **KEEP NODE**                   | This is actually browser/UI behavior. It uses DOM state and activity events, so C# has no role here.                                         |
| `job-processor.ts`          | **KEEP NODE**                   | It owns persistent print job scheduling, Socket.IO, retries, and calls the print orchestrator. Hardware execution should be delegated to C#. |
| `job-store.ts`              | **KEEP NODE**                   | Copy/scan application job state.                                                                                                             |
| `pending-refund.ts`         | **KEEP NODE**                   | Financial reconciliation.                                                                                                                    |
| `pricing-analysis-queue.ts` | **KEEP NODE**                   | Pricing/application computation.                                                                                                             |
| `print-job-options.ts`      | **KEEP NODE + SHARED CONTRACT** | Node needs the DTO. Mirror it in `PrintBit.Shared`, preferably through one versioned IPC contract.                                           |
| `print-lifecycle-state.ts`  | **SPLIT**                       | Actual machine lifecycle belongs C#. Node keeps a projected lifecycle state for UI/API.                                                      |
| `print-quote.ts`            | **KEEP NODE**                   | Pricing and quote building remain Node.                                                                                                      |
| `recovery.ts`               | **SPLIT**                       | Financial/transaction recovery stays Node. Physical printer/spooler recovery belongs C#.                                                     |
| `report-issue.ts`           | **KEEP NODE**                   | Admin/support domain.                                                                                                                        |
| `session.ts`                | **KEEP NODE**                   | Wireless upload/session lifecycle belongs to the web application.                                                                            |
| `settlement.ts`             | **KEEP NODE**                   | Node should determine payment/change due. C# should only execute `DispenseCoins(amount)`.                                                    |

A particularly important distinction is `recovery.ts`. Its current implementation deals with database recovery sessions, refunds, transaction IDs, reconciliation and persisted spooler lifecycle records. That part should remain Node.

The actual Windows spooler recovery is already represented correctly by C# `PrinterRecoveryService` and `ServiceControllerSpoolerController`.

---

# 2. Document, upload, security, and scanning services

This area needs a mixed approach.

| Node service                  | Decision              | C# destination                                                                            |
| ----------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `color-detection.ts`          | **KEEP NODE**         | Pricing/document analysis domain                                                          |
| `defender-scanner.ts`         | **MIGRATE C#**        | `Infrastructure.Windows/Security/WindowsDefenderScanner.cs`                               |
| `document-analysis.ts`        | **KEEP NODE**         | Pricing analysis                                                                          |
| `document-analysis.worker.ts` | **KEEP NODE**         | CPU isolation for Node document analysis                                                  |
| `document-conversion-pipe.ts` | **KEEP IPC**          | C# conversion already exists                                                              |
| `document-rotation.ts`        | **MIGRATE C#**        | `Infrastructure/Services/DocumentProcessing/`                                             |
| `prepare-print-pdf.ts`        | **MIGRATE C#**        | C# print preprocessing pipeline                                                           |
| `preview.ts`                  | **KEEP NODE / SPLIT** | Node should orchestrate previews but delegate native conversion/rendering where necessary |
| `quarantine.ts`               | **SPLIT**             | Node owns upload policy, C# should perform Defender/native security operations            |
| `scan-delivery.ts`            | **KEEP NODE**         | QR/download/customer delivery                                                             |
| `scan-storage.ts`             | **SPLIT**             | C# creates scanner output, Node owns customer-facing metadata/lifetime                    |
| `scanner.ts`                  | **MIGRATE C#**        | `Infrastructure.Windows/Scanning/`                                                        |
| `transient-file-cleanup.ts`   | **SPLIT BY OWNER**    | Node cleans Node-owned uploads, C# cleans worker temp/spool/conversion artifacts          |
| `transient-scan-file.ts`      | **KEEP NODE**         | Customer-facing ephemeral scan file lifecycle                                             |
| `upload-staging.ts`           | **KEEP NODE**         | Express/Multer upload concern                                                             |

### `defender-scanner.ts` is a definite migration

It directly executes Windows Defender and PowerShell, including `MpCmdRun.exe` and `Get-MpComputerStatus`. That is exactly what `PrintBit.Infrastructure.Windows` is for.

I would create:

```text
PrintBit.Infrastructure.Windows/
└── Security/
    ├── IAntivirusScanner.cs
    ├── WindowsDefenderScanner.cs
    ├── DefenderHealthMonitor.cs
    └── DefenderScanResult.cs
```

Then Node does:

```text
upload
  ↓
Node validates size/MIME/magic bytes
  ↓
C# DefenderScan command
  ↓
clean / infected / unavailable / timeout
  ↓
Node accepts or quarantines/rejects
```

### `scanner.ts` is another definite migration

The current Node service invokes `NAPS2.Console.exe`, performs TWAIN/WIA probing, manages a Windows process and directly handles scanner hardware.

That should become something such as:

```text
PrintBit.Infrastructure.Windows/
└── Scanning/
    ├── IScannerService.cs
    ├── Naps2ScannerService.cs
    ├── ScannerDiscoveryService.cs
    ├── ScannerCapabilities.cs
    ├── ScanRequest.cs
    └── ScanResult.cs
```

This is currently one of the largest **missing capabilities in `printbit-worker`**.

### `upload-staging.ts` should stay Node

This is tightly coupled to Express and Multer's `StorageEngine`, request parameters, upload quotas and HTTP request lifecycle.

Do not move that just because it manipulates files.

---

# 3. Printer subsystem

This is where the most duplication currently exists.

| Node service              | Decision                          | Current C# equivalent/destination                   |
| ------------------------- | --------------------------------- | --------------------------------------------------- |
| `print-dispatcher.ts`     | **MIGRATE + RETIRE Node engines** | `DocumentPrinter`, `JobOrchestrator`                |
| `print-spooler.ts`        | **MIGRATE + RETIRE**              | `PrinterHealthMonitor`, spooler controller/recovery |
| `printer-fault-lock.ts`   | **MIGRATE machine gate**          | Worker printer operation/safety coordinator         |
| `printer-monitor.ts`      | **MIGRATE + RETIRE**              | `PrinterHealthMonitor`                              |
| `printer-status.ts`       | **MIGRATE + RETIRE**              | C# printer health/status snapshot                   |
| `printer.ts`              | **SPLIT**                         | TS DTO/client stays, execution goes C#              |
| `test-page.ts`            | **SPLIT**                         | Node may request test print, C# must execute it     |
| `windows-printer-edge.ts` | **RETIRE**                        | Replace entirely with native C#                     |

This is your **highest-value cleanup**.

You currently have an enormous `print-spooler.ts`, around **71 KB**, `printer-status.ts`, around **52 KB**, plus `printer-monitor.ts`, `windows-printer-edge.ts`, `print-dispatcher.ts`, and `printer.ts` all in Node.

Meanwhile C# already contains:

```text
PrintBit.Infrastructure.Windows/
└── PrinterMonitoring/
    ├── IPrintSpoolerController.cs
    ├── PrinterHealthMonitor.cs
    ├── PrinterRecoveryService.cs
    └── ServiceControllerSpoolerController.cs
```

and the host already registers the health monitor, recovery service, spooler controller, operation coordinator, document printer, and job orchestrator.

There should eventually be **zero direct Windows printer management from Node**.

Node's printing API should end up approximately as:

```text
Node
 ├─ calculate quote
 ├─ validate transaction
 ├─ create PrintJob
 ├─ persist PrintJob
 └─ WorkerClient.print(request)
                │
                ▼
C# Worker
 ├─ validate file
 ├─ prepare printable PDF
 ├─ apply orientation/paper/quality
 ├─ dispatch to printer
 ├─ watch Windows spooler
 ├─ detect printer fault
 ├─ recover spooler if appropriate
 └─ publish lifecycle events
```

That eliminates two competing printer state machines.

---

# 4. ESP32, hopper, serial, networking and Windows system services

This is the second major migration batch.

| Node service             | Decision                       | Destination                                             |
| ------------------------ | ------------------------------ | ------------------------------------------------------- |
| `hopper-protocol.ts`     | **MIGRATE C#**                 | `Hardware/Devices/Hopper`                               |
| `hopper.ts`              | **SPLIT, mostly C#**           | C# payout orchestration                                 |
| `hotspot.ts`             | **SPLIT, mostly C#**           | ESP32/network infrastructure                            |
| `power-safety.ts`        | **RETIRE Node implementation** | Already implemented in C#                               |
| `powershell-runspace.ts` | **MIGRATE/RETIRE**             | `Infrastructure.Windows`                                |
| `serial-ip-protocol.ts`  | **MIGRATE C#**                 | ESP32 protocol layer                                    |
| `serial.ts`              | **MIGRATE C#**                 | Serial hosted service                                   |
| `time-source.ts`         | **SPLIT**                      | C# Windows trusted-time provider, Node financial policy |
| `usb-drives.ts`          | **MIGRATE C#**                 | Windows removable-storage provider                      |
| `watchdog-health.ts`     | **SPLIT**                      | C# hardware health + Node application health            |

## Serial and hopper are currently your largest Worker gap

C# already contains:

```text
PrintBit.Hardware/
├── Devices/CoinAcceptor/
├── Devices/ESP32/
├── Devices/Hopper/
└── Devices/Printer/

PrintBit.Infrastructure/
└── Services/SerialService/
    ├── ISerialConnection.cs
    ├── SerialConnection.cs
    └── SerialPortFactory.cs
```

But the actual `SerialConnection` currently only:

```text
open COM
read a line
write a line
close COM
```

It does not yet replicate Node's protocol parser, reconnect behavior, ESP32 events, coin acceptance, hopper correlation, retries, heartbeats, or event forwarding.

More importantly, **none of this serial infrastructure is registered in `Program.cs`**.

So your C# structure implies that migration was intended, but it hasn't actually been completed.

### C# should eventually own this entire chain

```text
COM3
  │
  ▼
SerialConnection
  │
  ▼
ESP32 Protocol Parser
  │
  ├── CoinInserted
  ├── Heartbeat
  ├── HopperProgress
  ├── HopperCompleted
  ├── HopperError
  └── Network/IP events
         │
         ▼
HardwareEventQueue
         │
         ▼
HardwareOrchestrator
         │
         ▼
Node return pipe
```

That fits the C# `HardwareEventQueue` and `HardwareOrchestrator` architecture that already exists.

---

# 5. Power safety

`power-safety.ts` is effectively a migration that is already mostly finished.

The C# Worker has:

```text
PowerMonitoring/
├── IPowerSafetyGate.cs
├── IPowerStatusProvider.cs
├── NativePowerStatusProvider.cs
├── PowerMonitorService.cs
├── PowerSafetyGate.cs
└── PowerSafetyStateMachine.cs
```

Even better, `PowerMonitorService` already polls Windows power state, evaluates printer health, advances the safety state machine, controls whether transactions are accepted, and publishes `PowerStatusChanged` / `PowerStatusSnapshot` events through the Worker event pipe.

So the target should be:

```text
C# = source of truth

Node power-safety.ts
       ↓
event projection / cache only
       ↓
eventually renamed
power-state-projection.ts
```

Node should **not independently determine whether the Windows tablet is on battery**.

---

# 6. Trusted time

`time-source.ts` is another good example of a service that needs splitting.

Currently Node invokes `w32tm` through PowerShell and interprets Windows clock/NTP state.

Move this:

```text
w32tm
Windows clock querying
NTP state
clock source detection
drift measurement
```

to:

```text
PrintBit.Infrastructure.Windows/
└── Time/
    ├── ITrustedTimeProvider.cs
    ├── WindowsTrustedTimeProvider.cs
    └── TrustedTimeSnapshot.cs
```

But keep this in Node:

```text
"Should settlement be rejected because trusted time is unavailable?"
```

because that is a financial/business policy.

---

# 7. Worker IPC services

Do **not** migrate these. These are precisely what Node should retain.

| File                          | Decision                               |
| ----------------------------- | -------------------------------------- |
| `worker-command-pipe.ts`      | **KEEP IPC**                           |
| `worker-error-pipe.ts`        | **KEEP IPC**                           |
| `worker-handoff.ts`           | **KEEP TEMPORARILY**, then consolidate |
| `worker-print-lifecycle.ts`   | **KEEP as Node projection**, simplify  |
| `worker-return-pipe.ts`       | **KEEP IPC**                           |
| `document-conversion-pipe.ts` | **KEEP IPC**                           |

Your C# host already exposes matching hosted services such as `WorkerCommandPipeHostedService`, `ErrorPipeHostedService`, and `DocumentConversionPipeHostedService`.

I would, however, stop keeping them in generic `src/services`.

Reorganize Node toward:

```text
src/
├── infrastructure/
│   └── worker/
│       ├── worker-client.ts
│       ├── worker-command-pipe.ts
│       ├── worker-return-pipe.ts
│       ├── worker-error-pipe.ts
│       ├── document-conversion-client.ts
│       └── contracts/
│
├── modules/
│   ├── printing/
│   ├── scanning/
│   ├── payments/
│   ├── uploads/
│   ├── admin/
│   └── sessions/
│
└── services/
    └── ...only genuinely shared application services
```

`worker-handoff.ts` should eventually disappear if the Named Pipe command protocol becomes the single Worker API.

---

# 8. `index.ts`

`src/services/index.ts` should **not be migrated**. It should be progressively reduced as services leave Node. Right now it publicly re-exports printer, serial, hopper, Windows printer, power and other infrastructure capabilities.

That broad barrel export also makes architectural ownership less obvious.

After migration I would avoid a giant global service barrel entirely.

Prefer:

```ts
import { printWorkerClient } from '@/infrastructure/worker';
import { settlementService } from '@/modules/payments';
import { sessionService } from '@/modules/sessions';
```

instead of:

```ts
import {
  printFile,
  serialService,
  hopperService,
  printerStatus,
  ...
} from '@/services';
```

---

# What is actually missing from the C# Worker

This is the important part of the audit. Your C# repository already has the correct six-project layering:

```text
PrintBit.Application
PrintBit.Hardware
PrintBit.HardwareService
PrintBit.Infrastructure
PrintBit.Infrastructure.Windows
PrintBit.Shared
```

But I would add/complete these areas:

| New C# area                                       | Migrates from                                            |
| ------------------------------------------------- | -------------------------------------------------------- |
| `Infrastructure.Windows/Scanning`                 | `scanner.ts`                                             |
| `Infrastructure.Windows/Security`                 | `defender-scanner.ts`                                    |
| `Infrastructure.Windows/Storage`                  | `usb-drives.ts`                                          |
| `Infrastructure.Windows/Time`                     | Windows portion of `time-source.ts`                      |
| `Infrastructure/Services/DocumentProcessing`      | `prepare-print-pdf.ts`, `document-rotation.ts`           |
| `Infrastructure/Services/SerialService` expansion | `serial.ts`                                              |
| `Hardware/Devices/ESP32/Protocol`                 | `serial-ip-protocol.ts`                                  |
| `Hardware/Devices/Hopper/Protocol`                | `hopper-protocol.ts`                                     |
| `Application/Services/HopperOrchestrator`         | hardware portion of `hopper.ts`                          |
| `Application/Services/HardwareHealthService`      | hardware portion of `watchdog-health.ts`                 |
| `Infrastructure.Windows/Networking`               | Windows portion of `hotspot.ts`                          |
| Worker IPC commands                               | scan, security scan, dispense, USB, health, trusted time |

The current `hotspot.ts`, for example, calls `netsh`, alters Windows Firewall, resolves Windows interfaces, communicates with ESP32 and announces kiosk networking over serial. That is too much machine infrastructure inside Node.

---

# Phased Migration Roadmap

The migration is structured into **6 discrete phases** to ensure zero disruption to live kiosk operations, rapid CPU overhead reduction, and safe incremental verification.

| Phase       | Subsystem / Focus Area                            | Primary Objective                                                                                                   | Node Files Affected / Retired                                                                                                                                                                                                                                                    | C# Destination / Infrastructure                                                                                                      | Status     |
| :---------- | :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- | :--------- |
| **Phase 1** | **Printer & Spooler Subsystem**                   | Eliminate ~150 KB of heavy PowerShell loops & dual-state machines; unify print dispatch on worker queue handoff.    | Retire: `print-spooler.ts`, `printer-status.ts`, `printer-monitor.ts`, `windows-printer-edge.ts`, `print-dispatcher.ts`, `printer-fault-lock.ts`<br>New: `printer-state-projection.ts`<br>Modify: `printer.ts`, `copy.service.ts`, `financial.service.ts`, `admin.controller.ts` | `PrinterHealthMonitor.cs`<br>`DocumentPrinter.cs`<br>`PrintQueueWatcher.cs`<br>`ServiceControllerSpoolerController.cs`               | **FINISH** |
| **Phase 2** | **Serial, ESP32, Hopper & Coin Acceptor**         | Move COM port lifecycle, ESP32 protocol parser, coin pulse decoding, and hopper dispensing to C#.                   | Retire/Migrate: `serial.ts`, `serial-ip-protocol.ts`, `hopper.ts`, `hopper-protocol.ts`                                                                                                                                                                                          | `PrintBit.Hardware/Devices/`<br>`PrintBit.Infrastructure/Services/SerialService/`<br>`HardwareOrchestrator.cs`                       | **FINISH** |
| **Phase 3** | **Scanner Subsystem**                             | Migrate NAPS2 / TWAIN / WIA subprocess management and scan acquisition to native C# service.                        | Migrate: `scanner.ts`<br>Split: `scan-storage.ts`                                                                                                                                                                                                                                | `PrintBit.Infrastructure.Windows/Scanning/`<br>`Naps2ScannerService.cs`                                                              | **FINISH** |
| **Phase 4** | **Windows Security, Storage & Platform**          | Migrate Windows Defender (`MpCmdRun`), USB removable disk discovery, and Windows clock (`w32tm`) queries to C#.     | Retire/Migrate: `defender-scanner.ts`, `usb-drives.ts`, `powershell-runspace.ts`<br>Split: `time-source.ts`, `hotspot.ts`                                                                                                                                                        | `PrintBit.Infrastructure.Windows/Security/`<br>`PrintBit.Infrastructure.Windows/Storage/`<br>`PrintBit.Infrastructure.Windows/Time/` | **FINISH** |
| **Phase 5** | **Document Preprocessing & Rotation**             | Consolidate PDF rotation, orientation baking, and printable PDF preparation alongside LibreOffice conversion in C#. | Migrate: `prepare-print-pdf.ts`, `document-rotation.ts`                                                                                                                                                                                                                          | `PrintBit.Infrastructure/Services/DocumentProcessing/`                                                                               | **FINISH** |
| **Phase 6** | **IPC Client Consolidation & Clean Architecture** | Consolidate named pipe adapters into a single `WorkerClient` module; retire global barrel exports in `index.ts`.    | Consolidate: `worker-command-pipe.ts`, `worker-return-pipe.ts`, `worker-error-pipe.ts`, `worker-handoff.ts`<br>Clean: `src/services/index.ts`                                                                                                                                    | `PrintBit.Infrastructure/IPC/` (stable protocol v2)                                                                                  | **FINISH** |

---

### Phase 1: Printer & Spooler Subsystem (Current Phase)

- **Goal:** Immediate CPU & overhead relief. Stop Node from running continuous `powershell.exe` runspaces, WMI queries, and Sumatra/PDFtoPrinter child processes.
- **Documentation & Plan:**
  - Spec: [`docs/superpowers/specs/2026-09-02-printer-worker-migration-design.md`](docs/superpowers/specs/2026-09-02-printer-worker-migration-design.md)
  - Implementation Plan: [`docs/superpowers/plans/2026-09-02-printer-worker-migration.md`](docs/superpowers/plans/2026-09-02-printer-worker-migration.md)
- **Key Actions:**
  1. Retire 6 files in Node: `print-spooler.ts` (71 KB), `printer-status.ts` (52 KB), `printer-monitor.ts`, `windows-printer-edge.ts`, `print-dispatcher.ts` (28 KB), and `printer-fault-lock.ts`.
  2. Implement `printer-state-projection.ts` in Node: zero-overhead in-memory singleton populated strictly by C# named-pipe events.
  3. C# `PrinterHealthMonitor.cs`: broadcasts authoritative `PrinterStatusSnapshot`, `PrinterOnline`, `PrinterOffline`, and `PrinterError` over `\\.\pipe\printbit-worker-events`.
  4. Converge all print dispatch (Standard Print, Copy, Test Page) on `worker-handoff.ts` (`queue/` sidecars + PDF) monitored by C#'s `PrintQueueWatcher`.
  5. Replace `monitorSpoolerJob()` in `copy.service.ts` and `financial.service.ts` with reactive listeners on `worker-return-pipe.ts`.

---

### Phase 2: Serial, ESP32, Hopper & Coin Acceptor Subsystem

- **Goal:** Close the largest hardware capability gap in `printbit-worker`. Remove raw serial port handling, reconnection loops, and device state management from Node.js.
- **Current Gap in C#:** `PrintBit.Hardware` and `SerialConnection.cs` exist as skeletons but are not registered in `Program.cs` and lack protocol framing, reconnect loops, and error correlation.
- **Key Actions:**
  1. Implement a hosted serial service (`SerialHostedService.cs`) in C# using `System.IO.Ports.SerialPort` with automatic COM port detection and background reconnect loops.
  2. Port `serial-ip-protocol.ts` and `hopper-protocol.ts` into strongly-typed C# frame parsers in `PrintBit.Hardware/Devices/ESP32/Protocol` and `PrintBit.Hardware/Devices/Hopper/Protocol`.
  3. Register `CoinAcceptorDevice`, `HopperDevice`, and `Esp32Device` in `Program.cs`, routing hardware pulses through `HardwareEventQueue` and `HardwareOrchestrator`.
  4. Expose named-pipe commands: `DispenseCoinsCommand`, `ResetHardwareCommand`.
  5. Stream hardware events (`CoinInsertedEvent`, `HopperProgressEvent`, `HopperCompletedEvent`, `HardwareHeartbeatEvent`) over `WorkerEventPipeClient` to Node.
  6. In Node: Retire `serial.ts`, `serial-ip-protocol.ts`, `hopper-protocol.ts`. Update `hopper.ts` to send dispense IPC commands and listen to completion events.

---

### Phase 3: Scanner Subsystem (NAPS2 / TWAIN / WIA)

- **Goal:** Remove `NAPS2.Console.exe` process execution and scanner hardware probing from Node.
- **Key Actions:**
  1. Create `PrintBit.Infrastructure.Windows/Scanning` with `IScannerService`, `Naps2ScannerService`, and `ScannerDiscoveryService`.
  2. Port device capabilities detection, TWAIN/WIA driver querying, profile loading, and scan execution to C#.
  3. Expose `StartScanCommand` on the C# named pipe command listener.
  4. C# handles the scanner process, error timeouts, and writes the acquired scan image to disk, emitting `ScanProgress` and `ScanCompleted` events.
  5. In Node: Retire `scanner.ts`. Update `scan-storage.ts` to accept worker output paths and manage session delivery / QR codes.

---

### Phase 4: Windows Security, Storage & Platform Services

- **Goal:** Eliminate all remaining Windows OS and CLI invocations (`MpCmdRun.exe`, PowerShell removable drive detection, `w32tm`) from Node.
- **Key Actions:**
  1. **Security**: Create `PrintBit.Infrastructure.Windows/Security/WindowsDefenderScanner.cs` to execute `MpCmdRun.exe` natively. Expose `ScanFileSecurityCommand` over IPC. Retire `defender-scanner.ts` in Node.
  2. **USB Storage**: Create `PrintBit.Infrastructure.Windows/Storage/UsbDriveMonitor.cs` using WMI `Win32_DiskDrive` and `Win32_Volume` queries. Stream `UsbInserted` / `UsbRemoved` events. Retire `usb-drives.ts` in Node.
  3. **Trusted Time**: Create `PrintBit.Infrastructure.Windows/Time/WindowsTrustedTimeProvider.cs` to query NTP and system clock drift. Node keeps only the business policy ("reject transaction if time is untrusted").
  4. **Retire `powershell-runspace.ts`**: With all PowerShell operations moved to native C# Win32/WMI APIs, permanently delete `powershell-runspace.ts` from Node.

---

### Phase 5: Document Preprocessing & Orientation Geometry

- **Goal:** Offload PDF manipulation, page rotation, image rasterization, and printable-PDF preparation to C#.
- **Key Actions:**
  1. Migrate PDF page rotation, geometry normalization, and orientation baking (`prepare-print-pdf.ts`, `document-rotation.ts`) into `PrintBit.Infrastructure/Services/DocumentProcessing/`.
  2. Integrate preprocessing directly into C#'s `JobOrchestrator` before dispatching to `DocumentPrinter`.
  3. Node passes uploaded files or converted PDFs directly to the worker queue without performing intermediate PDF transformations in JavaScript.

---

### Phase 6: IPC Client Consolidation & Clean Architecture

- **Goal:** Clean up Node's architecture into cohesive domain modules and replace global barrel exports.
- **Key Actions:**
  1. Consolidate `worker-command-pipe.ts`, `worker-return-pipe.ts`, `worker-error-pipe.ts`, and `worker-handoff.ts` into a unified `src/infrastructure/worker/` module.
  2. Expose a typed `WorkerClient` class encapsulating all IPC communication.
  3. Remove the monolithic `src/services/index.ts` barrel file, enforcing clean imports (`@/modules/printing`, `@/modules/payments`, `@/infrastructure/worker`).

## Target architecture

The final PrintBit boundary should essentially become:

```text
┌───────────────────────────────┐
│ Node.js + Express             │
│                               │
│ HTTP / Socket.IO              │
│ Upload sessions               │
│ Student/session identity      │
│ Pricing                       │
│ Financial ledger              │
│ Settlement                    │
│ Refund records                │
│ Admin/audit                   │
│ Job persistence               │
│ Customer file delivery        │
└──────────────┬────────────────┘
               │
        Named Pipe IPC
               │
┌──────────────▼────────────────┐
│ C# PrintBit Worker            │
│                               │
│ Serial / COM                  │
│ ESP32 protocol                │
│ Coin acceptor                 │
│ Hopper                        │
│ Scanner                       │
│ Printer                       │
│ Windows spooler               │
│ Printer recovery              │
│ Power monitoring              │
│ Defender                      │
│ USB devices                   │
│ Trusted system time           │
│ Windows networking            │
│ LibreOffice conversion        │
│ PDF print preparation         │
│ Hardware watchdog             │
└──────────────┬────────────────┘
               │
 ┌─────────────┼──────────────┐
 ▼             ▼              ▼
ESP32       Epson L5290     Windows
```

The largest conceptual change is this:

> **Node should decide what PrintBit wants to do. C# should decide how the Windows kiosk and physical hardware actually do it.**

Your current codebase is already moving toward this model, but **serial/hopper, scanner, Defender, USB, trusted-time, Windows networking, and several remaining printer services are the major pieces that still violate that boundary**. The printer and power sides are considerably further along than the serial/scanner side.
