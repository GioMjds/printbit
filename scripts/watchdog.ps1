[CmdletBinding()]
param(
    [switch]$RunOnce,
    [string]$KioskUser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptsDir
$StateDir = Join-Path $ProjectDir "uploads\watchdog"
$StatePath = Join-Path $StateDir "state.json"
$HeartbeatPath = Join-Path $StateDir "watchdog-heartbeat.json"
$InstanceLockPath = Join-Path $StateDir "watchdog.instance.lock"
$ServerBundlePath = Join-Path $ProjectDir "dist\server.js"

function Get-EnvInt {
    param(
        [string]$Name,
        [int]$Default
    )
    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return $Default
}

function Get-EnvBool {
    param(
        [string]$Name,
        [bool]$Default
    )
    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    $normalized = $raw.Trim().ToLowerInvariant()
    if (@("1", "true", "yes", "on") -contains $normalized) { return $true }
    if (@("0", "false", "no", "off") -contains $normalized) { return $false }
    return $Default
}

$PollIntervalMs = Get-EnvInt -Name "PRINTBIT_WATCHDOG_POLL_INTERVAL_MS" -Default 5000
$RequestTimeoutMs = Get-EnvInt -Name "PRINTBIT_WATCHDOG_HTTP_TIMEOUT_MS" -Default 10000
$RestartBaseDelayMs = Get-EnvInt -Name "PRINTBIT_WATCHDOG_RESTART_BASE_DELAY_MS" -Default 2000
$RestartMaxDelayMs = Get-EnvInt -Name "PRINTBIT_WATCHDOG_RESTART_MAX_DELAY_MS" -Default 60000
$FailureThreshold = Get-EnvInt -Name "PRINTBIT_WATCHDOG_FAILURE_ALERT_THRESHOLD" -Default 5
$UnreachableRestartThreshold = Get-EnvInt -Name "PRINTBIT_WATCHDOG_UNREACHABLE_RESTART_THRESHOLD" -Default 3
$RestartOnUnhealthy = Get-EnvBool -Name "PRINTBIT_WATCHDOG_RESTART_ON_UNHEALTHY" -Default $false
$RestartWhenProcessAlive = Get-EnvBool -Name "PRINTBIT_WATCHDOG_RESTART_WHEN_PROCESS_ALIVE" -Default $false
$Port = Get-EnvInt -Name "PRINTBIT_WATCHDOG_PORT" -Default 3000
$HealthUrl = "http://127.0.0.1:$Port/api/watchdog/health"
$ReportUrl = "http://127.0.0.1:$Port/api/watchdog/report"
$SupportsSkipHttpErrorCheck = (Get-Command Invoke-RestMethod).Parameters.ContainsKey("SkipHttpErrorCheck")

function Read-WebExceptionJsonBody {
    param([object]$Response)

    if ($null -eq $Response) { return $null }
    try {
        $stream = $Response.GetResponseStream()
        if ($null -eq $stream) { return $null }
        try {
            $reader = New-Object System.IO.StreamReader($stream)
            try {
                $raw = $reader.ReadToEnd()
            } finally {
                $reader.Dispose()
            }
        } finally {
            $stream.Dispose()
        }
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-WatchdogHealth {
    $timeoutSec = [Math]::Max(1, [int]([Math]::Ceiling($RequestTimeoutMs / 1000.0)))
    $invokeParams = @{
        Method = "Get"
        Uri = $HealthUrl
        TimeoutSec = $timeoutSec
    }
    if ($SupportsSkipHttpErrorCheck) {
        $invokeParams["SkipHttpErrorCheck"] = $true
    }

    try {
        $health = Invoke-RestMethod @invokeParams
        return [pscustomobject]@{
            healthOk = $true
            health = $health
            healthError = $null
        }
    } catch {
        if (-not $SupportsSkipHttpErrorCheck) {
            $response = $_.Exception.Response
            $statusCode = $null
            try {
                if ($null -ne $response) {
                    $statusCode = [int]$response.StatusCode
                }
            } catch {
                $statusCode = $null
            }
            if ($statusCode -eq 503) {
                $parsedHealth = Read-WebExceptionJsonBody -Response $response
                if ($null -ne $parsedHealth) {
                    return [pscustomobject]@{
                        healthOk = $true
                        health = $parsedHealth
                        healthError = $null
                    }
                }
            }
        }

        return [pscustomobject]@{
            healthOk = $false
            health = $null
            healthError = $_.Exception.Message
        }
    }
}

function Resolve-NodeExecutablePath {
    foreach ($name in @("node.exe", "node")) {
        $resolved = Get-Command $name -ErrorAction SilentlyContinue
        if ($resolved -and -not [string]::IsNullOrWhiteSpace([string]$resolved.Source)) {
            return [string]$resolved.Source
        }
    }
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidate = Join-Path $root "nodejs\node.exe"
        if (Test-Path $candidate) {
            return $candidate
        }
    }
    return $null
}

$NodeExecutablePath = Resolve-NodeExecutablePath

function Get-NetworkProvider {
    $raw = [Environment]::GetEnvironmentVariable("PRINTBIT_NETWORK_PROVIDER")
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return "esp32"
    }
    return $raw.Trim().ToLowerInvariant()
}

function Get-Esp32KioskIp {
    $raw = [Environment]::GetEnvironmentVariable("PRINTBIT_ESP32_KIOSK_IP")
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return "192.168.4.2"
    }
    return $raw.Trim()
}

function Should-ManageEdge {
    $skipEdgeLaunchRaw = [Environment]::GetEnvironmentVariable("PRINTBIT_SKIP_EDGE_LAUNCH")
    if (-not [string]::IsNullOrWhiteSpace($skipEdgeLaunchRaw)) {
        $enabledTokens = @("1", "true", "yes", "on")
        if ($enabledTokens -contains $skipEdgeLaunchRaw.Trim().ToLowerInvariant()) {
            return $false
        }
    }

    $raw = [Environment]::GetEnvironmentVariable("PRINTBIT_WATCHDOG_MANAGE_EDGE")
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
        $disabledTokens = @("0", "false", "no", "off")
        if ($disabledTokens -contains $raw.Trim().ToLowerInvariant()) {
            return $false
        }
    }
    try {
        $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -ne $currentIdentity -and $currentIdentity.Name -eq "NT AUTHORITY\SYSTEM") {
            return $false
        }
        # In Assigned Access deployments, kiosk-user sessions should not manage Edge.
        # Assigned Access already owns browser lifecycle and watchdog should only
        # recover server-side availability.
        $effectiveKioskUser = if (-not [string]::IsNullOrWhiteSpace($KioskUser)) {
            $KioskUser.Trim()
        } else {
            [Environment]::GetEnvironmentVariable("PRINTBIT_KIOSK_USER")
        }
        if (-not [string]::IsNullOrWhiteSpace($effectiveKioskUser)) {
            return $false
        }
    } catch {
        return $false
    }
    return $true
}

$ManageEdge = Should-ManageEdge

function Get-KioskLocalIp {
    if ((Get-NetworkProvider) -eq "esp32") {
        return (Get-Esp32KioskIp)
    }

    $ipCandidates = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
        $_.IPAddress -notmatch '^127\.' -and
        $_.PrefixOrigin -ne 'WellKnown'
    }
    $preferred = $ipCandidates |
        Where-Object {
            $_.IPAddress -like "192.168.4.*" -or
            $_.IPAddress -like "192.168.137.*"
        } |
        Select-Object -First 1
    if (-not $preferred) {
        $preferred = $ipCandidates | Select-Object -First 1
    }
    if ($preferred) { return [string]$preferred.IPAddress }
    return "127.0.0.1"
}

if (-not (Test-Path $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir | Out-Null
}

$script:InstanceLockStream = $null

function Acquire-WatchdogInstanceLock {
    try {
        $script:InstanceLockStream = [System.IO.File]::Open(
            $InstanceLockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        $owner = "pid=$PID user=$([Security.Principal.WindowsIdentity]::GetCurrent().Name) acquiredAt=$((Get-Date).ToString('o'))"
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($owner)
        $script:InstanceLockStream.SetLength(0)
        $script:InstanceLockStream.Write($bytes, 0, $bytes.Length)
        $script:InstanceLockStream.Flush()
        return $true
    } catch [System.IO.IOException] {
        Write-Warning "[Watchdog] Another watchdog instance is already running. Exiting duplicate instance."
        return $false
    } catch {
        Write-Warning "[Watchdog] Failed to acquire watchdog instance lock: $($_.Exception.Message)"
        return $false
    }
}

function Release-WatchdogInstanceLock {
    if ($null -ne $script:InstanceLockStream) {
        $script:InstanceLockStream.Dispose()
        $script:InstanceLockStream = $null
    }
}

function Read-State {
    if (-not (Test-Path $StatePath)) {
        return [pscustomobject]@{
            running = $true
            watchdogPid = $PID
            consecutiveFailures = 0
            recoveryAttempts = 0
            backoffDelayMs = 0
            nextRecoveryAt = $null
            lastAction = "startup"
            lastError = $null
            lastUpdatedAt = (Get-Date).ToString("o")
        }
    }
    try {
        return (Get-Content -Path $StatePath -Raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{
            running = $true
            watchdogPid = $PID
            consecutiveFailures = 0
            recoveryAttempts = 0
            backoffDelayMs = 0
            nextRecoveryAt = $null
            lastAction = "state_parse_error"
            lastError = $_.Exception.Message
            lastUpdatedAt = (Get-Date).ToString("o")
        }
    }
}

function Write-State {
    param(
        [pscustomobject]$State
    )
    $State.running = $true
    $State.watchdogPid = $PID
    $State.lastUpdatedAt = (Get-Date).ToString("o")
    $State | ConvertTo-Json -Depth 6 | Set-Content -Path $StatePath -Encoding UTF8
}

function Update-Heartbeat {
    param(
        [string]$Status,
        [string]$Message
    )
    [pscustomobject]@{
        watchdogPid = $PID
        status = $Status
        message = $Message
        timestamp = (Get-Date).ToString("o")
    } | ConvertTo-Json -Depth 4 | Set-Content -Path $HeartbeatPath -Encoding UTF8
}

function Send-WatchdogReport {
    param(
        [pscustomobject]$State
    )
    $payload = [pscustomobject]@{
        running = $true
        watchdogPid = $PID
        consecutiveFailures = [int]$State.consecutiveFailures
        recoveryAttempts = [int]$State.recoveryAttempts
        backoffDelayMs = [int]$State.backoffDelayMs
        nextRecoveryAt = $State.nextRecoveryAt
        lastAction = [string]$State.lastAction
        lastError = $State.lastError
    } | ConvertTo-Json -Depth 4
    try {
        Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $payload -TimeoutSec ([Math]::Max(1, [int]([Math]::Ceiling($RequestTimeoutMs / 1000.0)))) | Out-Null
    } catch {
        Write-Warning "[Watchdog] Failed to post report: $($_.Exception.Message)"
    }
}

function Get-BackoffDelayMs {
    param(
        [int]$ConsecutiveFailures
    )
    if ($ConsecutiveFailures -le 0) { return 0 }
    $delay = [double]$RestartBaseDelayMs * [Math]::Pow(2, $ConsecutiveFailures - 1)
    $bounded = [Math]::Min([double]$RestartMaxDelayMs, $delay)
    return [int][Math]::Floor($bounded)
}

function Get-NodeServerProcess {
    try {
        $nodeProcs = @(Get-Process -Name "node" -ErrorAction SilentlyContinue)
        if ($nodeProcs.Count -eq 0) {
            return $null
        }
        $candidates = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
        foreach ($proc in $candidates) {
            $cmd = [string]$proc.CommandLine
            if ($cmd -match "src\\server\.ts|dist\\server\.js|pnpm run dev") {
                return $proc
            }
        }
        return $null
    } catch {
        return $null
    }
}

function Stop-ProcessSafely {
    param(
        [int]$ProcessId
    )
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    } catch {
        Write-Warning "[Watchdog] Failed to stop PID ${ProcessId}: $($_.Exception.Message)"
    }
}

function Ensure-ServerRunning {
    param(
        [pscustomobject]$State,
        [string]$Reason
    )
    $existing = Get-NodeServerProcess
    if ($null -ne $existing) {
        return $false
    }

    if ([string]::IsNullOrWhiteSpace($NodeExecutablePath)) {
        $State.lastAction = "server_start_failed"
        $State.lastError = "Node.js executable is not available in PATH for the watchdog task account."
        return $false
    }

    if (-not (Test-Path $ServerBundlePath)) {
        $State.lastAction = "server_start_failed"
        $State.lastError = "Missing dist\server.js. Run 'pnpm run build' before kiosk deployment."
        return $false
    }

    if ([string]::IsNullOrWhiteSpace($env:PRINTBIT_KIOSK_LOCKDOWN)) {
        $env:PRINTBIT_KIOSK_LOCKDOWN = "true"
    }
    if ([string]::IsNullOrWhiteSpace($env:PRINTBIT_USB_EXPORT_ENABLED)) {
        $env:PRINTBIT_USB_EXPORT_ENABLED = "false"
    }
    try {
        $proc = Start-Process `
            -FilePath $NodeExecutablePath `
            -ArgumentList @($ServerBundlePath) `
            -WorkingDirectory $ProjectDir `
            -WindowStyle Hidden `
            -PassThru
        if ($null -ne $proc) {
            Start-Sleep -Milliseconds 250
            if ($proc.HasExited) {
                $State.lastAction = "server_start_failed"
                $State.lastError = "Server process exited immediately while handling $Reason."
                return $false
            }
            $State.lastAction = "server_started"
            $State.lastError = $null
            return $true
        }
        $State.lastAction = "server_start_failed"
        $State.lastError = "Unable to start server process ($Reason)."
        return $false
    } catch {
        $State.lastAction = "server_start_failed"
        $State.lastError = $_.Exception.Message
        return $false
    }
}

function Ensure-EdgeRunning {
    param(
        [pscustomobject]$State
    )
    $currentKioskUrl = "http://$(Get-KioskLocalIp):$Port/loading"
    try {
        $escapedUrl = [Regex]::Escape($currentKioskUrl)
        $kioskEdges = @(
            Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
                Where-Object {
                    $cmd = [string]$_.CommandLine
                    $cmd -match "--kiosk"
                }
        )
        foreach ($kioskEdge in $kioskEdges) {
            if ([string]$kioskEdge.CommandLine -match $escapedUrl) {
                return $false
            }
        }
        foreach ($kioskEdge in $kioskEdges) {
            Stop-ProcessSafely -ProcessId ([int]$kioskEdge.ProcessId)
        }
        if ($kioskEdges.Count -gt 0) {
            Start-Sleep -Milliseconds 500
        }
    } catch {
        Write-Warning "[Watchdog] Failed to inspect Edge command line: $($_.Exception.Message)"
    }
    try {
        Start-Process "msedge.exe" -ArgumentList @(
            "--kiosk", $currentKioskUrl,
            "--edge-kiosk-type=fullscreen",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-infobars",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-features=TranslateUI"
        )
        $State.lastAction = "edge_started"
        $State.lastError = $null
        return $true
    } catch {
        $State.lastAction = "edge_start_failed"
        $State.lastError = $_.Exception.Message
        return $false
    }
}

function Restart-Server {
    param(
        [pscustomobject]$State,
        [string]$Reason
    )
    $server = Get-NodeServerProcess
    if ($null -ne $server) {
        Stop-ProcessSafely -ProcessId ([int]$server.ProcessId)
        Start-Sleep -Milliseconds 500
    }
    return (Ensure-ServerRunning -State $State -Reason $Reason)
}

if (-not (Acquire-WatchdogInstanceLock)) {
    exit 0
}

try {
    Write-Host "[Watchdog] Starting PrintBit watchdog loop on $HealthUrl"
    if (-not [string]::IsNullOrWhiteSpace($KioskUser)) {
        Write-Host "[Watchdog] Kiosk account: $KioskUser"
    }
    $state = Read-State
    $state.running = $true
    $state.watchdogPid = $PID
    $state.consecutiveFailures = 0
    $state.recoveryAttempts = 0
    $state.backoffDelayMs = 0
    $state.nextRecoveryAt = $null
    $state.lastAction = "watchdog_started"
    $state.lastError = $null
    Write-State -State $state
    Update-Heartbeat -Status "running" -Message "Watchdog started."
    Send-WatchdogReport -State $state

    if (-not $ManageEdge) {
        Write-Host "[Watchdog] Edge management disabled for this execution context."
    }
    if (-not $RestartOnUnhealthy) {
        Write-Host "[Watchdog] Restart-on-unhealthy disabled (set PRINTBIT_WATCHDOG_RESTART_ON_UNHEALTHY=true to enable)." -ForegroundColor Yellow
    }
    Write-Host "[Watchdog] Unreachable restart threshold: $UnreachableRestartThreshold consecutive failures."
    if (-not $RestartWhenProcessAlive) {
        Write-Host "[Watchdog] Restart when server process is alive: disabled." -ForegroundColor Yellow
    }

    while ($true) {
        $healthResult = Get-WatchdogHealth
        $health = $healthResult.health
        $healthOk = [bool]$healthResult.healthOk
        $healthError = $healthResult.healthError

        $didRecovery = $false
        if ($healthOk) {
            $isUnhealthy = ([string]$health.status -eq "unhealthy")
            if ($isUnhealthy) {
                if ($RestartOnUnhealthy) {
                    $existingServer = Get-NodeServerProcess
                    if ($existingServer -and -not $RestartWhenProcessAlive) {
                        $state.consecutiveFailures = 0
                        $state.backoffDelayMs = 0
                        $state.nextRecoveryAt = $null
                        $state.lastAction = "health_unhealthy_process_alive"
                        $state.lastError = "Health endpoint returned unhealthy, but server PID $($existingServer.ProcessId) is alive; restart skipped."
                    } else {
                        $state.consecutiveFailures = [int]$state.consecutiveFailures + 1
                        $state.recoveryAttempts = [int]$state.recoveryAttempts + 1
                        $state.backoffDelayMs = Get-BackoffDelayMs -ConsecutiveFailures ([int]$state.consecutiveFailures)
                        $state.nextRecoveryAt = (Get-Date).AddMilliseconds($state.backoffDelayMs).ToString("o")
                        $state.lastAction = "health_unhealthy_detected"
                        $state.lastError = "Health endpoint returned unhealthy."
                        Write-State -State $state
                        Send-WatchdogReport -State $state

                        if ($state.backoffDelayMs -gt 0) {
                            Start-Sleep -Milliseconds $state.backoffDelayMs
                        }

                        $didRecovery = Restart-Server -State $state -Reason "health_unhealthy"
                        if ($ManageEdge) {
                            $null = Ensure-EdgeRunning -State $state
                        }
                        if ($didRecovery) {
                            $state.lastAction = "recovery_restart_performed"
                            $state.lastError = $null
                        } else {
                            $state.lastAction = "recovery_restart_skipped_or_failed"
                        }
                    }
                } else {
                    $state.consecutiveFailures = 0
                    $state.backoffDelayMs = 0
                    $state.nextRecoveryAt = $null
                    $state.lastAction = "health_unhealthy_no_restart"
                    $state.lastError = "Health endpoint returned unhealthy; restart-on-unhealthy is disabled."
                }
            } else {
                $state.consecutiveFailures = 0
                $state.backoffDelayMs = 0
                $state.nextRecoveryAt = $null
                $state.lastAction = "health_ok"
                $state.lastError = $null
                # Server responded 200 OK — skip expensive WMI process queries
                if ($ManageEdge) {
                    $null = Ensure-EdgeRunning -State $state
                }
            }
        } else {
            $state.consecutiveFailures = [int]$state.consecutiveFailures + 1
            if ([int]$state.consecutiveFailures -lt $UnreachableRestartThreshold) {
                $state.backoffDelayMs = 0
                $state.nextRecoveryAt = $null
                $state.lastAction = "health_unreachable_observed"
                $state.lastError = "$healthError (restart deferred until $UnreachableRestartThreshold consecutive unreachable checks)"
            } else {
                $existingServer = Get-NodeServerProcess
                if ($existingServer -and -not $RestartWhenProcessAlive) {
                    $state.backoffDelayMs = 0
                    $state.nextRecoveryAt = $null
                    $state.lastAction = "health_unreachable_process_alive"
                    $state.lastError = "$healthError (server PID $($existingServer.ProcessId) is still running; restart skipped)"
                } else {
                    $state.recoveryAttempts = [int]$state.recoveryAttempts + 1
                    $state.backoffDelayMs = Get-BackoffDelayMs -ConsecutiveFailures ([int]$state.consecutiveFailures)
                    $state.nextRecoveryAt = (Get-Date).AddMilliseconds($state.backoffDelayMs).ToString("o")
                    $state.lastAction = "health_unreachable"
                    $state.lastError = $healthError
                    Write-State -State $state
                    Send-WatchdogReport -State $state

                    if ($state.backoffDelayMs -gt 0) {
                        Start-Sleep -Milliseconds $state.backoffDelayMs
                    }

                    $didRecovery = Restart-Server -State $state -Reason "health_unreachable"
                    if ($ManageEdge) {
                        $null = Ensure-EdgeRunning -State $state
                    }
                    if ($didRecovery) {
                        $state.lastAction = "recovery_restart_after_unreachable"
                        $state.lastError = $null
                    } else {
                        $state.lastAction = "recovery_restart_failed_after_unreachable"
                    }
                }
            }
        }

        if ([int]$state.consecutiveFailures -ge $FailureThreshold) {
            Write-Warning "[Watchdog] Failure threshold reached: $($state.consecutiveFailures)"
        }

        Write-State -State $state
        Update-Heartbeat -Status "running" -Message "Loop complete. action=$($state.lastAction)"
        Send-WatchdogReport -State $state

        if ($RunOnce) { break }
        Start-Sleep -Milliseconds $PollIntervalMs
    }

    Write-Host "[Watchdog] Exiting watchdog loop."
} finally {
    Release-WatchdogInstanceLock
}
