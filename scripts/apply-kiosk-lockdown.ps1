#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Applies PrintBit Windows kiosk lockdown policies.

.DESCRIPTION
  Enables OS-level restrictions for kiosk deployments:
  - Disable notifications and tray interactions
  - Disable screen-edge swipe gestures
  - Restrict Settings/Control Panel and Task Manager
  - Block common escape shortcuts where policy supports it
  - Block USB mass storage access
  - Optionally disable Windows keys through Scancode Map

  A reboot is recommended after applying.
#>

[CmdletBinding()]
param(
  [switch]$DisableWinKeys
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$helpersModule = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'kiosk-helpers.psm1'
Import-Module $helpersModule -Force

function Ensure-RegistryKey {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path $Path)) {
    New-Item -Path $Path -Force | Out-Null
  }
}

function Set-DwordValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][int]$Value
  )
  Ensure-RegistryKey -Path $Path
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType DWord -Force | Out-Null
}

function Set-BinaryValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][byte[]]$Value
  )
  Ensure-RegistryKey -Path $Path
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType Binary -Force | Out-Null
}

$policyExplorer    = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Explorer'
$policyEdgeUi      = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\EdgeUI'
$policyEdgeBrowser = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
$policySystem      = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System'
$legacyExplorer    = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer'
$legacySystem      = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$usbStor           = 'HKLM:\SYSTEM\CurrentControlSet\Services\USBSTOR'
$removablePolicy   = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices'
$keyboardLayout    = 'HKLM:\SYSTEM\CurrentControlSet\Control\Keyboard Layout'
$printBitState     = 'HKLM:\SOFTWARE\PrintBit\KioskLockdown'

Write-Host "[PrintBit] Applying kiosk lockdown policy..." -ForegroundColor Cyan

# Notification / tray hardening
Set-DwordValue -Path $policyExplorer -Name 'DisableNotificationCenter' -Value 1
Set-DwordValue -Path $policyExplorer -Name 'NoTrayContextMenu'         -Value 1
Set-DwordValue -Path $policyExplorer -Name 'NoTrayItemsDisplay'        -Value 1
Set-DwordValue -Path $policyEdgeUi   -Name 'AllowEdgeSwipe'            -Value 0
# NOTE: AllowEdgeSwipe (above) is the legacy Windows *shell* edge-swipe policy
# (Charms/Action Center era) and does NOT affect Microsoft Edge's own touch
# back/forward gesture. This is the correct Edge-browser policy for that:
Set-DwordValue -Path $policyEdgeBrowser -Name 'EdgeSwipeNavigationEnabled' -Value 0
# Edge kiosk startup acceleration: prevent first-run dialogs, background tasks, and telemetry at boot
Set-DwordValue -Path $policyEdgeBrowser -Name 'HideFirstRunExperience'     -Value 1
Set-DwordValue -Path $policyEdgeBrowser -Name 'MetricsReportingEnabled'    -Value 0
Set-DwordValue -Path $policyEdgeBrowser -Name 'AutoImportAtFirstRun'       -Value 4
Set-DwordValue -Path $policyEdgeBrowser -Name 'BackgroundModeEnabled'      -Value 0

# Settings / shell / shortcut hardening
Set-DwordValue -Path $legacyExplorer -Name 'NoControlPanel' -Value 1
Set-DwordValue -Path $legacyExplorer -Name 'NoWinKeys'      -Value 1
Set-DwordValue -Path $legacyExplorer -Name 'NoAltTab'       -Value 1
Set-DwordValue -Path $policySystem   -Name 'DisableCMD'     -Value 1
Set-DwordValue -Path $legacySystem   -Name 'DisableTaskMgr' -Value 1

# USB mass-storage hardening
Ensure-RegistryKey -Path $printBitState
$existingUsbStorStart = Get-DwordValueOrNull -Path $usbStor -Name 'Start'
$savedUsbStorStart = Get-DwordValueOrNull -Path $printBitState -Name 'UsbStorStartOriginal'
if ($null -eq $savedUsbStorStart -and $null -ne $existingUsbStorStart) {
  Set-DwordValue -Path $printBitState -Name 'UsbStorStartOriginal' -Value $existingUsbStorStart
}
Set-DwordValue -Path $usbStor          -Name 'Start'    -Value 4
Set-DwordValue -Path $removablePolicy  -Name 'Deny_All' -Value 1

if ($DisableWinKeys) {
  # Disable Left Win (E05B), Right Win (E05C), and Apps/Menu key (E05D).
  $scancodeMap = [byte[]](
    0x00,0x00,0x00,0x00,
    0x00,0x00,0x00,0x00,
    0x04,0x00,0x00,0x00,
    0x00,0x00,0x5B,0xE0,
    0x00,0x00,0x5C,0xE0,
    0x00,0x00,0x5D,0xE0,
    0x00,0x00,0x00,0x00
  )
  Set-BinaryValue -Path $keyboardLayout -Name 'Scancode Map' -Value $scancodeMap
  Write-Host "[PrintBit] Win keys and Apps key disabled via Scancode Map." -ForegroundColor Yellow
}

Ensure-RegistryKey -Path $printBitState
Set-DwordValue -Path $printBitState -Name 'Applied' -Value 1
New-ItemProperty -Path $printBitState -Name 'AppliedAtUtc' -Value ([DateTime]::UtcNow.ToString('o')) -PropertyType String -Force | Out-Null
New-ItemProperty -Path $printBitState -Name 'Version'      -Value '3' -PropertyType String -Force | Out-Null

Write-Host ""
Write-Host "[PrintBit] [OK] Lockdown policies applied."  -ForegroundColor Green
Write-Host "[PrintBit]   Recommended next steps:"        -ForegroundColor Cyan
Write-Host "[PrintBit]   1) Configure Assigned Access (single-app kiosk)." -ForegroundColor Gray
Write-Host "[PrintBit]   2) Reboot the device."                            -ForegroundColor Gray
Write-Host "[PrintBit]   3) Run scripts\verify-kiosk-lockdown.ps1."        -ForegroundColor Gray
Write-Host ""