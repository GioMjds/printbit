# Worker Command Pipe Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Node.js-to-C# worker commands survive startup races and normal concurrency while preserving least-privilege pipe access and at-most-once client retry behavior after connection.

**Architecture:** Node owns bounded pre-connect retry within one request deadline. The C# worker owns a replacement-listener accept loop with bounded active handlers, an explicit optional client SID in its pipe DACL, and a process-lifetime global instance lock. PowerShell installation and verification align the scheduled-task identity with worker configuration.

**Tech Stack:** Node.js 22, TypeScript 6, `node:net`, Jest 30, .NET 10 Worker Service, `NamedPipeServerStream`, xUnit, Moq, Windows PowerShell ScheduledTasks and Service cmdlets.

**Spec:** `docs/superpowers/specs/2026-09-10-worker-command-pipe-reliability-design.md`

## Global Constraints

- Keep the existing one-request/one-response newline-delimited JSON protocol.
- Retry only failures that happen before a connection is established; never replay after connection or write may have occurred.
- Keep pipe access deny-by-default; never grant `Everyone` or `Authenticated Users`.
- Preserve existing command parsing, the 8,192-byte default message limit, and command-specific response types.
- Do not add a package dependency.
- Keep unrelated dirty documentation changes out of every commit.
- Update `C:/Users/printbit/printbit-worker/AGENTS.md` because the named-pipe ACL, configuration, tests, and DI/runtime startup behavior change.

---

### Task 1: Add safe Node pre-connect retry

**Files:**
- Create: `tests/services/worker-command-pipe.spec.ts`
- Modify: `src/services/worker-command-pipe.ts`

**Interfaces:**
- Consumes: existing `sendWorkerRequest<TResponse>(payload, options)` callers.
- Produces: `SendWorkerCommandOptions.connectRetry?: { initialDelayMs?: number; maxDelayMs?: number }`; behavior remains `Promise<TResponse | null>`.

- [ ] **Step 1: Write the failing delayed-listener integration test**

Create a real Windows named-pipe server after a 75 ms delay, call `sendWorkerRequest` immediately with `timeoutMs: 2_000` and retry delays of 10/40 ms, and assert the literal response `{ requestId: 'delayed-1', success: true }`. The production change this catches is removing pre-connect retry, which exposes `ENOENT` before the server appears.

```ts
it('waits for a worker pipe that appears before the request deadline', async () => {
  const pipeName = uniquePipeName('delayed');
  const serverDone = startOneShotServer(pipeName, 75, {
    requestId: 'delayed-1',
    success: true,
  });

  await expect(sendWorkerRequest(
    { requestId: 'delayed-1', type: 'GetPrinterRecoveryStatus' },
    { pipeName, timeoutMs: 2_000, connectRetry: { initialDelayMs: 10, maxDelayMs: 40 } },
  )).resolves.toEqual({ requestId: 'delayed-1', success: true });
  await serverDone;
});
```

- [ ] **Step 2: Run the delayed-listener test and verify RED**

Run: `pnpm exec jest tests/services/worker-command-pipe.spec.ts --runInBand`

Expected: FAIL because the first `ENOENT` resolves `null`.

- [ ] **Step 3: Implement one-deadline pre-connect retry**

Refactor `sendWorkerRequest` so each attempt owns one socket, retry delays are bounded by the remaining deadline, and only `ENOENT`, `ECONNREFUSED`, and `EBUSY` before `connect` schedule another attempt. Add jitter through a small internal delay calculator, keep one terminal warning, and clean every socket and timer on completion.

```ts
export interface SendWorkerCommandOptions {
  pipeName?: string;
  timeoutMs?: number;
  connectRetry?: { initialDelayMs?: number; maxDelayMs?: number };
  logger?: Pick<Console, 'warn' | 'error' | 'log'>;
}

const RETRYABLE_CONNECT_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'EBUSY']);
```

- [ ] **Step 4: Verify delayed startup GREEN**

Run: `pnpm exec jest tests/services/worker-command-pipe.spec.ts --runInBand`

Expected: PASS with no open-handle warning.

- [ ] **Step 5: Add failing no-replay and deadline tests**

Add real-socket tests proving a server that accepts then disconnects receives exactly one connection, and an absent pipe returns `null` within the configured overall deadline. Add a unit seam for `net.connect` only where needed to inject `EPERM`, assert one attempt, and restore the real function after the test. The mutations caught are retrying after connection and giving every attempt a fresh full timeout.

- [ ] **Step 6: Run the new tests and verify RED**

Run: `pnpm exec jest tests/services/worker-command-pipe.spec.ts --runInBand`

Expected: FAIL on post-connect replay/deadline behavior until attempt state and deadline cleanup are complete.

- [ ] **Step 7: Complete minimal transport state handling**

Track `connected`, `finished`, attempt count, last error code, active socket, deadline timer, and retry timer. Once `connected === true`, route every error/close to terminal `null`; never call the attempt function again. Emit the terminal diagnostic once.

- [ ] **Step 8: Run Node transport and existing client tests**

Run: `pnpm exec jest tests/services/worker-command-pipe.spec.ts tests/services/platform-worker-client.spec.ts --runInBand`

Expected: PASS, all tests, no leaked timers or sockets.

- [ ] **Step 9: Commit the Node slice**

```powershell
git add -- src/services/worker-command-pipe.ts tests/services/worker-command-pipe.spec.ts
git commit -m "fix: retry worker pipe before connection"
```

---

### Task 2: Keep the C# command listener available under concurrency

**Files:**
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.Shared/Configurations/IpcSettings.cs`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.HardwareService/Services/WorkerCommandPipeHostedService.cs`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.HardwareService/appsettings.json`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.HardwareService/appsettings.Development.json`
- Modify: `C:/Users/printbit/printbit-worker/tests/PrintBit.Tests/WorkerCommandPipeTests.cs`

**Interfaces:**
- Consumes: `WorkerCommandPipeSecurity.CreateServerStream(...)` and existing `ProcessRequestAsync`.
- Produces: `IpcSettings.WorkerCommandMaxConcurrency` with default `4`; one accept loop and tracked client-handler tasks.

- [ ] **Step 1: Write the failing concurrent-listener test**

Start the real hosted service with `WorkerCommandMaxConcurrency = 2`. Make the first mocked `GetStatusAsync` block on a `TaskCompletionSource`, then connect a second real `NamedPipeClientStream`, send a second status command, and assert its response arrives before releasing the first request. The production change this catches is returning to single-client serial accept/process behavior.

- [ ] **Step 2: Run the listener test and verify RED**

Run from `C:/Users/printbit/printbit-worker`:

`dotnet test tests/PrintBit.Tests/PrintBit.Tests.csproj --filter FullyQualifiedName~WorkerCommandPipeTests --no-restore`

Expected: FAIL because the second response waits for the first request to finish.

- [ ] **Step 3: Implement replacement-listener dispatch**

Add `WorkerCommandMaxConcurrency` validation (`1..16`). In `ExecuteAsync`, wait for a concurrency slot, create and await a listener, create the replacement listener before launching `HandleConnectedClientAsync`, and track handler tasks in a locked `HashSet<Task>`. Client I/O exceptions stay inside the handler. On cancellation, dispose the pending listener and await the current task snapshot.

```csharp
public int WorkerCommandMaxConcurrency { get; set; } = 4;
```

Use `NamedPipeServerStream.MaxAllowedServerInstances` for each server stream; the semaphore, not the OS instance-count constructor argument, is the application concurrency bound.

- [ ] **Step 4: Add client-isolation and shutdown tests**

Add tests where one client sends malformed JSON while another valid client succeeds, and where `StopAsync` completes after connected clients are released/cancelled. Assert responses and completion, not private task collections.

- [ ] **Step 5: Run worker command tests GREEN**

Run: `dotnet test tests/PrintBit.Tests/PrintBit.Tests.csproj --filter FullyQualifiedName~WorkerCommandPipeTests --no-restore`

Expected: PASS with no hung test process.

- [ ] **Step 6: Commit the listener slice in the worker repository**

```powershell
git add -- src/PrintBit.Shared/Configurations/IpcSettings.cs src/PrintBit.HardwareService/Services/WorkerCommandPipeHostedService.cs src/PrintBit.HardwareService/appsettings.json src/PrintBit.HardwareService/appsettings.Development.json tests/PrintBit.Tests/WorkerCommandPipeTests.cs
git commit -m "fix: keep worker command listener available"
```

---

### Task 3: Allow one explicitly configured Node identity

**Files:**
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.Shared/Configurations/IpcSettings.cs`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.Infrastructure/IPC/WorkerCommandPipeSecurity.cs`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.HardwareService/Services/WorkerCommandPipeHostedService.cs`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.HardwareService/appsettings.json`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.HardwareService/appsettings.Development.json`
- Modify: `C:/Users/printbit/printbit-worker/tests/PrintBit.Tests/WorkerCommandPipeTests.cs`

**Interfaces:**
- Produces: `IpcSettings.WorkerCommandAllowedClientIdentity` as a nullable account name or SID string; `CreatePipeSecurity(string? allowedClientIdentity)` and matching `CreateServerStream` parameter.

- [ ] **Step 1: Write failing explicit-SID ACL tests**

Use a valid non-broad Windows SID fixture and assert it receives exactly `PipeAccessRights.ReadWrite`. Assert `WorldSid` and `AuthenticatedUserSid` are rejected with `ArgumentException`, and an unresolvable account throws `IdentityNotMappedException`. The mutations caught are silently broadening access and silently ignoring bad deployment configuration.

- [ ] **Step 2: Run ACL tests and verify RED**

Run: `dotnet test tests/PrintBit.Tests/PrintBit.Tests.csproj --filter FullyQualifiedName~CreatePipeSecurity --no-restore`

Expected: FAIL because the security factory has no configured-identity parameter.

- [ ] **Step 3: Implement strict identity resolution**

Resolve SID strings with `new SecurityIdentifier(value)` and account names with `new NTAccount(value).Translate(typeof(SecurityIdentifier))`. Reject `WorldSid` and `AuthenticatedUserSid`; deduplicate against current user, SYSTEM, and Administrators; grant only `ReadWrite` to the configured client.

- [ ] **Step 4: Pass the configured identity into every command listener**

Add the nullable setting to both appsettings files and pass it from `WorkerCommandPipeHostedService` into `CreateServerStream`. Do not apply this extra principal to unrelated pipes.

- [ ] **Step 5: Run ACL and command-pipe tests GREEN**

Run: `dotnet test tests/PrintBit.Tests/PrintBit.Tests.csproj --filter "FullyQualifiedName~WorkerCommandPipeTests" --no-restore`

Expected: PASS.

- [ ] **Step 6: Commit the ACL slice in the worker repository**

```powershell
git add -- src/PrintBit.Shared/Configurations/IpcSettings.cs src/PrintBit.Infrastructure/IPC/WorkerCommandPipeSecurity.cs src/PrintBit.HardwareService/Services/WorkerCommandPipeHostedService.cs src/PrintBit.HardwareService/appsettings.json src/PrintBit.HardwareService/appsettings.Development.json tests/PrintBit.Tests/WorkerCommandPipeTests.cs
git commit -m "fix: authorize configured worker pipe client"
```

---

### Task 4: Fail fast when a second worker starts

**Files:**
- Create: `C:/Users/printbit/printbit-worker/src/PrintBit.HardwareService/Services/WorkerInstanceLock.cs`
- Create: `C:/Users/printbit/printbit-worker/tests/PrintBit.Tests/WorkerInstanceLockTests.cs`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.Shared/Configurations/IpcSettings.cs`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.HardwareService/Program.cs`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.HardwareService/appsettings.json`
- Modify: `C:/Users/printbit/printbit-worker/src/PrintBit.HardwareService/appsettings.Development.json`
- Modify: `C:/Users/printbit/printbit-worker/tests/PrintBit.Tests/ProgramRegistrationTests.cs`

**Interfaces:**
- Produces: `IpcSettings.WorkerInstanceLockName`, default `Global\\PrintBitHardwareWorker`; `WorkerInstanceLock.TryAcquire(string, ILogger)` returning an owned disposable or `null`.

- [ ] **Step 1: Write failing real-mutex ownership tests**

With a unique `Global\\PrintBitHardwareWorker-<guid>` name, assert the first acquisition succeeds, a second acquisition in another thread returns `null`, disposal allows a later acquisition, and an abandoned mutex is treated as successfully acquired. The mutation caught is allowing two processes to proceed into hosted-service startup.

- [ ] **Step 2: Run the instance-lock tests and verify RED**

Run: `dotnet test tests/PrintBit.Tests/PrintBit.Tests.csproj --filter FullyQualifiedName~WorkerInstanceLockTests --no-restore`

Expected: FAIL because `WorkerInstanceLock` does not exist.

- [ ] **Step 3: Implement the process-lifetime lock**

Create a sealed `IDisposable` wrapper around `Mutex`. `TryAcquire` calls `WaitOne(0)`, treats `AbandonedMutexException` as ownership, treats `UnauthorizedAccessException` as unavailable/duplicate, and releases only when owned. Validate that the configured name is non-empty and starts with `Global\\` on Windows.

- [ ] **Step 4: Acquire the lock before `RunAsync`**

After building the host but before starting it, resolve an `ILoggerFactory`, try to acquire the configured lock, log one critical message and set `Environment.ExitCode = 2` on failure, otherwise hold the disposable through `await host.RunAsync()`. Update registration tests to resolve the configuration and retain all existing hosted-service assertions.

- [ ] **Step 5: Run instance-lock and registration tests GREEN**

Run: `dotnet test tests/PrintBit.Tests/PrintBit.Tests.csproj --filter "FullyQualifiedName~WorkerInstanceLockTests|FullyQualifiedName~ProgramRegistrationTests" --no-restore`

Expected: PASS.

- [ ] **Step 6: Commit the ownership slice in the worker repository**

```powershell
git add -- src/PrintBit.Shared/Configurations/IpcSettings.cs src/PrintBit.HardwareService/Services/WorkerInstanceLock.cs src/PrintBit.HardwareService/Program.cs src/PrintBit.HardwareService/appsettings.json src/PrintBit.HardwareService/appsettings.Development.json tests/PrintBit.Tests/WorkerInstanceLockTests.cs tests/PrintBit.Tests/ProgramRegistrationTests.cs
git commit -m "fix: prevent duplicate hardware workers"
```

---

### Task 5: Align kiosk deployment identities and verify service readiness

**Files:**
- Create: `tests/scripts/worker-command-pipe-deployment.spec.ts`
- Create: `scripts/verify-worker-command-pipe.ps1`
- Modify: `scripts/install-startup.ps1`
- Modify: `package.json`
- Modify: `C:/Users/printbit/printbit-worker/README.md`
- Modify: `C:/Users/printbit/printbit-worker/AGENTS.md`

**Interfaces:**
- Produces: machine environment variable `Ipc__WorkerCommandAllowedClientIdentity`; package script `worker-pipe:verify`; verification script exit `0` only when service, task identity, configuration, process count, and pipe probe agree.

- [ ] **Step 1: Write the failing PowerShell behavior tests**

Run PowerShell scripts in child processes with test-only function shims supplied through a temporary module path. For `install-startup.ps1 -KioskUser`, capture `SetEnvironmentVariable` and assert the literal resolved SID is written to machine scope; for `-AtStartup`, assert the setting is cleared because both processes use SYSTEM. For `verify-worker-command-pipe.ps1`, inject service/task/process fixtures and assert distinct non-zero results for missing service, non-automatic startup, stopped service, identity mismatch, and multiple worker processes.

- [ ] **Step 2: Run deployment tests and verify RED**

Run: `pnpm exec jest tests/scripts/worker-command-pipe-deployment.spec.ts --runInBand`

Expected: FAIL because the installer does not configure the worker identity and the verifier does not exist.

- [ ] **Step 3: Update the startup installer**

After resolving the scheduled-task account, persist its SID to `Ipc__WorkerCommandAllowedClientIdentity` at machine scope. Clear the variable for SYSTEM mode. If `PrintBitHardware` is already running and the value changed, print a precise instruction to restart it; do not restart a service implicitly from a task-registration script.

- [ ] **Step 4: Implement the worker-pipe verifier**

Check `Get-CimInstance Win32_Service -Filter "Name='PrintBitHardware'"` for existence, `StartMode = 'Auto'`, and `State = 'Running'`; check exactly one `PrintBit.HardwareService` process; inspect the `PrintBit Kiosk` task principal; compare its SID to the machine environment setting unless it is SYSTEM; then send a harmless `GetPrinterRecoveryStatus` request over the real pipe with a unique request ID and validate the echoed response ID. Return a distinct documented exit code for each category.

- [ ] **Step 5: Add the package script and rerun deployment tests GREEN**

Add `"worker-pipe:verify": "powershell -ExecutionPolicy Bypass -File .\\scripts\\verify-worker-command-pipe.ps1"` to `package.json`.

Run: `pnpm exec jest tests/scripts/worker-command-pipe-deployment.spec.ts --runInBand`

Expected: PASS without changing the host's real scheduled tasks, services, or machine environment.

- [ ] **Step 6: Update worker operational documentation**

Update the worker README installation section and the AGENTS named-pipe/configuration/DI/testing sections with `WorkerCommandMaxConcurrency`, `WorkerCommandAllowedClientIdentity`, `WorkerInstanceLockName`, replacement-listener behavior, limited-user SID setup, duplicate-instance exit behavior, and `pnpm run worker-pipe:verify`.

- [ ] **Step 7: Commit deployment code in the Node repository**

```powershell
git add -- scripts/install-startup.ps1 scripts/verify-worker-command-pipe.ps1 tests/scripts/worker-command-pipe-deployment.spec.ts package.json
git commit -m "fix: align worker pipe deployment identities"
```

- [ ] **Step 8: Commit worker documentation in the worker repository**

```powershell
git add -- README.md AGENTS.md
git commit -m "docs: document reliable command pipe deployment"
```

---

### Task 6: Cross-repository verification and graph refresh

**Files:**
- Update generated graph data under `graphify-out/` using `graphify update .`.

**Interfaces:**
- Consumes all prior task outputs.
- Produces fresh build/test evidence and a current main-repository knowledge graph.

- [ ] **Step 1: Run focused Node tests**

Run: `pnpm exec jest tests/services/worker-command-pipe.spec.ts tests/services/platform-worker-client.spec.ts tests/scripts/worker-command-pipe-deployment.spec.ts --runInBand`

Expected: PASS, zero failed tests.

- [ ] **Step 2: Run Node lint and build**

Run: `pnpm run lint`

Expected: exit `0`.

Run: `pnpm run build`

Expected: exit `0`.

- [ ] **Step 3: Run the complete C# test project**

Run from `C:/Users/printbit/printbit-worker`:

`dotnet test tests/PrintBit.Tests/PrintBit.Tests.csproj --no-restore`

Expected: PASS, zero failed tests.

- [ ] **Step 4: Build the worker Release configuration**

Run: `dotnet build PrintBit.sln -c Release --no-restore`

Expected: exit `0`, zero errors.

- [ ] **Step 5: Run a real local pipe smoke test**

Stop any debug worker process, start one Release worker instance with a unique test pipe/lock configuration, run the Node request probe during delayed startup and with parallel harmless status requests, then terminate only that test instance. Assert all response request IDs match and a second worker exits with code `2`.

- [ ] **Step 6: Refresh and inspect the graph**

Run from `C:/Users/printbit/printbit`: `graphify update .`

Expected: successful AST-only update. Review `git status --short` and keep generated graph artifacts according to the repository's existing ignore policy.

- [ ] **Step 7: Review final diffs and security invariants**

Run `git diff --check` and inspect both repository diffs. Confirm no broad pipe principal, no post-connect retry branch, no payload logging, no new dependency, and no unrelated user files are staged or modified by this work.
