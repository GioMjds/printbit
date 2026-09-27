# Windows 10 Production Deployment Quickstart (Assigned Access Kiosk)

This guide provides a streamlined, step-by-step process for deploying the PrintBit kiosk on a Windows 10/11 tablet using Assigned Access. It consolidates building both the Node.js application and the integrated C# Hardware Worker Service, environment configuration, user provisioning, service registration, and lockdown verification.

---

## 1. Build the Applications

Before configuring the kiosk, ensure both the Node.js backend and the C# hardware service are built for production.

Open **PowerShell as Administrator** in the PrintBit directory:

```powershell
cd C:\Users\printbit\printbit

# 1. Build the Node.js Backend & Client
pnpm install
pnpm run build
pnpm exec tsc --noEmit

# 2. Build & Publish the C# Worker Service (self-contained win-x64 executable)
dotnet publish .\worker\src\PrintBit.HardwareService\PrintBit.HardwareService.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -o C:\Users\printbit\printbit-worker
```

---

## 2. Configure Machine-Wide Environment Variables

In production, PrintBit relies on **Machine-Wide Environment Variables** rather than `.env` files. This ensures both the C# worker and Node.js tasks share the exact same configuration.

Run the following in **Administrator PowerShell** (adjust IPs/SSIDs as needed for your site deployment):

```powershell
# ============================================================
# Runtime
# ============================================================
[Environment]::SetEnvironmentVariable("NODE_ENV", "production", "Machine")
[Environment]::SetEnvironmentVariable("PORT", "3000", "Machine")

# ============================================================
# ESP32 Network & Hotspot
# ============================================================
[Environment]::SetEnvironmentVariable("PRINTBIT_NETWORK_PROVIDER", "esp32", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_HOTSPOT_SSID", "PrintBit", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_HOTSPOT_PASSWORD", "printbit123", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_HOTSPOT_AUTH_TYPE", "WPA", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_AP_BASE_URL", "http://192.168.4.1", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_KIOSK_IP", "192.168.4.2", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_KIOSK_SUBNET_PREFIX", "192.168.4.", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_KIOSK_NETMASK", "255.255.255.0", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_STATIC_IP_ENFORCE", "true", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_GATEWAY_IP", "192.168.4.1", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_CAPTIVE_PORTAL", "true", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_CAPTIVE_PORTAL_PATH", "/portal", "Machine")

# ============================================================
# ESP32 Security & Registration (MUST match firmware .ino)
# ============================================================
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_REGISTER_TOKEN", "printbit-register-token", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_COIN_SOURCE", "esp32", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_COIN_API_KEY", "printbit-coin-bridge-key", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_COIN_BRIDGE_RELAXED", "false", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_ESP32_ALWAYS_ACCEPT_COINS", "true", "Machine")

# ============================================================
# Hardware Serial (Arduino Uno / ESP32)
# ============================================================
[Environment]::SetEnvironmentVariable("PRINTBIT_SERIAL_PORT", "COM3", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_SERIAL_RECONNECT_BASE_MS", "2000", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_SERIAL_RECONNECT_MAX_MS", "30000", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_SERIAL_RECONNECT_MAX_ATTEMPTS", "0", "Machine")

# ============================================================
# Node.js <-> C# Worker Service IPC
# ============================================================
[Environment]::SetEnvironmentVariable("PRINTBIT_WORKER_QUEUE_DIR", "C:\Users\printbit\printbit-worker\queue", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_WORKER_FAILED_DIR", "C:\Users\printbit\printbit-worker\failed", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_WORKER_PIPE_NAME", "printbit-node-errors", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_WORKER_RETURN_PIPE_NAME", "printbit-worker-events", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_WORKER_COMMAND_PIPE_NAME", "printbit-worker-commands", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_WORKER_PRECHECKS_ENABLED", "true", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_WORKER_RETURN_MAX_BYTES", "8192", "Machine")

# ============================================================
# Worker Platform Integration Flags
# ============================================================
[Environment]::SetEnvironmentVariable("PRINTBIT_WORKER_DEFENDER_ENABLED", "true", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_WORKER_USB_ENABLED", "true", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_WORKER_TRUSTED_TIME_ENABLED", "true", "Machine")

# ============================================================
# Printing Tools & Spooler
# ============================================================
[Environment]::SetEnvironmentVariable("PRINTBIT_SUMATRA_PATH", "C:\Users\printbit\bin\SumatraPDF.exe", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_PRINT_DISPATCH_TIMEOUT_MS", "60000", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_PRINT_DISPATCH_LIBREOFFICE_TIMEOUT_MS", "120000", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_PRINT_SPOOLER_MONITOR_WINDOW_MS", "180000", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_PRINT_SPOOLER_POLL_INTERVAL_MS", "1500", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_PRINT_SPOOLER_LOOKBACK_MINUTES", "3", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_PRINT_SPOOLER_QUERY_TIMEOUT_MS", "20000", "Machine")

# ============================================================
# Kiosk Security, Lockdown & Session
# ============================================================
[Environment]::SetEnvironmentVariable("PRINTBIT_KIOSK_LOCKDOWN", "true", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_USB_EXPORT_ENABLED", "false", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_SKIP_EDGE_LAUNCH", "true", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_KIOSK_USER", ".\printbit", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_SESSION_EXPIRY_ENABLED", "true", "Machine")

# ============================================================
# Watchdog
# ============================================================
[Environment]::SetEnvironmentVariable("PRINTBIT_WATCHDOG_HTTP_TIMEOUT_MS", "10000", "Machine")
[Environment]::SetEnvironmentVariable("PRINTBIT_WATCHDOG_UNREACHABLE_RESTART_THRESHOLD", "3", "Machine")
```

---

## 3. Create Dedicated User Accounts

Separate the daily kiosk account from the administrator account to prevent unauthorized access and enable Assigned Access properly:

```powershell
net user printbit "KioskSecurePassword123!" /add
net user printbit-admin "AdminSecurePassword123!" /add
net localgroup Administrators printbit-admin /add
```

---

## 4. Register Services & Startup Tasks

### 4.1 Setup Worker Directories & Windows Service

```powershell
# Create queue and binary folders
New-Item -ItemType Directory -Path "C:\Users\printbit\printbit-worker\queue" -Force
New-Item -ItemType Directory -Path "C:\Users\printbit\printbit-worker\failed" -Force
New-Item -ItemType Directory -Path "C:\Users\printbit\bin" -Force
Copy-Item ".\bin\SumatraPDF.exe" "C:\Users\printbit\bin\SumatraPDF.exe" -Force

# Create high-quality logical printer queue pointing to same physical port
Add-Printer -Name "PrintBit - High" -DriverName "EPSON L5290 Series" -PortName "USB001"

# Register the C# Worker Service as LocalSystem
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

### 4.2 Verify Worker IPC Connectivity

```powershell
cd C:\Users\printbit\printbit
pnpm run worker-pipe:verify
```

### 4.3 Register Node.js Startup and Watchdog Tasks

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 -AtStartup
powershell -ExecutionPolicy Bypass -File .\scripts\install-watchdog.ps1 -AtStartup
pnpm run watchdog:verify
```

---

## 5. Configure Windows 10 Assigned Access (Kiosk Mode)

Lock the device to Microsoft Edge so users cannot access the desktop or settings:

1. Go to **Settings > Accounts > Family & other users > Set up assigned access** (or **Kiosk**).
2. Select the **`printbit`** local user created in Step 3.
3. Select **Microsoft Edge** as the kiosk app.
4. When prompted for the URL, enter: `http://192.168.4.2:3000/loading` (or `http://127.0.0.1:3000/loading`).

---

## 6. Apply Windows Update & Lockdown Policies

To prevent the tablet from forcefully restarting during operating hours and to apply system restrictions:

From `C:\Users\printbit\printbit` (Administrator PowerShell):

```powershell
pnpm run updates:apply
pnpm run lockdown:apply
pnpm run lockdown:verify
```

---

## 7. Secure Upload Storage & Verify Defender Gate

Isolate upload staging from standard kiosk users and verify fail-closed antivirus scanning:

```powershell
# Configure private SYSTEM/Admin ACLs on uploads/.staging and uploads/quarantine
pnpm run upload-storage:secure -- -KioskUser ".\printbit"

# Verify Defender health, signature freshness, and storage ACLs
pnpm run defender:verify
```

---

## Verification & Expected Startup Behavior

When you restart the tablet, the following occurs:

1. The tablet automatically signs in as the `printbit` kiosk user.
2. The `PrintBitHardware` service and the Node application launch in the background.
3. Assigned Access launches Microsoft Edge in full-screen digital signage mode directed to `/loading`.
4. The loading screen polls the backend until it is ready, then transitions smoothly into the main PrintBit UI.
5. `pnpm run worker-pipe:verify` passes with exit code 0.
