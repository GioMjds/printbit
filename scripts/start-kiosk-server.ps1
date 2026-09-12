[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptsDir
$EnsureEsp32NetworkScript = Join-Path $ScriptsDir "ensure-esp32-network.ps1"
$LogDir = Join-Path $ProjectDir "uploads\logs"
$LogPath = Join-Path $LogDir "kiosk-server-startup.log"
$ServerBundlePath = Join-Path $ProjectDir "dist\server.js"

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

function Write-StartupLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
    Add-Content -Path $LogPath -Value "[$timestamp] $Message"
}

function Get-NodeExecutableCandidates {
    $candidates = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($name in @("node.exe", "node")) {
        $resolved = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -eq $resolved) { continue }
        $path = [string]$resolved.Source
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        if ($seen.Add($path)) {
            $candidates.Add($path) | Out-Null
        }
    }

    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidate = Join-Path $root "nodejs\node.exe"
        if ((Test-Path $candidate) -and $seen.Add($candidate)) {
            $candidates.Add($candidate) | Out-Null
        }
    }

    return [string[]]$candidates
}

function Get-BuildCommandCandidates {
    $candidates = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    $commands = @(
        @{ Name = "pnpm.cmd"; Args = @("run", "build") },
        @{ Name = "pnpm"; Args = @("run", "build") },
        @{ Name = "corepack.cmd"; Args = @("pnpm", "run", "build") },
        @{ Name = "corepack"; Args = @("pnpm", "run", "build") }
    )

    foreach ($entry in $commands) {
        $resolved = Get-Command $entry.Name -ErrorAction SilentlyContinue
        if ($null -eq $resolved) { continue }
        $path = [string]$resolved.Source
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        $key = "$path|$($entry.Args -join ' ')"
        if (-not $seen.Add($key)) { continue }
        $candidates.Add([pscustomobject]@{
            Label = $entry.Name
            Path = $path
            Args = [string[]]$entry.Args
        }) | Out-Null
    }

    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        foreach ($entry in @(
            @{ Relative = "nodejs\pnpm.cmd"; Label = "programfiles-pnpm.cmd"; Args = @("run", "build") },
            @{ Relative = "nodejs\corepack.cmd"; Label = "programfiles-corepack.cmd"; Args = @("pnpm", "run", "build") }
        )) {
            $path = Join-Path $root $entry.Relative
            if (-not (Test-Path $path)) { continue }
            $key = "$path|$($entry.Args -join ' ')"
            if (-not $seen.Add($key)) { continue }
            $candidates.Add([pscustomobject]@{
                Label = $entry.Label
                Path = $path
                Args = [string[]]$entry.Args
            }) | Out-Null
        }
    }

    return $candidates
}

function Ensure-ServerBundle {
    if (Test-Path $ServerBundlePath) {
        Write-StartupLog "Server bundle detected: $ServerBundlePath"
        return
    }

    Write-StartupLog "Server bundle missing at $ServerBundlePath. Attempting build."
    $candidates = Get-BuildCommandCandidates
    if ($candidates.Count -eq 0) {
        throw "[PrintBit] Missing dist\server.js and no pnpm/corepack build command is available."
    }

    Set-Location -Path $ProjectDir
    foreach ($candidate in $candidates) {
        $display = "$($candidate.Path) $($candidate.Args -join ' ')"
        Write-StartupLog "Attempting build with: $display"
        try {
            & $candidate.Path @($candidate.Args) 2>&1 | Tee-Object -FilePath $LogPath -Append
            $exitCode = $LASTEXITCODE
            if (($null -eq $exitCode -or $exitCode -eq 0) -and (Test-Path $ServerBundlePath)) {
                Write-StartupLog "Build succeeded with: $display"
                return
            }
            Write-StartupLog "Build failed with exit code ${exitCode}: $display"
        } catch {
            Write-StartupLog "Build command failed: $display :: $($_.Exception.Message)"
        }
    }

    throw "[PrintBit] Unable to create dist\server.js. Run 'pnpm run build' from project root and retry."
}

Set-Location -Path $ProjectDir

if ([string]::IsNullOrWhiteSpace($env:PRINTBIT_KIOSK_LOCKDOWN)) {
    $env:PRINTBIT_KIOSK_LOCKDOWN = "true"
}
if ([string]::IsNullOrWhiteSpace($env:PRINTBIT_USB_EXPORT_ENABLED)) {
    $env:PRINTBIT_USB_EXPORT_ENABLED = "false"
}
if ([string]::IsNullOrWhiteSpace($env:PRINTBIT_SKIP_EDGE_LAUNCH)) {
    $env:PRINTBIT_SKIP_EDGE_LAUNCH = "true"
}

function Get-NetworkProvider {
    $raw = [Environment]::GetEnvironmentVariable("PRINTBIT_NETWORK_PROVIDER")
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return "esp32"
    }
    return $raw.Trim().ToLowerInvariant()
}

Write-StartupLog "Starting kiosk server task. user=$([Security.Principal.WindowsIdentity]::GetCurrent().Name) projectDir=$ProjectDir"
Write-StartupLog "Environment PRINTBIT_KIOSK_LOCKDOWN=$($env:PRINTBIT_KIOSK_LOCKDOWN) PRINTBIT_USB_EXPORT_ENABLED=$($env:PRINTBIT_USB_EXPORT_ENABLED) PRINTBIT_SKIP_EDGE_LAUNCH=$($env:PRINTBIT_SKIP_EDGE_LAUNCH)"

if ((Get-NetworkProvider) -eq "esp32") {
    if (Test-Path $EnsureEsp32NetworkScript) {
        Write-StartupLog "ESP32 provider detected. Launching Wi-Fi static IP profile task in background."
        try {
            Start-Process -FilePath "powershell.exe" `
                -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$EnsureEsp32NetworkScript`"", "-Quiet") `
                -WorkingDirectory $ProjectDir `
                -WindowStyle Hidden
            Write-StartupLog "Background network profile enforcement initiated."
        } catch {
            Write-StartupLog "WARNING: Could not launch ESP32 static IP profile task: $($_.Exception.Message)"
        }
    } else {
        Write-StartupLog "WARNING: Missing network helper script at $EnsureEsp32NetworkScript"
    }
}

Ensure-ServerBundle

$nodeCandidates = Get-NodeExecutableCandidates
if ($nodeCandidates.Count -eq 0) {
    $message = "[PrintBit] Node.js executable not found for this account. Install Node.js for all users."
    Write-StartupLog $message
    throw $message
}

$nodePath = $nodeCandidates[0]
Write-StartupLog "Launching compiled server: $nodePath `"$ServerBundlePath`""

try {
    Write-StartupLog "Launching server with direct stream logging to $LogPath..."
    $proc = Start-Process `
        -FilePath "cmd.exe" `
        -ArgumentList @("/c", "`"$nodePath`" `"$ServerBundlePath`" >> `"$LogPath`" 2>&1") `
        -WorkingDirectory $ProjectDir `
        -WindowStyle Hidden `
        -PassThru `
        -Wait
    $exitCode = $proc.ExitCode
    if ($null -ne $exitCode -and $exitCode -ne 0) {
        $message = "[PrintBit] Compiled server exited with code $exitCode."
        Write-StartupLog $message
        throw $message
    }
} catch {
    $message = "[PrintBit] Failed to launch compiled server: $($_.Exception.Message)"
    Write-StartupLog $message
    throw $message
}
