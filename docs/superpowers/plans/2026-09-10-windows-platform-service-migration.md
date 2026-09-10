# Phase 4 Windows Platform Service Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare buildable C# platform-service scaffolds and default-off Node migration seams for Defender, USB storage, trusted time, and hotspot networking while preserving current kiosk behavior.

**Architecture:** Extend the existing named-pipe command protocol with typed Phase 4 commands and safe placeholder results. Each Node service selects the worker through an independent feature flag and visibly falls back to its current implementation only when the worker transport or scaffold is unavailable; valid negative worker results remain authoritative.

**Tech Stack:** .NET 10 Windows Service, C# records and hosted services, named pipes, TypeScript, Node.js, Jest, xUnit, Moq, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-10-windows-platform-service-migration-design.md`

## Global Constraints

- Work in both `printbit` and sibling `../printbit-worker`; never move worker source into the Node repository.
- Preserve unrelated dirty files and use path-limited staging and commits.
- Do not write native Defender, WMI USB, trusted-time, interface-enumeration, or firewall behavior.
- Placeholder services return typed results and never throw `NotImplementedException`.
- All four Node worker flags default to disabled.
- Valid worker results such as `infected`, `unsynchronized`, and `drive not found` are authoritative and never trigger fallback.
- Transport failure, malformed responses, and `NOT_IMPLEMENTED` visibly fall back during migration.
- Preserve the existing pipe ACL, 8,192-byte default, newline framing, and `requestId` correlation.
- Do not introduce a general-purpose shell command endpoint or perform Phase 6 client consolidation.
- Update each `AGENTS.md` only where changed contracts, DI, configuration, or tests make it stale.

---

### Task 1: Define and strictly parse Phase 4 worker contracts

**Files:**

- Create: `../printbit-worker/src/PrintBit.Infrastructure/IPC/WorkerPlatformCommands.cs`
- Modify: `../printbit-worker/src/PrintBit.Infrastructure/IPC/WorkerCommandParser.cs`
- Test: `../printbit-worker/tests/PrintBit.Tests/WorkerPlatformCommandTests.cs`

**Interfaces:**

- Consumes: `WorkerHardwareCommand` and `WorkerCommandParser.JsonOptions`.
- Produces: six commands and responses consumed by Tasks 2-7.

- [ ] **Step 1: Write failing parser and serialization tests**

Create one success case per command plus invalid absolute-path, drive, NTP, subnet, and port cases. Use this pattern:

```csharp
[Fact]
public void TryParseHardwareCommand_ParsesSecurityScan()
{
    const string json = """{"type":"ScanFileSecurity","requestId":"sec-1","filePath":"C:\\PrintBit\\uploads\\x.upload"}""";
    var ok = WorkerCommandParser.TryParseHardwareCommand(json, 8192, out var command, out var error, out var requestId, out var type);
    Assert.True(ok, error);
    var typed = Assert.IsType<ScanFileSecurityCommand>(command);
    Assert.Equal("sec-1", requestId);
    Assert.Equal("ScanFileSecurity", type);
    Assert.Equal(@"C:\PrintBit\uploads\x.upload", typed.FilePath);
}

[Fact]
public void TryParseHardwareCommand_RejectsRelativeSecurityPath()
{
    const string json = """{"type":"ScanFileSecurity","requestId":"sec-2","filePath":"relative.upload"}""";
    Assert.False(WorkerCommandParser.TryParseHardwareCommand(json, 8192, out _, out var error));
    Assert.Contains("absolute", error!, StringComparison.OrdinalIgnoreCase);
}
```

- [ ] **Step 2: Run the focused test and confirm it fails to compile**

Run: `dotnet test ../printbit-worker/tests/PrintBit.Tests/PrintBit.Tests.csproj --no-restore --filter FullyQualifiedName~WorkerPlatformCommandTests`

Expected: missing platform command types.

- [ ] **Step 3: Add exact command and result records**

Define:

```csharp
public sealed record GetDefenderHealthCommand : WorkerHardwareCommand;
public sealed record ScanFileSecurityCommand : WorkerHardwareCommand { public string FilePath { get; init; } = string.Empty; }
public sealed record ListUsbDrivesCommand : WorkerHardwareCommand;
public sealed record ExportScanToUsbCommand : WorkerHardwareCommand { public string SourcePath { get; init; } = string.Empty; public string Drive { get; init; } = string.Empty; }
public sealed record GetTrustedTimeStatusCommand : WorkerHardwareCommand { public string? NtpServer { get; init; } public int MaxDriftMs { get; init; } = 60_000; }
public sealed record PrepareHotspotPlatformCommand : WorkerHardwareCommand { public IReadOnlyList<string> PreferredSubnetPrefixes { get; init; } = []; public int Port { get; init; } }
public sealed record WorkerUsbDrive(string Drive, string? Label, long FreeBytes, long TotalBytes);
public sealed record WorkerNetworkStatus(string? KioskIp, bool FirewallReady, string? Detail);
```

Add these response shapes and decorate their members with `JsonPropertyName` using the shown camel-case names:

```text
DefenderHealthResponse: RequestId, Type="GetDefenderHealth", Success, Status, SignatureAgeHours, Detail, ErrorCode
FileSecurityScanResponse: RequestId, Type="ScanFileSecurity", Success, Status, DetectionName, Detail, ErrorCode
ListUsbDrivesResponse: RequestId, Type="ListUsbDrives", Success, Drives, ErrorCode, Message
ExportScanToUsbResponse: RequestId, Type="ExportScanToUsb", Success, ExportPath, Drive, ErrorCode, Message
TrustedTimeStatusResponse: RequestId, Type="GetTrustedTimeStatus", Success, Source, Synced, OffsetMs, DriftExceeded, MaxDriftMs, CheckedAt, NtpSource, LastSuccessfulSyncAt, Detail, ErrorCode
PrepareHotspotPlatformResponse: RequestId, Type="PrepareHotspotPlatform", Success, KioskIp, FirewallReady, ErrorCode, Detail
```

- [ ] **Step 4: Extend strict parsing**

Add all six types to `IsHardwareCommandType()`. Construct the records in `TryParseHardwareCommand()` and enforce:

```csharp
Path.IsPathFullyQualified(filePath)
Regex.IsMatch(drive, "^[A-Za-z]:$")
Regex.IsMatch(ntpServer, "^[A-Za-z0-9._:-]+$")
maxDriftMs >= 0
port is > 0 and <= 65535
preferredPrefixes.All(prefix => Regex.IsMatch(prefix, "^(?:\\d{1,3}\\.){1,3}$"))
```

- [ ] **Step 5: Run tests and commit**

Run the Step 2 test and expect PASS. Then:

```powershell
git -C ../printbit-worker add -- src/PrintBit.Infrastructure/IPC/WorkerPlatformCommands.cs src/PrintBit.Infrastructure/IPC/WorkerCommandParser.cs tests/PrintBit.Tests/WorkerPlatformCommandTests.cs
git -C ../printbit-worker commit -m "feat: define Phase 4 platform IPC contracts"
```

---

### Task 2: Scaffold the Defender boundary

**Files:**

- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Security/IAntivirusScanner.cs`
- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Security/DefenderHealth.cs`
- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Security/DefenderScanResult.cs`
- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Security/WindowsDefenderScanner.cs`
- Test: `../printbit-worker/tests/PrintBit.Tests/WindowsDefenderScannerScaffoldTests.cs`

**Interfaces:**

- Consumes: validated absolute file paths.
- Produces: `GetHealthAsync()` and `ScanFileAsync()` for Task 6.

- [ ] **Step 1: Write a failing safe-placeholder test**

```csharp
var scanner = new WindowsDefenderScanner(Mock.Of<ILogger<WindowsDefenderScanner>>());
var health = await scanner.GetHealthAsync(CancellationToken.None);
var scan = await scanner.ScanFileAsync(@"C:\PrintBit\uploads\x.upload", CancellationToken.None);
Assert.Equal("NOT_IMPLEMENTED", health.ErrorCode);
Assert.Equal("unavailable", health.Status);
Assert.Equal("NOT_IMPLEMENTED", scan.ErrorCode);
```

- [ ] **Step 2: Run the focused test and confirm missing types**

Run: `dotnet test ../printbit-worker/tests/PrintBit.Tests/PrintBit.Tests.csproj --no-restore --filter FullyQualifiedName~WindowsDefenderScannerScaffoldTests`

- [ ] **Step 3: Add the exact interface and records**

```csharp
public interface IAntivirusScanner
{
    Task<DefenderHealth> GetHealthAsync(CancellationToken cancellationToken);
    Task<DefenderScanResult> ScanFileAsync(string filePath, CancellationToken cancellationToken);
}
public sealed record DefenderHealth(string Status, double? SignatureAgeHours, string? Detail, string? ErrorCode);
public sealed record DefenderScanResult(string Status, string? DetectionName, string? Detail, string? ErrorCode);
```

`WindowsDefenderScanner` logs at debug level and returns `NOT_IMPLEMENTED`. Add one `PHASE 4 IMPLEMENTATION` block covering approved executable roots, Defender health acquisition, scan timeout/cancellation, exit codes 0 and 2, threat-name parsing, 500-character diagnostics, and acceptance tests.

- [ ] **Step 4: Run the test and commit**

```powershell
git -C ../printbit-worker add -- src/PrintBit.Infrastructure.Windows/Security tests/PrintBit.Tests/WindowsDefenderScannerScaffoldTests.cs
git -C ../printbit-worker commit -m "feat: scaffold Windows Defender service"
```

---

### Task 3: Scaffold removable storage and USB events

**Files:**

- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Storage/IUsbStorageService.cs`
- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Storage/RemovableDrive.cs`
- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Storage/UsbExportResult.cs`
- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Storage/UsbDriveMonitor.cs`
- Modify: `../printbit-worker/src/PrintBit.Infrastructure/IPC/WorkerPrintEvent.cs`
- Modify: `../printbit-worker/src/PrintBit.Infrastructure/IPC/WorkerPrintEventType.cs`
- Test: `../printbit-worker/tests/PrintBit.Tests/UsbStorageScaffoldTests.cs`

**Interfaces:**

- Consumes: `IWorkerEventPipeClient`.
- Produces: USB list/export methods and `UsbInserted`/`UsbRemoved` events.

- [ ] **Step 1: Write failing service and event tests**

```csharp
var pipe = new Mock<IWorkerEventPipeClient>();
var monitor = new UsbDriveMonitor(Mock.Of<ILogger<UsbDriveMonitor>>(), pipe.Object);
Assert.Empty(await monitor.ListRemovableAsync(CancellationToken.None));
var result = await monitor.ExportAsync(@"C:\PrintBit\scans\x.pdf", "E:", CancellationToken.None);
Assert.Equal("NOT_IMPLEMENTED", result.ErrorCode);
pipe.Verify(x => x.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()), Times.Never);
```

- [ ] **Step 2: Run the focused test and confirm missing types**

Run: `dotnet test ../printbit-worker/tests/PrintBit.Tests/PrintBit.Tests.csproj --no-restore --filter FullyQualifiedName~UsbStorageScaffoldTests`

- [ ] **Step 3: Add contracts and a dormant hosted monitor**

```csharp
public interface IUsbStorageService
{
    Task<IReadOnlyList<RemovableDrive>> ListRemovableAsync(CancellationToken cancellationToken);
    Task<UsbExportResult> ExportAsync(string sourcePath, string drive, CancellationToken cancellationToken);
}
public sealed record RemovableDrive(string Drive, string? Label, long FreeBytes, long TotalBytes);
public sealed record UsbExportResult(bool Success, string? ExportPath, string? Drive, string? ErrorCode, string? Message);
public sealed class UsbDriveMonitor : BackgroundService, IUsbStorageService
```

Return an empty list and a `NOT_IMPLEMENTED` export result. `ExecuteAsync()` logs dormant status and returns `Task.CompletedTask`. The implementation block specifies WMI disk/volume correlation, sorting, insertion/removal diffing, `PrintBit\Scans`, collision-safe names, allowed-root checks, and cancellation.

- [ ] **Step 4: Extend the event envelope**

Add enum values `UsbInserted = 18` and `UsbRemoved = 19`, plus `WorkerUsbDrive? UsbDrive` serialized as `usbDrive`.

- [ ] **Step 5: Run the test and commit**

```powershell
git -C ../printbit-worker add -- src/PrintBit.Infrastructure.Windows/Storage src/PrintBit.Infrastructure/IPC/WorkerPrintEvent.cs src/PrintBit.Infrastructure/IPC/WorkerPrintEventType.cs tests/PrintBit.Tests/UsbStorageScaffoldTests.cs
git -C ../printbit-worker commit -m "feat: scaffold removable storage service"
```

---

### Task 4: Scaffold trusted-time observation

**Files:**

- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Time/ITrustedTimeProvider.cs`
- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Time/TrustedTimeSnapshot.cs`
- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Time/WindowsTrustedTimeProvider.cs`
- Test: `../printbit-worker/tests/PrintBit.Tests/WindowsTrustedTimeProviderScaffoldTests.cs`

**Interfaces:**

- Consumes: validated NTP server and drift threshold.
- Produces: trusted-time observations for Task 6.

- [ ] **Step 1: Write a failing placeholder test**

```csharp
var provider = new WindowsTrustedTimeProvider(Mock.Of<ILogger<WindowsTrustedTimeProvider>>());
var snapshot = await provider.GetStatusAsync("time.windows.com", 60_000, CancellationToken.None);
Assert.False(snapshot.Synced);
Assert.Equal("system", snapshot.Source);
Assert.Equal("NOT_IMPLEMENTED", snapshot.ErrorCode);
```

- [ ] **Step 2: Run the focused test and confirm missing types**

Run the `WindowsTrustedTimeProviderScaffoldTests` filter.

- [ ] **Step 3: Add the exact contract and placeholder**

```csharp
public interface ITrustedTimeProvider
{
    Task<TrustedTimeSnapshot> GetStatusAsync(string? ntpServer, int maxDriftMs, CancellationToken cancellationToken);
}
public sealed record TrustedTimeSnapshot(string Source, bool Synced, long? OffsetMs, bool DriftExceeded, int MaxDriftMs, DateTime CheckedAt, string? NtpSource, DateTime? LastSuccessfulSyncAt, string Detail, string? ErrorCode);
```

Return an unsynchronized `NOT_IMPLEMENTED` snapshot. The implementation block covers Windows Time source inspection, locale-independent acquisition, offset measurement, timeouts, cancellation, and the rule that financial enforcement stays in Node.

- [ ] **Step 4: Run the test and commit**

```powershell
git -C ../printbit-worker add -- src/PrintBit.Infrastructure.Windows/Time tests/PrintBit.Tests/WindowsTrustedTimeProviderScaffoldTests.cs
git -C ../printbit-worker commit -m "feat: scaffold trusted time provider"
```

---

### Task 5: Scaffold Windows hotspot support

**Files:**

- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Networking/IKioskNetworkPlatform.cs`
- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Networking/KioskNetworkSnapshot.cs`
- Create: `../printbit-worker/src/PrintBit.Infrastructure.Windows/Networking/WindowsKioskNetworkPlatform.cs`
- Modify: `../printbit-worker/src/PrintBit.Infrastructure/IPC/WorkerPrintEvent.cs`
- Modify: `../printbit-worker/src/PrintBit.Infrastructure/IPC/WorkerPrintEventType.cs`
- Test: `../printbit-worker/tests/PrintBit.Tests/WindowsKioskNetworkPlatformScaffoldTests.cs`

**Interfaces:**

- Consumes: validated subnet prefixes and port.
- Produces: `PrepareAsync()` and `NetworkStatusSnapshot`.

- [ ] **Step 1: Write a failing placeholder test**

```csharp
var platform = new WindowsKioskNetworkPlatform(Mock.Of<ILogger<WindowsKioskNetworkPlatform>>());
var snapshot = await platform.PrepareAsync(["192.168.4."], 3000, CancellationToken.None);
Assert.False(snapshot.Success);
Assert.Null(snapshot.KioskIp);
Assert.Equal("NOT_IMPLEMENTED", snapshot.ErrorCode);
```

- [ ] **Step 2: Run the focused test and confirm missing types**

Run the `WindowsKioskNetworkPlatformScaffoldTests` filter.

- [ ] **Step 3: Add contracts and placeholder**

```csharp
public interface IKioskNetworkPlatform
{
    Task<KioskNetworkSnapshot> PrepareAsync(IReadOnlyList<string> preferredSubnetPrefixes, int port, CancellationToken cancellationToken);
}
public sealed record KioskNetworkSnapshot(bool Success, string? KioskIp, bool FirewallReady, string? ErrorCode, string? Detail);
```

The implementation block specifies interface filtering, prefix ordering, deterministic fallback, firewall inspection/creation, idempotency, administrator failures, logging, and cancellation. It explicitly forbids contacting the ESP32 or owning credentials.

- [ ] **Step 4: Extend the event envelope**

Add `NetworkStatusSnapshot = 20` and `WorkerNetworkStatus? NetworkStatus` serialized as `networkStatus`.

- [ ] **Step 5: Run the test and commit**

```powershell
git -C ../printbit-worker add -- src/PrintBit.Infrastructure.Windows/Networking src/PrintBit.Infrastructure/IPC/WorkerPlatformCommands.cs src/PrintBit.Infrastructure/IPC/WorkerPrintEvent.cs src/PrintBit.Infrastructure/IPC/WorkerPrintEventType.cs tests/PrintBit.Tests/WindowsKioskNetworkPlatformScaffoldTests.cs
git -C ../printbit-worker commit -m "feat: scaffold kiosk network platform"
```

---

### Task 6: Route platform commands and register worker services

**Files:**

- Create: `../printbit-worker/src/PrintBit.HardwareService/Services/WorkerPlatformCommandHandler.cs`
- Modify: `../printbit-worker/src/PrintBit.HardwareService/Services/WorkerCommandPipeHostedService.cs`
- Modify: `../printbit-worker/src/PrintBit.HardwareService/Program.cs`
- Test: `../printbit-worker/tests/PrintBit.Tests/WorkerPlatformCommandHandlerTests.cs`
- Modify test: `../printbit-worker/tests/PrintBit.Tests/ProgramRegistrationTests.cs`

**Interfaces:**

- Consumes: all worker commands and service interfaces from Tasks 1-5.
- Produces: `HandleAsync()` and live DI registrations.

- [ ] **Step 1: Write failing mapping and registration tests**

```csharp
scanner.Setup(x => x.ScanFileAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
    .ReturnsAsync(new DefenderScanResult("clean", null, null, null));
var response = Assert.IsType<FileSecurityScanResponse>(await handler.HandleAsync(
    new ScanFileSecurityCommand { RequestId = "sec-8", FilePath = @"C:\PrintBit\uploads\x.upload" }, CancellationToken.None));
Assert.Equal("sec-8", response.RequestId);
Assert.True(response.Success);
```

Extend `ProgramRegistrationTests` to assert four interface registrations and the same `UsbDriveMonitor` instance through `IUsbStorageService` and `IHostedService`.

- [ ] **Step 2: Run both focused test classes and confirm failure**

Run the `WorkerPlatformCommandHandlerTests|ProgramRegistrationTests` filter.

- [ ] **Step 3: Implement the focused handler**

Create a constructor accepting the four interfaces and:

```csharp
public async Task<object> HandleAsync(WorkerHardwareCommand command, CancellationToken cancellationToken)
```

Use an exhaustive switch, map domain records to IPC responses, preserve `RequestId`, and convert unexpected exceptions to `HardwareErrorResponse` with `PLATFORM_COMMAND_FAILED` while logging command type and request ID.

- [ ] **Step 4: Connect the existing dispatcher**

Inject the handler into `WorkerCommandPipeHostedService`. Route the six platform records after strict parsing, serialize with `JsonOptions`, and leave all printer/scanner/hardware/recovery paths unchanged.

- [ ] **Step 5: Register exact singleton services**

```csharp
builder.Services.AddSingleton<IAntivirusScanner, WindowsDefenderScanner>();
builder.Services.AddSingleton<UsbDriveMonitor>();
builder.Services.AddSingleton<IUsbStorageService>(sp => sp.GetRequiredService<UsbDriveMonitor>());
builder.Services.AddHostedService(sp => sp.GetRequiredService<UsbDriveMonitor>());
builder.Services.AddSingleton<ITrustedTimeProvider, WindowsTrustedTimeProvider>();
builder.Services.AddSingleton<IKioskNetworkPlatform, WindowsKioskNetworkPlatform>();
builder.Services.AddSingleton<WorkerPlatformCommandHandler>();
```

- [ ] **Step 6: Run worker verification and commit**

```powershell
dotnet test ../printbit-worker/printbit-worker.slnx --no-restore
dotnet build ../printbit-worker/printbit-worker.slnx --no-restore
git -C ../printbit-worker add -- src/PrintBit.HardwareService/Services/WorkerPlatformCommandHandler.cs src/PrintBit.HardwareService/Services/WorkerCommandPipeHostedService.cs src/PrintBit.HardwareService/Program.cs tests/PrintBit.Tests/WorkerPlatformCommandHandlerTests.cs tests/PrintBit.Tests/ProgramRegistrationTests.cs
git -C ../printbit-worker commit -m "feat: route Phase 4 platform commands"
```

---

### Task 7: Add the typed Node platform client and default-off flags

**Files:**

- Create: `src/config/platform-worker.config.ts`
- Create: `src/services/platform-worker-client.ts`
- Modify: `src/services/worker-command-pipe.ts`
- Test: `tests/services/platform-worker-client.spec.ts`

**Interfaces:**

- Consumes: `sendWorkerRequest<T>()` and Task 1 wire contracts.
- Produces: `PlatformWorkerClient` and `getPlatformWorkerFlags()` for Tasks 8-11.

- [ ] **Step 1: Write failing flag and payload tests**

```typescript
expect(getPlatformWorkerFlags({})).toEqual({
  defender: false,
  usb: false,
  trustedTime: false,
  networking: false,
});
await client.scanFileSecurity('C:\\PrintBit\\uploads\\x.upload');
expect(sendWorkerRequest).toHaveBeenCalledWith(
  expect.objectContaining({
    type: 'ScanFileSecurity',
    filePath: 'C:\\PrintBit\\uploads\\x.upload',
    requestId: expect.any(String),
  }),
  expect.anything(),
);
```

Also reject `null`, missing `success`, missing `requestId`, and mismatched response types.

- [ ] **Step 2: Run the focused Jest test and confirm missing modules**

Run: `pnpm test -- --runInBand tests/services/platform-worker-client.spec.ts`

- [ ] **Step 3: Add strict flag parsing**

```typescript
export interface PlatformWorkerFlags {
  defender: boolean;
  usb: boolean;
  trustedTime: boolean;
  networking: boolean;
}
export function getPlatformWorkerFlags(
  env: NodeJS.ProcessEnv = process.env,
): PlatformWorkerFlags;
```

Only `true`, `1`, and `yes` enable flags named `PRINTBIT_WORKER_DEFENDER_ENABLED`, `PRINTBIT_WORKER_USB_ENABLED`, `PRINTBIT_WORKER_TRUSTED_TIME_ENABLED`, and `PRINTBIT_WORKER_NETWORKING_ENABLED`.

- [ ] **Step 4: Export `class PlatformWorkerClient` with six typed methods**

```typescript
getDefenderHealth(): Promise<DefenderHealthWorkerResponse | null>;
scanFileSecurity(filePath: string): Promise<FileSecurityWorkerResponse | null>;
listUsbDrives(): Promise<ListUsbDrivesWorkerResponse | null>;
exportScanToUsb(sourcePath: string, drive: string): Promise<ExportScanToUsbWorkerResponse | null>;
getTrustedTimeStatus(input: { ntpServer: string | null; maxDriftMs: number }): Promise<TrustedTimeWorkerResponse | null>;
prepareHotspotPlatform(input: { preferredSubnetPrefixes: string[]; port: number }): Promise<NetworkPlatformWorkerResponse | null>;
```

Generate request IDs with `randomUUID()`. Use 15 seconds except Defender scan, which uses the configured scan timeout. Return `null` after warning on malformed or mismatched envelopes.

- [ ] **Step 5: Extend command typing, test, and commit**

Add the six literals and fields to `WorkerCommandType`/`WorkerCommandPayload`. Run the focused test. Commit only the four listed files with message `feat: add Phase 4 worker platform client`.

---

### Task 8: Put Defender behind the migration seam

**Files:**

- Modify: `src/services/defender-scanner.ts`
- Modify test: `tests/services/defender-scanner.spec.ts`
- Test: `tests/services/defender-worker-routing.spec.ts`

**Interfaces:**

- Consumes: `PlatformWorkerClient`, the Defender flag, and existing Defender result types.
- Produces: unchanged `createDefenderScanner()` behavior with optional worker routing.

- [ ] **Step 1: Write failing routing tests**

Test default legacy behavior, clean/infected worker mappings, fallback for transport/malformed/`NOT_IMPLEMENTED`, and no fallback for valid `infected`:

```typescript
const scanner = createDefenderScanner({
  env: { PRINTBIT_WORKER_DEFENDER_ENABLED: 'true' },
  workerClient,
  runner,
  fsAdapter,
  logger,
});
workerClient.scanFileSecurity.mockResolvedValue({
  requestId: 'sec-1',
  type: 'ScanFileSecurity',
  success: true,
  status: 'infected',
  detectionName: 'EICAR-Test-File',
  detail: null,
});
await expect(scanner.scanFile(fakePath)).resolves.toMatchObject({
  status: 'infected',
});
expect(runner.run).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run Defender tests and confirm the red state**

Run the existing and new Defender test files.

- [ ] **Step 3: Add a worker-backed decorator**

Extend `DefenderScannerDeps` with `env`, `workerClient`, and `logger`. Keep `DefaultDefenderScanner` as legacy. Add `MigratingDefenderScanner`; fall back only on `null`, invalid response, or `errorCode === 'NOT_IMPLEMENTED'`, logging:

```typescript
logger.warn(
  '[DEFENDER] Worker backend unavailable; using temporary Node fallback.',
);
```

Map all valid statuses without fallback.

- [ ] **Step 4: Run focused tests and commit**

Run Defender and `file-validation` tests. Commit the three files with message `feat: add Defender worker migration seam`.

---

### Task 9: Put USB operations behind the migration seam

**Files:**

- Modify: `src/services/usb-drives.ts`
- Test: `tests/services/usb-drives.spec.ts`

**Interfaces:**

- Consumes: `PlatformWorkerClient` and the USB flag.
- Produces: unchanged `listRemovableDrives()` and `exportScanToUsbDrive()` APIs.

- [ ] **Step 1: Write failing routing tests**

Add `createUsbDriveService(deps)` tests. A successful empty worker list is authoritative, `DRIVE_NOT_FOUND` rejects without fallback, and `NOT_IMPLEMENTED` invokes legacy behavior and warns:

```typescript
workerClient.listUsbDrives.mockResolvedValue({
  requestId: 'usb-1',
  type: 'ListUsbDrives',
  success: true,
  drives: [],
});
await expect(service.listRemovable()).resolves.toEqual([]);
expect(runPowerShell).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the new test and confirm the factory is missing**

Run: `pnpm test -- --runInBand tests/services/usb-drives.spec.ts`

- [ ] **Step 3: Implement stable backend selection**

Export `UsbDriveServiceDeps` and `createUsbDriveService()`. Preserve singleton exports. Validate worker drive records before mapping. Convert valid unsuccessful responses into existing user-facing errors without Node fallback.

- [ ] **Step 4: Run scanner tests and commit**

Run the USB test and all scanner module specs. Commit the two files with message `feat: add USB worker migration seam`.

---

### Task 10: Split trusted-time observation from Node policy

**Files:**

- Modify: `src/services/time-source.ts`
- Test: `tests/services/time-source.spec.ts`

**Interfaces:**

- Consumes: `PlatformWorkerClient` and the trusted-time flag.
- Produces: unchanged status cache, timestamps, monitor, and financial enforcement APIs.

- [ ] **Step 1: Write failing observer-routing tests**

Call:

```typescript
await verifyTrustedClockSync({
  env,
  workerClient,
  runPowerShell,
  now: () => fixedNow,
  logger,
});
```

Assert configured offset wins, default mode uses legacy `w32tm`, a worker snapshot populates the cache, `NOT_IMPLEMENTED` falls back, and a valid unsynchronized snapshot never falls back.

- [ ] **Step 2: Run the new test and confirm the dependency overload is absent**

Run: `pnpm test -- --runInBand tests/services/time-source.spec.ts`

- [ ] **Step 3: Extract observation dependencies without moving policy**

```typescript
export interface TrustedTimeVerificationDeps {
  env?: NodeJS.ProcessEnv;
  workerClient?: Pick<PlatformWorkerClient, 'getTrustedTimeStatus'>;
  runPowerShell?: typeof runPowerShell;
  now?: () => Date;
  logger?: Pick<Console, 'warn'>;
}
```

Change only `verifyTrustedClockSync(deps = {})`. Preserve `TrustedTimeError`, enforcement, freshness, cache, timestamps, and monitor behavior. Strictly validate worker timestamps; malformed timestamps use legacy fallback.

- [ ] **Step 4: Run consumers and commit**

Run the time-source test and `admin-test-print.spec.ts`. Commit both files with message `feat: split trusted time observation backend`.

---

### Task 11: Split hotspot Windows preparation from ESP32 policy

**Files:**

- Create: `src/services/platform-network-state-projection.ts`
- Modify: `src/services/hotspot.ts`
- Modify: `src/services/session.ts`
- Test: `tests/services/hotspot-worker-routing.spec.ts`
- Test: `tests/services/platform-network-state-projection.spec.ts`

**Interfaces:**

- Consumes: `PlatformWorkerClient` and the networking flag.
- Produces: projected worker IP and unchanged hotspot/session contracts.

- [ ] **Step 1: Write failing projection and startup tests**

```typescript
platformNetworkStateProjection.apply({
  kioskIp: '192.168.4.2',
  firewallReady: true,
  detail: null,
});
expect(platformNetworkStateProjection.getSnapshot()?.kioskIp).toBe(
  '192.168.4.2',
);
await service.start();
expect(workerClient.prepareHotspotPlatform).toHaveBeenCalledWith({
  preferredSubnetPrefixes: expect.arrayContaining(['192.168.4.']),
  port: expect.any(Number),
});
expect(registerKiosk).toHaveBeenCalledWith('192.168.4.2');
```

Also test explicit-IP precedence, projection reset/cloning, valid negative results, and `NOT_IMPLEMENTED` fallback.

- [ ] **Step 2: Run both tests and confirm missing projection/factory**

Run both new Jest files.

- [ ] **Step 3: Add the projection and injected service factory**

```typescript
export interface PlatformNetworkSnapshot {
  kioskIp: string | null;
  firewallReady: boolean;
  detail: string | null;
}
export const platformNetworkStateProjection: {
  apply(snapshot: PlatformNetworkSnapshot): void;
  getSnapshot(): PlatformNetworkSnapshot | null;
  reset(): void;
};
```

Add `createHotspotService(deps)` while retaining the singleton. Worker mode prepares the platform, stores valid snapshots, then starts existing ESP32 registration. Legacy firewall/interface work occurs only in disabled mode or migration fallback.

- [ ] **Step 4: Preserve synchronous consumers**

Resolve kiosk IP in this order: configured explicit IP, projected worker IP, legacy interface detection. Keep `session.ts` on the synchronous API.

- [ ] **Step 5: Run hotspot/session tests and commit**

Run both new tests and `wifi-troubleshooting.spec.ts`. Commit the five files with message `feat: split hotspot Windows platform backend`.

---

### Task 12: Consume USB and network worker events in Node

**Files:**

- Modify: `src/services/worker-return-pipe.ts`
- Modify: `src/services/platform-network-state-projection.ts`
- Modify test: `tests/services/worker-return-pipe.spec.ts`

**Interfaces:**

- Consumes: the three event types and payloads from Tasks 3 and 5.
- Produces: strict parsing, socket mappings, and network projection updates.

- [ ] **Step 1: Write failing event tests**

```typescript
const evt: WorkerPrintEvent = {
  type: 'NetworkStatusSnapshot',
  timestampUtc: new Date().toISOString(),
  networkStatus: { kioskIp: '192.168.4.2', firewallReady: true, detail: null },
};
expect(mapWorkerEventToSocket(evt).event).toBe('workerNetworkStatusChanged');
```

Add equivalent cases for `workerUsbInserted` and `workerUsbRemoved`, plus invalid missing payloads.

- [ ] **Step 2: Run worker-return tests and confirm type failures**

Run: `pnpm test -- --runInBand tests/services/worker-return-pipe.spec.ts`

- [ ] **Step 3: Extend event unions, payloads, and mappings**

Add `UsbInserted`, `UsbRemoved`, and `NetworkStatusSnapshot` to `WorkerPrintEventType`; add typed `usbDrive` and `networkStatus` fields; validate required payloads; extend the exhaustive socket switch with the three mappings.

- [ ] **Step 4: Update the projection on valid network events**

After parsing and before `onEvent`, call `platformNetworkStateProjection.apply(evt.networkStatus)` only for `NetworkStatusSnapshot`.

- [ ] **Step 5: Run tests and commit**

Run worker-return and projection tests. Commit the three files with message `feat: project Phase 4 worker events`.

---

### Task 13: Retire the unused runspace and synchronize documentation

**Files:**

- Delete: `src/services/powershell-runspace.ts`
- Modify: `AGENTS.md`
- Modify: `CSHARP_SERVICE_MIGRATION.md`
- Modify: `../printbit-worker/AGENTS.md`

**Interfaces:**

- Consumes: completed Tasks 1-12.
- Produces: no persistent PowerShell runspace and accurate migration guidance.

- [ ] **Step 1: Prove the runspace has no callers**

Run: `rg -n --glob '!graphify-out/**' "powershell-runspace|createPersistentPS|createMutex" src tests`

Expected: only `src/services/powershell-runspace.ts`. If a caller exists, stop and move it to its supported backend before deletion.

- [ ] **Step 2: Delete the file with `apply_patch` and repeat the search**

Expected after deletion: no matches.

- [ ] **Step 3: Update factual documentation**

Mark Phase 4 `SCAFFOLDED`, never `FINISH`. Document the six commands, four default-off flags, worker registrations, ownership boundary, safe placeholder status, and the requirement to complete native methods before enabling flags.

- [ ] **Step 4: Check and commit each repository separately**

Run `git diff --check` in both repositories. Commit Node docs/deletion with `docs: record Phase 4 platform scaffold`; commit worker `AGENTS.md` with `docs: update AGENTS.md - Phase 4 platform scaffold`. Use path-limited commits.

---

### Task 14: Full verification and graph refresh

**Files:**

- Update generated Graphify outputs under `graphify-out/` as produced by `graphify update .`.

**Interfaces:**

- Consumes: all prior tasks.
- Produces: final test/build evidence and a current Node knowledge graph.

- [ ] **Step 1: Verify the worker**

```powershell
dotnet test ../printbit-worker/printbit-worker.slnx --no-restore
dotnet build ../printbit-worker/printbit-worker.slnx --no-restore
git -C ../printbit-worker diff --check
```

- [ ] **Step 2: Verify Node**

```powershell
pnpm test -- --runInBand
pnpm run lint
pnpm run build
git diff --check
```

- [ ] **Step 3: Verify flags and runspace retirement**

```powershell
rg -n "PRINTBIT_WORKER_(DEFENDER|USB|TRUSTED_TIME|NETWORKING)_ENABLED" src tests AGENTS.md
rg -n --glob '!graphify-out/**' "powershell-runspace|createPersistentPS" src tests
```

Expected: flags are opt-in and the runspace search returns no matches.

- [ ] **Step 4: Refresh the graph**

Run: `graphify update .`

- [ ] **Step 5: Review final state**

Run `git status --short` and `git -C ../printbit-worker status --short`. Confirm intended files are committed, report expected generated graph dirt according to repository convention, and leave pre-existing unrelated changes untouched.
