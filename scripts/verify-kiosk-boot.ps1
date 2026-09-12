[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptsDir
$TaskName = 'PrintBit Kiosk'
$ServerBundlePath = Join-Path $ProjectDir 'dist\server.js'
$LogPath = Join-Path $ProjectDir 'uploads\logs\kiosk-server-startup.log'
$Port = 3000

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

Write-Host ''
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host '    PrintBit Kiosk Boot Configuration Check       ' -ForegroundColor Cyan
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host ''

$checks = @()

# 1. Check Server Bundle
$bundleExists = Test-Path $ServerBundlePath
$bundleDetail = 'dist\server.js MISSING! Run pnpm run build before boot.'
if ($bundleExists) {
    $size = (Get-Item $ServerBundlePath).Length
    $bundleDetail = "dist\server.js exists: $size bytes"
}
$checks += [pscustomobject]@{
    Name = 'Server bundle present'
    Passed = $bundleExists
    Detail = $bundleDetail
}

# 2. Check Scheduled Task
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$taskRegistered = ($null -ne $task)
$taskDetail = 'Task not found. Run pnpm run install-startup.'
if ($taskRegistered) {
    $taskDetail = 'State=' + $task.State
}
$checks += [pscustomobject]@{
    Name = "Task '$TaskName' registered"
    Passed = $taskRegistered
    Detail = $taskDetail
}

if ($taskRegistered) {
    # Check Action points to start-kiosk-server.ps1
    $action = $task.Actions | Select-Object -First 1
    $isServerScript = $false
    $actionDesc = 'No action found'
    if ($action) {
        $actionDesc = "$($action.Execute) $($action.Arguments)"
        if ($actionDesc -match 'start-kiosk-server\.ps1') {
            $isServerScript = $true
        }
    }
    $checks += [pscustomobject]@{
        Name = 'Task action executes start-kiosk-server.ps1'
        Passed = $isServerScript
        Detail = $actionDesc
    }

    # Check Trigger is AtStartup (MSFT_TaskBootTrigger)
    $triggers = @($task.Triggers)
    $hasBootTrigger = $false
    foreach ($trig in $triggers) {
        if ($trig.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger') {
            $hasBootTrigger = $true
            break
        }
    }
    $triggerDetail = 'Missing AtStartup trigger'
    if ($hasBootTrigger) {
        $triggerDetail = 'Boot trigger confirmed'
    }
    $checks += [pscustomobject]@{
        Name = 'Task trigger is AtStartup'
        Passed = $hasBootTrigger
        Detail = $triggerDetail
    }

    # Check Task Priority is High (1 or 2)
    $priority = [int]$task.Settings.Priority
    $highPriority = ($priority -le 2)
    $checks += [pscustomobject]@{
        Name = 'Task priority is high (Priority 1 or 2)'
        Passed = $highPriority
        Detail = "Priority=$priority"
    }

    # Check Principal
    $principal = $task.Principal
    $userId = if ($principal) { [string]$principal.UserId } else { 'Unknown' }
    $isSystemOrAdmin = ($userId -eq 'SYSTEM' -or $userId -eq 'NT AUTHORITY\SYSTEM' -or $principal.RunLevel -eq 'Highest')
    $checks += [pscustomobject]@{
        Name = 'Task runs with elevated/SYSTEM principal'
        Passed = $isSystemOrAdmin
        Detail = "UserId=$userId, RunLevel=$($principal.RunLevel)"
    }
}

# 3. Check Edge Policies
$edgePolicyKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
if (Test-Path $edgePolicyKey) {
    $hideFirstRunProp = Get-ItemProperty -Path $edgePolicyKey -Name 'HideFirstRunExperience' -ErrorAction SilentlyContinue
    $hideFirstRun = if ($null -ne $hideFirstRunProp) { $hideFirstRunProp.HideFirstRunExperience } else { $null }
    $checks += [pscustomobject]@{
        Name = 'Edge HideFirstRunExperience policy'
        Passed = ($hideFirstRun -eq 1)
        Detail = "HideFirstRunExperience=$hideFirstRun"
    }
} else {
    $checks += [pscustomobject]@{
        Name = 'Edge kiosk policies applied'
        Passed = $false
        Detail = "Key $edgePolicyKey not found. Run pnpm run lockdown:apply."
    }
}

# 4. Check Current Runtime Status
$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
$isListening = ($null -ne $listener)
$listenerDetail = 'Port ' + $Port + ' is not currently listening'
if ($isListening) {
    $listenerDetail = 'Port ' + $Port + ' listening (PID ' + $listener.OwningProcess + ')'
}
$checks += [pscustomobject]@{
    Name = 'HTTP server listening on port ' + $Port
    Passed = $isListening
    Detail = $listenerDetail
}

# Display all check results
foreach ($check in $checks) {
    Write-Check -Name $check.Name -Passed ([bool]$check.Passed) -Detail $check.Detail
}

# 5. Show recent startup logs if available
if (Test-Path $LogPath) {
    Write-Host ''
    Write-Host '--- Recent kiosk-server-startup.log (last 10 lines) ---' -ForegroundColor Gray
    Get-Content -Path $LogPath -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host ('  ' + $_) -ForegroundColor DarkGray
    }
}

$failCount = ($checks | Where-Object { -not $_.Passed }).Count
Write-Host ''
if ($failCount -eq 0) {
    Write-Host '[PrintBit] [OK] All boot configuration checks passed.' -ForegroundColor Green
    exit 0
} else {
    Write-Host ('[PrintBit] [!!] ' + $failCount + ' check(s) need attention.') -ForegroundColor Yellow
    exit 1
}
