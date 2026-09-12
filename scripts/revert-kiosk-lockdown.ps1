#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Reverts PrintBit Windows kiosk lockdown policies for maintenance.

.DESCRIPTION
  Restores policy values changed by apply-kiosk-lockdown.ps1.
  A reboot is recommended after revert.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$helpersModule = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'kiosk-helpers.psm1'
Import-Module $helpersModule -Force

function Remove-RegistryValueIfExists {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-Path $Path)) { return }
  $value = Get-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue
  if ($null -ne $value) {
    Remove-ItemProperty -Path $Path -Name $Name -Force -ErrorAction SilentlyContinue
  }
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

Write-Host "[PrintBit] Reverting kiosk lockdown policy..." -ForegroundColor Cyan

Remove-RegistryValueIfExists -Path $policyExplorer    -Name 'DisableNotificationCenter'
Remove-RegistryValueIfExists -Path $policyExplorer    -Name 'NoTrayContextMenu'
Remove-RegistryValueIfExists -Path $policyExplorer    -Name 'NoTrayItemsDisplay'
Remove-RegistryValueIfExists -Path $policyEdgeUi      -Name 'AllowEdgeSwipe'
Remove-RegistryValueIfExists -Path $policyEdgeBrowser -Name 'EdgeSwipeNavigationEnabled'
Remove-RegistryValueIfExists -Path $policyEdgeBrowser -Name 'HideFirstRunExperience'
Remove-RegistryValueIfExists -Path $policyEdgeBrowser -Name 'MetricsReportingEnabled'
Remove-RegistryValueIfExists -Path $policyEdgeBrowser -Name 'AutoImportAtFirstRun'
Remove-RegistryValueIfExists -Path $policyEdgeBrowser -Name 'BackgroundModeEnabled'
Remove-RegistryValueIfExists -Path $legacyExplorer    -Name 'NoControlPanel'
Remove-RegistryValueIfExists -Path $legacyExplorer    -Name 'NoWinKeys'
Remove-RegistryValueIfExists -Path $legacyExplorer    -Name 'NoAltTab'
Remove-RegistryValueIfExists -Path $policySystem      -Name 'DisableCMD'
Remove-RegistryValueIfExists -Path $legacySystem      -Name 'DisableTaskMgr'
Remove-RegistryValueIfExists -Path $removablePolicy   -Name 'Deny_All'

if (Test-Path $usbStor) {
  $restoredStart = Get-DwordValueOrNull -Path $printBitState -Name 'UsbStorStartOriginal'
  if ($null -eq $restoredStart) {
    Write-Warning "[PrintBit] Missing persisted UsbStorStartOriginal in '$printBitState'. Applying fallback Start=3 to '$usbStor'."
    $restoredStart = 3
  }
  New-ItemProperty -Path $usbStor -Name 'Start' -Value ([int]$restoredStart) -PropertyType DWord -Force | Out-Null
}

Remove-RegistryValueIfExists -Path $keyboardLayout -Name 'Scancode Map'

if (Test-Path $printBitState) {
  Remove-RegistryValueIfExists -Path $printBitState -Name 'UsbStorStartOriginal'
  New-ItemProperty -Path $printBitState -Name 'Applied'       -Value 0 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $printBitState -Name 'RevertedAtUtc' -Value ([DateTime]::UtcNow.ToString('o')) -PropertyType String -Force | Out-Null
}

Write-Host ""
Write-Host "[PrintBit] [OK] Lockdown policies reverted for maintenance."           -ForegroundColor Green
Write-Host "[PrintBit]   Reboot recommended, then re-apply lockdown before deployment." -ForegroundColor Yellow
Write-Host ""
