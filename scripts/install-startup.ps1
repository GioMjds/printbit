<#
.SYNOPSIS
    Registers PrintBit as a Windows Scheduled Task for kiosk startup.

.DESCRIPTION
    Creates a scheduled task "PrintBit Kiosk" that:
    - Triggers at user logon or machine startup
    - Runs with highest privileges
    - Launches start-kiosk.bat from the scripts\ directory
    - Supports SYSTEM principal for cross-account kiosk deployments
    - Supports explicit kiosk-user startup task registration
    - Targets the kiosk account for Assigned Access Edge scenarios (server-only startup)

.EXAMPLE
    # Run from Administrator PowerShell:
    .\scripts\install-startup.ps1

    # To remove the task later:
    .\scripts\install-startup.ps1 -Uninstall
#>

param(
    [switch]$Uninstall,
    [switch]$AtStartup,
    [switch]$RunAsSystem,
    [string]$KioskUser,
    [ValidateSet('Parallel', 'Queue', 'IgnoreNew', 'StopExisting')]
    [string]$MultipleInstances = 'IgnoreNew'
)

$TaskName = "PrintBit Kiosk"
$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BatPath = Join-Path $ScriptsDir "start-kiosk.bat"
$ServerStartupScript = Join-Path $ScriptsDir "start-kiosk-server.ps1"
$ProjectDir = Split-Path -Parent $ScriptsDir
$WorkerClientIdentityEnvironmentVariable = "Ipc__WorkerCommandAllowedClientIdentity"

function Resolve-TaskAccount {
    param(
        [Parameter(Mandatory = $true)]
        [string]$UserInput
    )

    $raw = $UserInput.Trim()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "[PrintBit] -KioskUser cannot be empty."
    }

    $candidates = [System.Collections.Generic.List[string]]::new()
    $candidates.Add($raw)

    if ($raw.StartsWith(".\")) {
        $candidates.Add("$env:COMPUTERNAME\$($raw.Substring(2))")
    } elseif ($raw -notmatch "[\\@]") {
        $candidates.Add("$env:COMPUTERNAME\$raw")
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $attemptedCandidates = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in $candidates) {
        if (-not $seen.Add($candidate)) {
            continue
        }
        $null = $attemptedCandidates.Add($candidate)
        try {
            $account = New-Object System.Security.Principal.NTAccount($candidate)
            $sid = $account.Translate([System.Security.Principal.SecurityIdentifier])
            $resolvedAccount = $sid.Translate([System.Security.Principal.NTAccount]).Value
            return [pscustomobject]@{
                AccountName = $resolvedAccount
                Sid = $sid.Value
            }
        } catch {
            continue
        }
    }

    $attempted = if ($attemptedCandidates.Count -gt 0) { ([string[]]$attemptedCandidates) -join ", " } else { $raw }
    throw "[PrintBit] Failed to resolve kiosk user '$raw'. Attempted: [$attempted]. Use an existing local account like '.\printbit' or '$env:COMPUTERNAME\printbit'."
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[PrintBit] Scheduled task '$TaskName' removed." -ForegroundColor Green
    } else {
        Write-Host "[PrintBit] Task '$TaskName' not found -- nothing to remove." -ForegroundColor Yellow
    }
    return
}

if (-not [string]::IsNullOrWhiteSpace($KioskUser) -and ($AtStartup -or $RunAsSystem)) {
    throw "[PrintBit] -KioskUser cannot be combined with -AtStartup or -RunAsSystem."
}

if (-not (Test-Path $BatPath)) {
    Write-Error "[PrintBit] start-kiosk.bat not found at: $BatPath"
    return
}
if (-not (Test-Path $ServerStartupScript)) {
    Write-Error "[PrintBit] start-kiosk-server.ps1 not found at: $ServerStartupScript"
    return
}

# Remove existing task if present (idempotent)
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[PrintBit] Replacing existing task..."
}

$kioskUserNormalized = if ([string]::IsNullOrWhiteSpace($KioskUser)) { $null } else { $KioskUser.Trim() }
$kioskAccount = if ($kioskUserNormalized) { Resolve-TaskAccount -UserInput $kioskUserNormalized } else { $null }
$resolvedKioskUser = if ($kioskAccount) { $kioskAccount.AccountName } else { $null }
$workerAllowedClientIdentity = if ($kioskAccount) { $kioskAccount.Sid } else { $null }

# The worker runs as LocalSystem and reads this machine-scoped configuration.
# Only an explicitly selected kiosk account is added; SYSTEM/administrator modes
# already match the worker's built-in ACL entries.
[Environment]::SetEnvironmentVariable(
    $WorkerClientIdentityEnvironmentVariable,
    $workerAllowedClientIdentity,
    "Machine")

$Action = if ($kioskUserNormalized) {
    New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ServerStartupScript`"" `
        -WorkingDirectory $ProjectDir
} else {
    New-ScheduledTaskAction `
        -Execute "cmd.exe" `
        -Argument ("/c `"" + $BatPath + "`"") `
        -WorkingDirectory (Split-Path $BatPath)
}

$Trigger = if ($kioskUserNormalized) {
    New-ScheduledTaskTrigger -AtLogOn
} elseif ($AtStartup) {
    New-ScheduledTaskTrigger -AtStartup
} else {
    New-ScheduledTaskTrigger -AtLogOn
}

$Settings = New-ScheduledTaskSettingsSet `
    -Priority 4 `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances $MultipleInstances `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$useSystemPrincipal = $AtStartup -or $RunAsSystem
$Principal = if ($kioskUserNormalized) {
    New-ScheduledTaskPrincipal `
        -UserId $resolvedKioskUser `
        -RunLevel Limited `
        -LogonType Interactive
} elseif ($useSystemPrincipal) {
    New-ScheduledTaskPrincipal `
        -UserId "SYSTEM" `
        -RunLevel Highest `
        -LogonType ServiceAccount
} else {
    New-ScheduledTaskPrincipal `
        -UserId $env:USERNAME `
        -RunLevel Highest `
        -LogonType Interactive
}

$TaskDescription = if ($kioskUserNormalized) {
    "Starts PrintBit server at kiosk-user logon ($resolvedKioskUser)."
} elseif ($AtStartup) {
    "Starts PrintBit kiosk launcher at machine startup (SYSTEM principal)."
} elseif ($RunAsSystem) {
    "Starts PrintBit kiosk launcher at logon using SYSTEM principal."
} else {
    "Starts PrintBit kiosk launcher at logon."
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description $TaskDescription | Out-Null

Write-Host ""
Write-Host "[PrintBit] Scheduled task '$TaskName' installed!" -ForegroundColor Green
if ($kioskUserNormalized) {
    Write-Host "[PrintBit]   Runs at logon as $resolvedKioskUser (interactive token)." -ForegroundColor Cyan
    Write-Host "[PrintBit]   Resolved SID: $($kioskAccount.Sid)" -ForegroundColor Gray
    Write-Host "[PrintBit]   Worker pipe client SID configured in machine environment." -ForegroundColor Cyan
    Write-Host "[PrintBit]   Mode: server-only startup for Assigned Access Edge (use http://127.0.0.1:3000/loading)." -ForegroundColor Cyan
    Write-Host "[PrintBit]   Startup logs: uploads\logs\kiosk-server-startup.log" -ForegroundColor Gray
    Write-Host "[PrintBit]   Optional recovery: .\scripts\install-watchdog.ps1 -AtStartup" -ForegroundColor DarkGray
} elseif ($useSystemPrincipal) {
    if ($AtStartup) {
        Write-Host "[PrintBit]   Runs at machine startup as SYSTEM." -ForegroundColor Cyan
    } else {
        Write-Host "[PrintBit]   Runs at logon as SYSTEM." -ForegroundColor Cyan
    }
    Write-Host "[PrintBit]   Worker pipe uses its built-in SYSTEM/Administrators ACL." -ForegroundColor Cyan
} else {
    Write-Host "[PrintBit]   Runs at logon as $env:USERNAME with admin privileges." -ForegroundColor Cyan
}
Write-Host "[PrintBit]   To remove: .\scripts\install-startup.ps1 -Uninstall" -ForegroundColor DarkGray
Write-Host ""
