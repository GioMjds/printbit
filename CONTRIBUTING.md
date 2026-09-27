# Contributing to PrintBit

Thanks for contributing to PrintBit.
This guide outlines workflow, conventions, and safety requirements across both the Node.js kiosk app and the C# Hardware Worker Service.

---

## Development Setup

### 1. Node.js Kiosk App (`src/`)

```bash
pnpm install
pnpm run dev
```

Build and test commands:

```bash
pnpm run build              # Build client and server bundles
pnpm run test               # Run Jest unit/integration tests
pnpm run lint               # Run ESLint checks
pnpm exec tsc --noEmit      # Verify TypeScript types
```

### 2. C# Hardware Worker (`worker/`)

Requires **.NET 10 SDK** (Windows x64).

```powershell
cd worker
dotnet build
```

Run locally or publish as a single-file Windows Service:

```powershell
# Run locally in console host mode
dotnet run --project .\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj

# Publish for Windows Service deployment
dotnet publish .\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -o .\publish
```

Verify IPC connectivity between Node and the worker:

```powershell
pnpm run worker-pipe:verify
```

---

## Workflow

1. Create a focused branch for one change.
2. Keep edits minimal and scoped to the task.
3. Verify behavior locally across both processes if IPC or hardware paths are touched.
4. Open a PR with:
   - what changed,
   - why it changed,
   - how to test it,
   - any risks or follow-ups.

---

## Codebase Conventions

### Node.js Kiosk (`src/`)

- Backend services live in `src/services/`, routes in `src/routes/`, and DB logic in `src/core/database/`.
- Frontend browser logic lives in `src/public/`. Never import browser modules into server code.
- Rebuild client bundles (`pnpm run build`) when modifying `src/public/*.ts`.
- Maintain strict TypeScript typings; avoid `any`.

### C# Hardware Worker (`worker/src/`)

- `PrintBit.HardwareService`: Windows Service host (`Program.cs`) and hosted background services.
- `PrintBit.Application`: orchestration logic, event handlers, and transaction state machines.
- `PrintBit.Hardware`: device protocols and serial decoders (`CoinAcceptor`, `Hopper`, `ESP32`).
- `PrintBit.Infrastructure`: printing pipeline (`DocumentPrinter`, `SumatraPDF`), WinSpool API, and LibreOffice conversion.
- `PrintBit.Infrastructure.Windows`: OS platform services (Win32 power safety, Windows Defender scanner, USB monitoring, trusted time, NAPS2 scanner).
- `PrintBit.Shared`: shared DTOs, Enums, and configuration options.
- Always publish the worker `.csproj` directly (avoid publishing the solution with a single shared `-o` output to prevent `NETSDK1194`).

---

## Hardware and Runtime Safety

- **Runtime Artifacts**: Never modify or commit runtime database files (`printbit.sqlite`) or uploads (`uploads/`).
- **Print Pipeline**: Print jobs are dispatched via filesystem handoff (`worker/queue/`) with atomic PDF copy and `.json` sidecars, routed by the worker to dedicated Windows logical queues (`EPSON L5290 Series` for Standard, `PrintBit - High` for High). Do not bypass the queue directory or the worker's `SemaphoreSlim` print serialization lock.
- **IPC Contracts**: Changes to named pipes (`printbit-worker-commands`, `printbit-worker-events`, `printbit-node-errors`, conversion pipe) must maintain JSON payload contract compatibility.
- **Process Mutex**: The worker relies on `Global\PrintBitHardwareWorker` to enforce a single running daemon instance; do not disable or modify mutex logic.
- **Graceful Hardware Degradation**: Serial, hopper, and scanner calls must gracefully handle offline/disconnected states without crashing the host process.

---

## Testing & Verification Checklist

For every PR, complete the following at minimum:

1. **Type & Code Checks**:
   - `pnpm exec tsc --noEmit`
   - `pnpm run lint`
   - `cd worker && dotnet build`
2. **IPC & Spooler Health**:
   - Run `pnpm run worker-pipe:verify` if worker services or IPC pipes were modified.
3. **Manual Flow Verification**:
   - Confirm affected UI, upload, payment, or print flows end-to-end without regressions.
