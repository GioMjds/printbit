# PrintBit Installation & Dependencies Guide

This guide explains what software to install, what dependencies are used across the Node.js application and the C# Worker Service, and how to validate a working local or production kiosk setup.

---

## 1) Platform requirements

- **Target OS:** Windows 10 / 11 64-bit (Professional or Enterprise recommended for Assigned Access / Kiosk Mode).
- **Development OS:** Windows 10/11 recommended for end-to-end hardware testing. Linux/macOS can be used for API and frontend development, but hardware integrations (named pipes, serial, WMI, spooler) require Windows.

---

## 2) Required software

### Core runtimes & build tools

- **Node.js:** 22.5.0+ (required for built-in `node:sqlite`).
- **pnpm:** `10.13.1` (as declared in `package.json`).
- **.NET SDK:** .NET 10 SDK (win-x64) to build and run the C# Worker Service in `worker/`.
- **Git:** Latest stable release.

### External tools & peripherals software

- **SumatraPDF:** Portable CLI executable (`SumatraPDF.exe`) placed in `bin/` or accessible on system `PATH`.
- **NAPS2 (Not Another PDF Scanner 2):** Command-line scanner tool (`naps2.console.exe`) for WIA/TWAIN scanning.
- **LibreOffice:** Headless office suite used by the worker for converting DOCX/XLSX/PPTX to PDF.
- **Printer Drivers:** EPSON L5290 Series driver (or target kiosk printer driver), configured with two logical queues:
  - `EPSON L5290 Series` (Printing Defaults set to Standard quality).
  - `PrintBit - High` (Printing Defaults set to High quality).

---

## 3) Dependencies breakdown

### Node.js application (`src/`)

- **Server & Realtime:** `express` 5, `socket.io` 4, `cookie-parser`.
- **Database:** Built-in SQLite (`node:sqlite`, `DatabaseSync`).
- **File & Media Handling:** `multer`, `file-type`, `xlsx`, `sharp`, `canvas`, `pdfjs-dist`, `pdf-lib`, `pdfkit`, `qrcode`.
- **Security & Crypto:** `argon2`.
- **Serial Comms:** `serialport`, `@serialport/parser-readline`.
- **Toolchain:** `typescript`, `esbuild`, `tsx`, `jest`, `eslint`.

### C# Hardware Worker (`worker/`)

- **Host & Lifetime:** `Microsoft.Extensions.Hosting`, `Microsoft.Extensions.Hosting.WindowsServices` (.NET 10).
- **Logging:** `Serilog`, `Serilog.Sinks.File`, `Microsoft.Extensions.Logging`.
- **Serial Ports:** `System.IO.Ports`.
- **JSON Serialization:** `System.Text.Json`.

---

## 4) Installation & setup steps

### 4.1) Local development setup

#### 1. Clone repository and install Node dependencies

```bash
git clone https://github.com/GioMjds/printbit.git
cd printbit
pnpm install
```

#### 2. Build the C# Worker Service

```powershell
cd worker
dotnet build
cd ..
```

#### 3. Run development services

In terminal 1 (Node.js dev server with hot reload):

```bash
pnpm run dev
```

In terminal 2 (C# Worker in console mode for local testing):

```powershell
dotnet run --project .\worker\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj
```

#### 4. Build and type-check

```bash
pnpm run build
pnpm exec tsc --noEmit
```

---

### 4.2) Production installation (Kiosk mode)

Run all production setup steps from an **Administrator PowerShell** prompt.

#### Step 1: Create local user accounts

Create the restricted kiosk account (`printbit`) and an administrative account (`printbit-admin`):

```powershell
net user printbit "KioskSecurePassword123!" /add
net user printbit-admin "AdminSecurePassword123!" /add
net localgroup Administrators printbit-admin /add
```

#### Step 2: Publish and register the C# Worker Windows Service

Publish the C# worker as a single-file executable directly from the repository's `worker/` directory into the deployment location:

```powershell
dotnet publish .\worker\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -o C:\Users\printbit\printbit-worker

$workerExe = "C:\Users\printbit\printbit-worker\PrintBit.HardwareService.exe"
sc.exe create PrintBitHardware `
  binPath= "`"$workerExe`"" `
  start= auto `
  depend= Spooler `
  obj= LocalSystem `
  DisplayName= "PrintBit Hardware Service"

sc.exe start PrintBitHardware
sc.exe queryex PrintBitHardware
```

> **Note:** The worker runs under the built-in `LocalSystem` account so it does not depend on a user password or service logon rights.

#### Step 3: Configure print queues and directories

Set up the watched queue directory and ensure `SumatraPDF.exe` is available:

```powershell
New-Item -ItemType Directory -Path "C:\Users\printbit\printbit-worker\queue" -Force
New-Item -ItemType Directory -Path "C:\Users\printbit\bin" -Force
Copy-Item ".\bin\SumatraPDF.exe" "C:\Users\printbit\bin\SumatraPDF.exe" -Force
```

Configure printer logical queues for Standard and High profiles pointing to the same printer port:

```powershell
Add-Printer -Name "PrintBit - High" -DriverName "EPSON L5290 Series" -PortName "USB001"
# Configure Printing Defaults in Windows Printer Properties > Advanced > Printing Defaults
```

#### Step 4: Build Node.js application & configure environment

```powershell
# From project root:
pnpm install
pnpm run build

# Set system-wide environment variables (Administrator)
setx PRINTBIT_WORKER_QUEUE_DIR "C:\Users\printbit\printbit-worker\queue" /M
setx PRINTBIT_KIOSK_USER ".\printbit" /M
```

#### Step 5: Verify worker IPC connectivity

Run the automated verification script to validate that `PrintBitHardware` is running, the command pipe is open, and process locks are satisfied:

```powershell
pnpm run worker-pipe:verify
```

#### Step 6: Install startup & watchdog tasks

Install scheduled tasks to launch Node.js kiosk server and background health watchdog at system startup:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 -AtStartup
powershell -ExecutionPolicy Bypass -File .\scripts\install-watchdog.ps1 -AtStartup
```

#### Step 7: Configure Windows Assigned Access (Lockdown)

Apply kiosk lockdown policies and configure Assigned Access for user `printbit` pointing Microsoft Edge to:
`http://127.0.0.1:3000/loading`

```powershell
pnpm run lockdown:apply
pnpm run lockdown:verify
```

---

## 5) Updating an existing installation

When deploying a new build to an active kiosk:

1. Stop services:

   ```powershell
   sc.exe stop PrintBitHardware
   ```

2. Pull latest git commits:

   ```powershell
   git pull origin main
   ```

3. Update Node dependencies & rebuild assets:

   ```powershell
   pnpm install
   pnpm run build
   pnpm exec tsc --noEmit
   ```

4. Re-publish the C# Worker Service:

   ```powershell
   dotnet publish .\worker\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj `
     -c Release `
     -r win-x64 `
     --self-contained true `
     -p:PublishSingleFile=true `
     -o C:\Users\printbit\printbit-worker
   ```

5. Restart worker service & verify IPC:

   ```powershell
   sc.exe start PrintBitHardware
   pnpm run worker-pipe:verify
   ```

---

## 6) Preflight checklist

- [ ] `PRINTBIT_WORKER_QUEUE_DIR` is set and points to `C:\Users\printbit\printbit-worker\queue`.
- [ ] `PrintBitHardware` service is running (`sc.exe query PrintBitHardware`).
- [ ] Named pipes connected: `printbit-worker-commands`, `printbit-worker-events`, `printbit-node-errors`.
- [ ] Automated verification passes: `pnpm run worker-pipe:verify`.
- [ ] Printer is online with both `EPSON L5290 Series` and `PrintBit - High` queues configured.
- [ ] `SumatraPDF.exe` exists in `bin/` or is on system `PATH`.
- [ ] Scanner is detected via NAPS2 CLI (`naps2.console.exe`).
- [ ] Serial COM port is connected for coin acceptor and hopper (115200 baud).
- [ ] Database `printbit.sqlite` is initialized and writable.
- [ ] Kiosk watchdog is running: `pnpm run watchdog:verify`.

---

## 7) Common troubleshooting issues

| Symptom                                       | Cause                                        | Action                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `worker-pipe:verify` fails                    | Worker service stopped or duplicate process  | Check `Get-Service PrintBitHardware`. Ensure only one `PrintBit.HardwareService.exe` is running (`Global\PrintBitHardwareWorker` mutex). |
| `sc.exe create` fails with error 5            | PowerShell not elevated                      | Open PowerShell with **Run as administrator**.                                                                                           |
| `sc.exe` syntax error                         | Missing space after parameter name           | Ensure syntax is `binPath= "..."` and `start= auto` (space after `=`).                                                                   |
| `NETSDK1194` during publish                   | Publishing solution with `-o`                | Publish the project file directly (`.\worker\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj`).                             |
| Print dispatch fails / times out              | Missing SumatraPDF or wrong queue name       | Verify `SumatraPDF.exe` is on PATH or in `bin/`, and queue names match `appsettings.json`.                                               |
| Native module build fails (`sharp`, `argon2`) | Incompatible Node or missing C++ build tools | Ensure Node is ≥ 22.5.0 and run `pnpm install`.                                                                                          |
| Coin acceptor / hopper unresponsive           | Serial port misconfigured or busy            | Check Device Manager for COM port assignment and set `PRINTBIT_SERIAL_PORT` if needed.                                                   |

---

## 8) Related docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Comprehensive system architecture & IPC flow
- [worker/README.md](./worker/README.md) — Detailed C# Worker Service documentation
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Workflow and coding conventions
- [OPERATIONS.md](./OPERATIONS.md) — Kiosk operational runbook
- [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) — REST & Socket.IO APIs
- [WINDOWS_KIOSK_LOCKDOWN_SETUP.md](./WINDOWS_KIOSK_LOCKDOWN_SETUP.md) — Assigned Access setup
