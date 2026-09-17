<#
.SYNOPSIS
    PrintBit - Printer Power & Spooler Remediation Script
    Fixes Windows 10 tablet USB sleep/suspend, clears stuck queues, and restarts the spooler.

.DESCRIPTION
    Run this script on the kiosk tablet as Administrator to:
    1. Disable USB Selective Suspend (AC & Battery power).
    2. Disable tablet standby/sleep timeouts while plugged in.
    3. Disable USB Hub power-saving ("Allow computer to turn off this device").
    4. Stop the Spooler, purge stuck .SPL/.SHD spool files, and restart the Spooler.
    5. Verify printer port and status for 'EPSON L5290 Series'.

.EXAMPLE
    Right-click -> Run with PowerShell (or run in elevated Administrator terminal)
#>

[CmdletBinding()]
param(
    [switch]$SkipQueuePurge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "  PrintBit: Printer Power & Spooler Remediation Script   " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Check Elevation ────────────────────────────────────────────────────────
$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "[PrintBit] Re-launching script as Administrator..." -ForegroundColor Yellow
    $processArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell.exe -ArgumentList $processArgs -Verb RunAs
    exit
}

# ── 2. Windows Power Settings (Disable Sleep & USB Suspend) ───────────────────
Write-Host "[1/5] Configuring Windows Power Management..." -ForegroundColor Green

try {
    # Active power scheme GUID
    $activeScheme = (powercfg /getactivescheme) -replace '^.+:\s*([a-f0-9-]+)\s*\(.+', '$1'
    if ([string]::IsNullOrWhiteSpace($activeScheme) -or $activeScheme.Length -ne 36) {
        $activeScheme = "SCHEME_CURRENT"
    }

    # USB Selective Suspend GUIDs:
    # Subgroup: 2a737441-1930-4402-8d77-b2bebba4d67b (USB settings)
    # Setting:  48e6b7a6-50f5-4782-a5d4-53bb8f07e226 (USB selective suspend)
    # Value: 0 = Disabled, 1 = Enabled
    Write-Host "  -> Disabling USB Selective Suspend (AC & DC)..." -ForegroundColor Gray
    powercfg /SETACVALUEINDEX $activeScheme 2a737441-1930-4402-8d77-b2bebba4d67b 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0
    powercfg /SETDCVALUEINDEX $activeScheme 2a737441-1930-4402-8d77-b2bebba4d67b 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0

    # Sleep timeout: 0 = Never
    # Subgroup: 238c9fa8-0041-4145-8969-2422c7d2c020 (Sleep)
    # Setting:  29f6c1db-86da-48c5-9fdb-f2b67b1f44da (Standby timeout)
    Write-Host "  -> Setting Tablet Sleep timeout to Never (AC)..." -ForegroundColor Gray
    powercfg /SETACVALUEINDEX $activeScheme 238c9fa8-0041-4145-8969-2422c7d2c020 29f6c1db-86da-48c5-9fdb-f2b67b1f44da 0

    # Hibernate timeout: 0 = Never
    powercfg /SETACVALUEINDEX $activeScheme 238c9fa8-0041-4145-8969-2422c7d2c020 9d781570-7041-4ebe-bc02-4e5487e07ac3 0

    # Re-apply active scheme
    powercfg /SETACTIVE $activeScheme

    # Turn off OS hibernation completely
    powercfg /h off

    Write-Host "  [OK] Windows power scheme updated successfully." -ForegroundColor Green
} catch {
    Write-Host "  [WARN] Failed to adjust some powercfg settings: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ── 3. Disable USB Hub Power Savings in Device Manager ─────────────────────────
Write-Host "[2/5] Hardening USB Hub power saving states in registry..." -ForegroundColor Green

try {
    # Target USB devices and disable selective suspend/power-down in registry
    $usbHubPaths = Get-ChildItem -Path "HKLM:\SYSTEM\CurrentControlSet\Enum\USB" -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.PSChildName -eq "Device Parameters" }

    $modifiedCount = 0
    foreach ($dp in $usbHubPaths) {
        $path = $dp.PSPath
        try {
            # DeviceSelectiveSuspended: 0 = Do not suspend
            Set-ItemProperty -Path $path -Name "DeviceSelectiveSuspended" -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
            # EnhancedPowerManagementEnabled: 0 = Disabled
            Set-ItemProperty -Path $path -Name "EnhancedPowerManagementEnabled" -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
            # AllowIdleIrpInD3: 0 = Do not allow D3 idle powerdown
            Set-ItemProperty -Path $path -Name "AllowIdleIrpInD3" -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
            $modifiedCount++
        } catch {
            # Continue on protected entries
        }
    }
    Write-Host "  [OK] Updated $modifiedCount USB hardware device parameter branches." -ForegroundColor Green
} catch {
    Write-Host "  [WARN] USB registry pass encountered: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ── 4. Clear Print Spooler Queue & Restart Spooler ───────────────────────────
Write-Host "[3/5] Cleaning stuck print queue jobs and resetting Spooler..." -ForegroundColor Green

if ($SkipQueuePurge) {
    Write-Host "  -> Skipping queue purge by request." -ForegroundColor Gray
} else {
    try {
        Write-Host "  -> Stopping Print Spooler service..." -ForegroundColor Gray
        Stop-Service -Name "Spooler" -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2

        $spoolDir = "$env:SystemRoot\System32\spool\PRINTERS"
        if (Test-Path $spoolDir) {
            $stuckFiles = Get-ChildItem -Path $spoolDir -Include *.spl,*.shd,*.tmp -Recurse -Force -ErrorAction SilentlyContinue
            if ($stuckFiles.Count -gt 0) {
                Write-Host "  -> Removing $($stuckFiles.Count) stuck spooler files (.spl / .shd)..." -ForegroundColor Yellow
                $stuckFiles | Remove-Item -Force -ErrorAction SilentlyContinue
            } else {
                Write-Host "  -> No pending files found in spool directory." -ForegroundColor Gray
            }
        }

        Write-Host "  -> Starting Print Spooler service..." -ForegroundColor Gray
        Start-Service -Name "Spooler" -ErrorAction Stop
        Start-Sleep -Seconds 2

        $spooler = Get-Service -Name "Spooler"
        if ($spooler.Status -eq "Running") {
            Write-Host "  [OK] Print Spooler service is Running." -ForegroundColor Green
        } else {
            Write-Host "  [ERROR] Print Spooler status is: $($spooler.Status)" -ForegroundColor Red
        }
    } catch {
        Write-Host "  [ERROR] Spooler reset failed: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ── 5. Query Printer Status & Hardware Health ─────────────────────────────────
Write-Host "[4/5] Checking Epson Printer detection..." -ForegroundColor Green

$printer = Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Name -like "*L5290*" -or $_.Name -like "*Epson*" } | Select-Object -First 1

if ($printer) {
    Write-Host "  -> Found Printer : $($printer.Name)" -ForegroundColor Green
    Write-Host "  -> Port Name     : $($printer.PortName)" -ForegroundColor Gray
    Write-Host "  -> Status        : $($printer.Status)" -ForegroundColor Gray
    $offlineColor = if ($printer.WorkOffline) { "Red" } else { "Green" }
    Write-Host "  -> Work Offline  : $($printer.WorkOffline)" -ForegroundColor $offlineColor
    Write-Host "  -> PrinterState  : $($printer.PrinterState)" -ForegroundColor Gray

    if ($printer.WorkOffline) {
        Write-Host "  [WARN] Printer is marked Offline in Windows! Attempting to set Online..." -ForegroundColor Yellow
        try {
            $wmiPrinter = [wmi]"\\.\root\cimv2:Win32_Printer.DeviceID='$($printer.DeviceID)'"
            $wmiPrinter.WorkOffline = $false
            $wmiPrinter.Put() | Out-Null
            Write-Host "  [OK] Printer WorkOffline property reset to False." -ForegroundColor Green
        } catch {
            Write-Host "  [WARN] Could not programmatically unset WorkOffline: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "  [NOTICE] No Epson L5290 printer currently detected over USB." -ForegroundColor Yellow
    Write-Host "           (Expected if the printer is currently disconnected or powered off)." -ForegroundColor Gray
}

# ── 6. Verification Summary ───────────────────────────────────────────────────
Write-Host "[5/5] Checking Hardware Service status..." -ForegroundColor Green

$hwService = Get-Service -Name "PrintBitHardware" -ErrorAction SilentlyContinue
if ($hwService) {
    $hwColor = if ($hwService.Status -eq "Running") { "Green" } else { "Yellow" }
    Write-Host "  -> PrintBitHardware Service Status : $($hwService.Status)" -ForegroundColor $hwColor
} else {
    Write-Host "  -> PrintBitHardware Service        : Not installed (check WINDOWS_10_PRODUCTION_DEPLOYMENT_QUICKSTART.md)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "  REMEDIATION COMPLETE!                                  " -ForegroundColor Green
Write-Host "  Remember to also check the Epson Printer LCD screen:   " -ForegroundColor Yellow
Write-Host "    Settings > Common Settings > Eco Mode / Power Off    " -ForegroundColor Yellow
Write-Host "    -> Set 'Power Off if Inactive' to OFF / NEVER.       " -ForegroundColor Yellow
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ""

Start-Sleep -Seconds 3
