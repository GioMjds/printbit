<#
.SYNOPSIS
    PrintBit Kiosk Startup Script
    Self-elevates to Administrator, starts the PrintBit server,
    and launches Microsoft Edge in fullscreen kiosk mode.

.DESCRIPTION
    Drop this in your scripts\ folder alongside start-kiosk.bat.
    Double-click run.bat (or this file) — no manual "Run as Admin" needed.

.EXAMPLE
    Double-click run.bat   ← easiest
    Right-click → Run with PowerShell
#>

# ── 1. SELF-ELEVATION ────────────────────────────────────────────────────────
$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "[PrintBit] Not running as admin — re-launching elevated..." -ForegroundColor Yellow
    $psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell.exe -ArgumentList $psArgs -Verb RunAs
    exit
}

$isSystemAccount = $false
try {
    $isSystemAccount = ([Security.Principal.WindowsIdentity]::GetCurrent().Name -eq "NT AUTHORITY\SYSTEM")
} catch {
    $isSystemAccount = $false
}

# ── 2. RESOLVE PATHS ─────────────────────────────────────────────────────────
$ScriptsDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir  = Split-Path -Parent $ScriptsDir
$Port        = "3000"
$kioskLockdown = if ($env:PRINTBIT_KIOSK_LOCKDOWN) { $env:PRINTBIT_KIOSK_LOCKDOWN } else { 'true' }
$usbExportEnabled = if ($env:PRINTBIT_USB_EXPORT_ENABLED) { $env:PRINTBIT_USB_EXPORT_ENABLED } else { 'false' }
$networkProvider = [Environment]::GetEnvironmentVariable("PRINTBIT_NETWORK_PROVIDER")
if ([string]::IsNullOrWhiteSpace($networkProvider)) {
    $networkProvider = "esp32"
}
$networkProvider = $networkProvider.Trim().ToLowerInvariant()
$esp32KioskIp = [Environment]::GetEnvironmentVariable("PRINTBIT_ESP32_KIOSK_IP")
if ([string]::IsNullOrWhiteSpace($esp32KioskIp)) {
    $esp32KioskIp = "192.168.4.2"
}
$ensureEsp32NetworkScript = Join-Path $ScriptsDir "ensure-esp32-network.ps1"

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║         PrintBit Kiosk Launcher          ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "[PrintBit] Project  : $ProjectDir"  -ForegroundColor Gray
Write-Host "[PrintBit] Port     : $Port"         -ForegroundColor Gray
Write-Host "[PrintBit] Lockdown : $kioskLockdown" -ForegroundColor Gray
Write-Host "[PrintBit] USB Export Enabled : $usbExportEnabled" -ForegroundColor Gray
Write-Host ""

if ($networkProvider -eq "esp32") {
    if (Test-Path $ensureEsp32NetworkScript) {
        Write-Host "[PrintBit] Ensuring ESP32 Wi-Fi static IP profile..." -ForegroundColor Yellow
        try {
            & $ensureEsp32NetworkScript
        } catch {
            Write-Host "[PrintBit] WARNING: Could not fully enforce ESP32 static IP profile: $($_.Exception.Message)" -ForegroundColor Yellow
        }
        Write-Host ""
    } else {
        Write-Host "[PrintBit] WARNING: Missing network helper script at $ensureEsp32NetworkScript" -ForegroundColor Yellow
    }
}

# ── 3. VERIFY DEPENDENCIES ───────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[PrintBit] ERROR: node not found." -ForegroundColor Red
    Write-Host "           Install Node.js for this machine." -ForegroundColor Yellow
    Read-Host  "           Press Enter to exit"
    exit 1
}

$edgePath = "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edgePath)) {
    $edgePath = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $edgePath)) {
    Write-Host "[PrintBit] ERROR: Microsoft Edge not found." -ForegroundColor Red
    Read-Host  "           Press Enter to exit"
    exit 1
}

$serverBundlePath = Join-Path $ProjectDir "dist\server.js"
if (-not (Test-Path $serverBundlePath)) {
    Write-Host "[PrintBit] Compiled server bundle missing. Building dist\server.js..." -ForegroundColor Yellow
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        Write-Host "[PrintBit] ERROR: pnpm is required to build dist\server.js." -ForegroundColor Red
        Write-Host "           Run 'pnpm run build' once from project root." -ForegroundColor Yellow
        Read-Host  "           Press Enter to exit"
        exit 1
    }
    try {
        Push-Location $ProjectDir
        & $pnpm.Source run build
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $serverBundlePath)) {
            throw "build did not produce dist\server.js"
        }
    } catch {
        Write-Host "[PrintBit] ERROR: build failed: $($_.Exception.Message)" -ForegroundColor Red
        Read-Host  "           Press Enter to exit"
        exit 1
    } finally {
        Pop-Location
    }
}

# ── 4. VERIFY WINDOWS TIME (W32Time / NTP) ───────────────────────────────────
Write-Host "[PrintBit] Verifying Windows Time (W32Time)..." -ForegroundColor Yellow
$timeService = Get-Service -Name "W32Time" -ErrorAction SilentlyContinue
if (-not $timeService) {
    Write-Host "[PrintBit] WARNING: W32Time service not found. Trusted timestamps may be unavailable." -ForegroundColor Yellow
} else {
    if ($timeService.Status -ne "Running") {
        Write-Host "[PrintBit] Starting W32Time service..." -ForegroundColor Yellow
        try {
            Start-Service -Name "W32Time" -ErrorAction Stop
            Start-Sleep -Seconds 2
        } catch {
            Write-Host "[PrintBit] WARNING: Failed to start W32Time: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    try {
        $w32Status = & w32tm /query /status 2>&1
        $sourceLine = $w32Status | Where-Object { $_ -match '^\s*Source:\s*' } | Select-Object -First 1
        if ($sourceLine) {
            Write-Host "[PrintBit] Time source: $sourceLine" -ForegroundColor Gray
            if ($sourceLine -match 'Local CMOS Clock|Free-running System Clock') {
                Write-Host "[PrintBit] WARNING: System clock not NTP-synced. Financial actions may be blocked." -ForegroundColor Yellow
            }
        } else {
            Write-Host "[PrintBit] WARNING: Could not determine Windows time source." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[PrintBit] WARNING: w32tm status query failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ── 5. START PRINTBIT SERVER ─────────────────────────────────────────────────
Write-Host "[PrintBit] Starting compiled server (node dist\server.js)..." -ForegroundColor Green

$existingListener = Get-NetTCPConnection -State Listen -LocalPort ([int]$Port) -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
    Write-Host "[PrintBit] Server already listening on port $Port (PID $($existingListener.OwningProcess)). Skipping launch." -ForegroundColor Yellow
    $serverProc = Get-Process -Id $existingListener.OwningProcess -ErrorAction SilentlyContinue
} else {
    $prevLockdown = $env:PRINTBIT_KIOSK_LOCKDOWN
    $prevUsb = $env:PRINTBIT_USB_EXPORT_ENABLED
    try {
        $env:PRINTBIT_KIOSK_LOCKDOWN = $kioskLockdown
        $env:PRINTBIT_USB_EXPORT_ENABLED = $usbExportEnabled
        $serverProc = Start-Process node `
            -ArgumentList "dist/server.js" `
            -WorkingDirectory $ProjectDir `
            -WindowStyle Minimized `
            -PassThru
    } finally {
        $env:PRINTBIT_KIOSK_LOCKDOWN = $prevLockdown
        $env:PRINTBIT_USB_EXPORT_ENABLED = $prevUsb
    }
}

Write-Host "[PrintBit] Server PID: $($serverProc.Id)" -ForegroundColor Gray

# ── 6. WAIT FOR SERVER ───────────────────────────────────────────────────────
Write-Host "[PrintBit] Waiting for server on port $Port..." -ForegroundColor Yellow

$maxWait  = 30   # seconds
$interval = 1
$elapsed  = 0
$ready    = $false

while ($elapsed -lt $maxWait) {
    $conn = $null
    try {
        $conn = New-Object System.Net.Sockets.TcpClient
        $conn.Connect("127.0.0.1", [int]$Port)
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds $interval
        $elapsed += $interval
        Write-Host "  ...still waiting ($elapsed/$maxWait s)" -ForegroundColor DarkGray
    } finally {
        if ($conn) { $conn.Dispose() }
    }
}

if (-not $ready) {
    Write-Host "[PrintBit] WARNING: Server did not respond after $maxWait s — launching browser anyway." -ForegroundColor Yellow
}

# ── 7. RESOLVE LOCAL IP ──────────────────────────────────────────────────────
# In ESP32 mode, use the configured/static kiosk IP so Edge always opens
# the same address expected by the ESP32 captive portal firmware.
$localIP = $null
if ($networkProvider -eq "esp32") {
    $localIP = $esp32KioskIp
    Write-Host "[PrintBit] ESP32 mode detected. Using kiosk IP: $localIP" -ForegroundColor Gray
} else {
    # Prefer hotspot-style ranges (e.g. 192.168.4.x / 192.168.137.x) so the
    # kiosk URL matches what clients on the Wi‑Fi hotspot can actually reach.
    $ipCandidates = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notmatch "^127\." -and $_.PrefixOrigin -ne "WellKnown" }
    $preferred = $ipCandidates |
        Where-Object {
            $_.IPAddress -like "192.168.137.*" -or
            $_.IPAddress -like "192.168.4.*"
        } |
        Select-Object -First 1
    if (-not $preferred) {
        $preferred = $ipCandidates | Select-Object -First 1
    }
    $localIP = if ($preferred) { $preferred.IPAddress } else { $null }
}

$kioskHost = [Environment]::GetEnvironmentVariable("PRINTBIT_KIOSK_HOST")
if ([string]::IsNullOrWhiteSpace($kioskHost)) {
    $kioskHost = "127.0.0.1"
}
$kioskUrl = "http://${kioskHost}:${Port}/loading"
Write-Host "[PrintBit] Kiosk URL: $kioskUrl" -ForegroundColor Cyan
if ($localIP) {
    Write-Host "[PrintBit] External Wi-Fi IP (for clients): http://${localIP}:${Port}/" -ForegroundColor Gray
}

# ── 8. LAUNCH EDGE IN KIOSK MODE ─────────────────────────────────────────────
function Is-Truthy {
    param([string]$RawValue)
    if ([string]::IsNullOrWhiteSpace($RawValue)) { return $false }
    return @("1", "true", "yes", "on") -contains $RawValue.Trim().ToLowerInvariant()
}

$skipEdgeLaunch = Is-Truthy -RawValue ([Environment]::GetEnvironmentVariable("PRINTBIT_SKIP_EDGE_LAUNCH"))
$configuredKioskUser = [Environment]::GetEnvironmentVariable("PRINTBIT_KIOSK_USER")
if (-not [string]::IsNullOrWhiteSpace($configuredKioskUser)) {
    $kioskShort = $configuredKioskUser.Trim() -replace '^[^\\]+\\', ''
    $currentShort = [Security.Principal.WindowsIdentity]::GetCurrent().Name -replace '^[^\\]+\\', ''
    if ($kioskShort -eq $currentShort) {
        $skipEdgeLaunch = $true
    }
}

if ($isSystemAccount -or $skipEdgeLaunch) {
    $assignedAccessHost = "127.0.0.1"
    if ($isSystemAccount) {
        Write-Host "[PrintBit] Running as SYSTEM. Skipping Edge launch in Session 0." -ForegroundColor Yellow
    } else {
        Write-Host "[PrintBit] Assigned Access kiosk session detected. Skipping managed Edge launch." -ForegroundColor Yellow
    }
    Write-Host "[PrintBit] Assigned Access should open Edge at http://${assignedAccessHost}:$Port/loading." -ForegroundColor Green
} else {
    Write-Host "[PrintBit] Launching Edge in kiosk mode..." -ForegroundColor Green
    Start-Process $edgePath -ArgumentList @(
        "--kiosk", $kioskUrl,
        "--edge-kiosk-type=fullscreen",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-features=TranslateUI"
    )
}

Write-Host ""
Write-Host "[PrintBit] ✓ Kiosk is live at $kioskUrl" -ForegroundColor Green
Write-Host ""

# Keep the window open briefly so any errors are visible, then fade out
Start-Sleep -Seconds 4
