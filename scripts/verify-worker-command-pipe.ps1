[CmdletBinding()]
param(
    [string]$ServiceName = "PrintBitHardware",
    [string]$TaskName = "PrintBit Kiosk",
    [string]$PipeName = "printbit-worker-commands",
    [switch]$SkipPipeProbe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$allowedClientEnvironmentVariable = "Ipc__WorkerCommandAllowedClientIdentity"

function Fail-Verification {
    param(
        [Parameter(Mandatory = $true)][int]$Code,
        [Parameter(Mandatory = $true)][string]$Message
    )

    [Console]::Error.WriteLine("[PrintBit] Worker pipe verification failed ($Code): $Message")
    exit $Code
}

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if ($null -eq $service) {
    Fail-Verification 10 "Windows service '$ServiceName' is not installed."
}
if ($service.StartMode -ne "Auto") {
    Fail-Verification 11 "Windows service '$ServiceName' is not configured for automatic startup (StartMode=$($service.StartMode))."
}
if ($service.State -ne "Running") {
    Fail-Verification 12 "Windows service '$ServiceName' is not running (State=$($service.State))."
}

$workerProcesses = @(Get-Process -Name "PrintBit.HardwareService" -ErrorAction SilentlyContinue)
if ($workerProcesses.Count -ne 1) {
    Fail-Verification 13 "Expected exactly one PrintBit.HardwareService process, found $($workerProcesses.Count)."
}

$task = Get-ScheduledTask -TaskName $TaskName -TaskPath "\" -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Fail-Verification 14 "Scheduled task '$TaskName' is not installed."
}

$configuredClientSid = [Environment]::GetEnvironmentVariable(
    $allowedClientEnvironmentVariable,
    "Machine")
$taskUser = [string]$task.Principal.UserId
$taskIsSystem = $taskUser -in @("SYSTEM", "NT AUTHORITY\SYSTEM")

if ($taskIsSystem) {
    if (-not [string]::IsNullOrWhiteSpace($configuredClientSid)) {
        Fail-Verification 15 "SYSTEM kiosk task must not retain an optional client SID ('$configuredClientSid')."
    }
} else {
    if ([string]::IsNullOrWhiteSpace($configuredClientSid)) {
        Fail-Verification 16 "Kiosk task '$taskUser' has no configured worker pipe client SID."
    }

    try {
        $taskSid = (New-Object System.Security.Principal.NTAccount($taskUser)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        Fail-Verification 17 "Could not resolve scheduled-task identity '$taskUser' to a SID."
    }

    if ($taskSid -ne $configuredClientSid) {
        Fail-Verification 18 "Worker pipe client SID '$configuredClientSid' does not match scheduled-task identity '$taskUser' ($taskSid)."
    }
}

if (-not $SkipPipeProbe) {
    $requestId = [guid]::NewGuid().ToString()
    $client = [System.IO.Pipes.NamedPipeClientStream]::new(
        ".",
        $PipeName,
        [System.IO.Pipes.PipeDirection]::InOut,
        [System.IO.Pipes.PipeOptions]::Asynchronous)

    try {
        $client.Connect(3000)
        $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false), 1024, $true)
        $writer.AutoFlush = $true
        $writer.WriteLine((ConvertTo-Json @{ requestId = $requestId; type = "GetPrinterRecoveryStatus" } -Compress))

        $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false), $false, 1024, $true)
        $responseLine = $reader.ReadLineAsync().AsTask().WaitAsync([TimeSpan]::FromSeconds(5)).GetAwaiter().GetResult()
        if ([string]::IsNullOrWhiteSpace($responseLine)) {
            Fail-Verification 19 "Worker command pipe returned an empty response."
        }

        $response = $responseLine | ConvertFrom-Json
        if ([string]$response.requestId -ne $requestId) {
            Fail-Verification 20 "Worker command pipe response requestId did not match the probe request."
        }
    } catch {
        Fail-Verification 19 "Worker command pipe probe failed: $($_.Exception.Message)"
    } finally {
        $client.Dispose()
    }
}

Write-Output "[PrintBit] Worker command pipe verification passed: service=$ServiceName task=$TaskName pipe=$PipeName"
exit 0
