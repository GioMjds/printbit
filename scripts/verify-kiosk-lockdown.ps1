#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Verifies PrintBit Windows kiosk lockdown posture.

.DESCRIPTION
  Checks registry-based lockdown indicators and prints PASS/FAIL per control.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-DwordOrNull {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-Path $Path)) { return $null }
  $item = Get-ItemProperty -Path $Path -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  if ($item.PSObject.Properties.Name -contains $Name) {
    return [int]$item.$Name
  }
  return $null
}

function Write-Check {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$Passed,
    [Parameter(Mandatory = $true)][string]$Detail
  )
  $prefix = if ($Passed) { '[PASS]' } else { '[FAIL]' }
  $color  = if ($Passed) { 'Green' } else { 'Red' }
  Write-Host "$prefix $Name - $Detail" -ForegroundColor $color
}

$checks = @()

$policyExplorer  = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Explorer'
$policyEdgeUi    = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\EdgeUI'
$policyEdgeBrowser = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
$policySystem    = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System'
$legacyExplorer  = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer'
$legacySystem    = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$usbStor         = 'HKLM:\SYSTEM\CurrentControlSet\Services\USBSTOR'
$removablePolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices'
$printBitState   = 'HKLM:\SOFTWARE\PrintBit\KioskLockdown'

$disableNotificationCenter = Get-DwordOrNull -Path $policyExplorer  -Name 'DisableNotificationCenter'
$noTrayContextMenu         = Get-DwordOrNull -Path $policyExplorer  -Name 'NoTrayContextMenu'
$noTrayItemsDisplay        = Get-DwordOrNull -Path $policyExplorer  -Name 'NoTrayItemsDisplay'
$allowEdgeSwipe            = Get-DwordOrNull -Path $policyEdgeUi    -Name 'AllowEdgeSwipe'
$edgeSwipeNavigation       = Get-DwordOrNull -Path $policyEdgeBrowser -Name 'EdgeSwipeNavigationEnabled'
$hideFirstRun              = Get-DwordOrNull -Path $policyEdgeBrowser -Name 'HideFirstRunExperience'
$metricsReporting          = Get-DwordOrNull -Path $policyEdgeBrowser -Name 'MetricsReportingEnabled'
$autoImportAtFirstRun      = Get-DwordOrNull -Path $policyEdgeBrowser -Name 'AutoImportAtFirstRun'
$backgroundMode            = Get-DwordOrNull -Path $policyEdgeBrowser -Name 'BackgroundModeEnabled'
$noControlPanel            = Get-DwordOrNull -Path $legacyExplorer  -Name 'NoControlPanel'
$noWinKeys                 = Get-DwordOrNull -Path $legacyExplorer  -Name 'NoWinKeys'
$noAltTab                  = Get-DwordOrNull -Path $legacyExplorer  -Name 'NoAltTab'
$disableTaskMgr            = Get-DwordOrNull -Path $legacySystem    -Name 'DisableTaskMgr'
$disableCmd                = Get-DwordOrNull -Path $policySystem    -Name 'DisableCMD'
$usbStorStart              = Get-DwordOrNull -Path $usbStor         -Name 'Start'
$denyAllRemovable          = Get-DwordOrNull -Path $removablePolicy -Name 'Deny_All'
$applied                   = Get-DwordOrNull -Path $printBitState   -Name 'Applied'

$checks += [pscustomobject]@{ Name = 'Notifications disabled';        Passed = ($disableNotificationCenter -eq 1); Detail = "DisableNotificationCenter=$disableNotificationCenter" }
$checks += [pscustomobject]@{ Name = 'Tray context blocked';          Passed = ($noTrayContextMenu -eq 1);         Detail = "NoTrayContextMenu=$noTrayContextMenu" }
$checks += [pscustomobject]@{ Name = 'Tray items hidden';             Passed = ($noTrayItemsDisplay -eq 1);        Detail = "NoTrayItemsDisplay=$noTrayItemsDisplay" }
$checks += [pscustomobject]@{ Name = 'Shell edge-swipe blocked';      Passed = ($allowEdgeSwipe -eq 0);            Detail = "AllowEdgeSwipe=$allowEdgeSwipe" }
$checks += [pscustomobject]@{ Name = 'Edge browser swipe-nav blocked';Passed = ($edgeSwipeNavigation -eq 0);       Detail = "EdgeSwipeNavigationEnabled=$edgeSwipeNavigation" }
$checks += [pscustomobject]@{ Name = 'Edge first-run exp hidden';     Passed = ($hideFirstRun -eq 1);              Detail = "HideFirstRunExperience=$hideFirstRun" }
$checks += [pscustomobject]@{ Name = 'Edge telemetry disabled';       Passed = ($metricsReporting -eq 0);          Detail = "MetricsReportingEnabled=$metricsReporting" }
$checks += [pscustomobject]@{ Name = 'Edge background mode disabled'; Passed = ($backgroundMode -eq 0);            Detail = "BackgroundModeEnabled=$backgroundMode" }
$checks += [pscustomobject]@{ Name = 'Settings/Control Panel blocked';Passed = ($noControlPanel -eq 1);           Detail = "NoControlPanel=$noControlPanel" }
$checks += [pscustomobject]@{ Name = 'Windows shortcut keys blocked'; Passed = ($noWinKeys -eq 1);                Detail = "NoWinKeys=$noWinKeys" }
$checks += [pscustomobject]@{ Name = 'Alt+Tab blocked';               Passed = ($noAltTab -eq 1);                 Detail = "NoAltTab=$noAltTab" }
$checks += [pscustomobject]@{ Name = 'Task Manager blocked';          Passed = ($disableTaskMgr -eq 1);           Detail = "DisableTaskMgr=$disableTaskMgr" }
$checks += [pscustomobject]@{ Name = 'Command prompt blocked';        Passed = ($disableCmd -eq 1);               Detail = "DisableCMD=$disableCmd" }
$checks += [pscustomobject]@{ Name = 'USB storage service disabled';  Passed = ($usbStorStart -eq 4);             Detail = "USBSTOR.Start=$usbStorStart" }
$checks += [pscustomobject]@{ Name = 'Removable storage denied';      Passed = ($denyAllRemovable -eq 1);         Detail = "Deny_All=$denyAllRemovable" }
$checks += [pscustomobject]@{ Name = 'PrintBit lockdown state applied';Passed = ($applied -eq 1);                 Detail = "PrintBitApplied=$applied" }

Write-Host ""
Write-Host "[PrintBit] Kiosk lockdown verification" -ForegroundColor Cyan
Write-Host ""

foreach ($check in $checks) {
  Write-Check -Name $check.Name -Passed ([bool]$check.Passed) -Detail $check.Detail
}

$failCount = ($checks | Where-Object { -not $_.Passed }).Count
Write-Host ""
if ($failCount -eq 0) {
  Write-Host "[PrintBit] [OK] All lockdown checks passed." -ForegroundColor Green
  Write-Host "[PrintBit] Run 'pnpm run defender:verify' to verify Defender upload gate and private storage isolation." -ForegroundColor Cyan
  exit 0
}

Write-Host "[PrintBit] [!!] $failCount check(s) failed." -ForegroundColor Red
exit 1