[CmdletBinding()]
param(
    [int]$WaitSeconds = 10,
    [int]$RetryCount = 3,
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-NetworkLog {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $line = "[PrintBit][network] $Message"
    if ($Quiet) {
        Write-Output $line
    } else {
        Write-Host $line -ForegroundColor Gray
    }
}

function Get-EnvString {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string]$Default = ""
    )

    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $Default
    }
    return $raw.Trim()
}

function Get-EnvBool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [bool]$Default
    )

    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $Default
    }
    $normalized = $raw.Trim().ToLowerInvariant()
    if (@("1", "true", "yes", "on") -contains $normalized) { return $true }
    if (@("0", "false", "no", "off") -contains $normalized) { return $false }
    return $Default
}

function Test-Ipv4Address {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $segments = $Value.Split('.')
    if ($segments.Count -ne 4) { return $false }
    foreach ($segment in $segments) {
        $octet = 0
        if (-not [int]::TryParse($segment, [ref]$octet)) { return $false }
        if ($octet -lt 0 -or $octet -gt 255) { return $false }
    }
    return $true
}

function Resolve-Esp32GatewayIp {
    $configuredGateway = Get-EnvString -Name "PRINTBIT_ESP32_GATEWAY_IP" -Default ""
    if (-not [string]::IsNullOrWhiteSpace($configuredGateway)) {
        if (-not (Test-Ipv4Address -Value $configuredGateway)) {
            throw "PRINTBIT_ESP32_GATEWAY_IP is not a valid IPv4 address: '$configuredGateway'."
        }
        return $configuredGateway
    }

    $apBaseUrl = Get-EnvString -Name "PRINTBIT_ESP32_AP_BASE_URL" -Default "http://192.168.4.1"
    try {
        $uri = [Uri]$apBaseUrl
        if (Test-Ipv4Address -Value $uri.Host) {
            return $uri.Host
        }
    } catch {
        Write-NetworkLog "Could not parse PRINTBIT_ESP32_AP_BASE_URL='$apBaseUrl'. Falling back to 192.168.4.1."
    }

    return "192.168.4.1"
}

function Get-WlanInterfaces {
    $output = & netsh wlan show interfaces 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $output) {
        return @()
    }

    $entries = [System.Collections.Generic.List[object]]::new()
    $currentName = ""
    $currentState = ""
    $currentSsid = ""

    foreach ($line in @($output + "")) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            if (-not [string]::IsNullOrWhiteSpace($currentName)) {
                $entries.Add([pscustomobject]@{
                    Name = $currentName
                    State = $currentState
                    SSID = $currentSsid
                }) | Out-Null
            }
            $currentName = ""
            $currentState = ""
            $currentSsid = ""
            continue
        }

        if ($line -match '^\s*Name\s*:\s*(.+)$') {
            $currentName = $matches[1].Trim()
            continue
        }
        if ($line -match '^\s*State\s*:\s*(.+)$') {
            $currentState = $matches[1].Trim()
            continue
        }
        if ($line -match '^\s*SSID\s*:\s*(.+)$') {
            $currentSsid = $matches[1].Trim()
            continue
        }
    }

    return @($entries.ToArray())
}

function Get-FallbackWifiInterfaceName {
    $adapters = Get-NetAdapter -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match 'Wi-?Fi|WLAN|Wireless' -and
            $_.Status -ne 'Disabled'
        } |
        Select-Object -First 1

    if ($adapters) {
        return [string]$adapters.Name
    }
    return $null
}

function Get-ConnectedWifiInterfaceName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Ssid
    )

    $interfaces = @(Get-WlanInterfaces)
    if ($interfaces.Count -eq 0) {
        return $null
    }

    $target = $interfaces |
        Where-Object {
            $_.State -match 'connected' -and
            $_.SSID -eq $Ssid
        } |
        Select-Object -First 1

    if ($target) {
        return [string]$target.Name
    }

    return $null
}

function Test-StaticIpProfile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InterfaceAlias,
        [Parameter(Mandatory = $true)]
        [string]$IpAddress,
        [Parameter(Mandatory = $true)]
        [string]$Gateway
    )

    $ipMatch = Get-NetIPAddress -InterfaceAlias $InterfaceAlias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -eq $IpAddress } |
        Select-Object -First 1

    if (-not $ipMatch) {
        return $false
    }

    $routeMatch = Get-NetRoute -InterfaceAlias $InterfaceAlias -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
        Where-Object { $_.NextHop -eq $Gateway } |
        Select-Object -First 1

    return ($null -ne $routeMatch)
}

$networkProvider = (Get-EnvString -Name "PRINTBIT_NETWORK_PROVIDER" -Default "esp32").ToLowerInvariant()
if ($networkProvider -ne "esp32") {
    Write-NetworkLog "Skipping ESP32 static-IP enforcement because PRINTBIT_NETWORK_PROVIDER='$networkProvider'."
    return
}

$enforceStatic = Get-EnvBool -Name "PRINTBIT_ESP32_STATIC_IP_ENFORCE" -Default $true
if (-not $enforceStatic) {
    Write-NetworkLog "Skipping static-IP enforcement because PRINTBIT_ESP32_STATIC_IP_ENFORCE=false."
    return
}

$ssid = Get-EnvString -Name "PRINTBIT_HOTSPOT_SSID" -Default "PrintBit"
$kioskIp = Get-EnvString -Name "PRINTBIT_ESP32_KIOSK_IP" -Default "192.168.4.2"
$netmask = Get-EnvString -Name "PRINTBIT_ESP32_KIOSK_NETMASK" -Default "255.255.255.0"
$gateway = Resolve-Esp32GatewayIp
$wifiInterface = Get-EnvString -Name "PRINTBIT_ESP32_WIFI_INTERFACE" -Default ""

if (-not (Test-Ipv4Address -Value $kioskIp)) {
    throw "PRINTBIT_ESP32_KIOSK_IP is not a valid IPv4 address: '$kioskIp'."
}
if (-not (Test-Ipv4Address -Value $netmask)) {
    throw "PRINTBIT_ESP32_KIOSK_NETMASK is not a valid IPv4 mask: '$netmask'."
}
if (-not (Test-Ipv4Address -Value $gateway)) {
    throw "Resolved ESP32 gateway is not a valid IPv4 address: '$gateway'."
}

Write-NetworkLog "Ensuring ESP32 Wi-Fi profile. ssid='$ssid' staticIp='$kioskIp' netmask='$netmask' gateway='$gateway'"

# Fast path: check if already connected and already configured with desired static IP and gateway
$existingInterface = if (-not [string]::IsNullOrWhiteSpace($wifiInterface)) { $wifiInterface } else { Get-ConnectedWifiInterfaceName -Ssid $ssid }
if (-not [string]::IsNullOrWhiteSpace($existingInterface)) {
    if (Test-StaticIpProfile -InterfaceAlias $existingInterface -IpAddress $kioskIp -Gateway $gateway) {
        Write-NetworkLog "Interface '$existingInterface' is already connected to '$ssid' and configured with static IP '$kioskIp' (gw '$gateway'). Skipping reconfiguration."
        return
    }
}

if ([string]::IsNullOrWhiteSpace($wifiInterface)) {
    Write-NetworkLog "Connecting to Wi-Fi profile '$ssid'..."
    & netsh wlan connect name="$ssid" 2>&1 | ForEach-Object { Write-NetworkLog "$_" }

    $deadline = (Get-Date).AddSeconds([Math]::Max(5, $WaitSeconds))
    do {
        $wifiInterface = Get-ConnectedWifiInterfaceName -Ssid $ssid
        if (-not [string]::IsNullOrWhiteSpace($wifiInterface)) {
            break
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
} else {
    Write-NetworkLog "Using explicit Wi-Fi interface '$wifiInterface' from PRINTBIT_ESP32_WIFI_INTERFACE."
}

if ([string]::IsNullOrWhiteSpace($wifiInterface)) {
    $wifiInterface = Get-FallbackWifiInterfaceName
    if (-not [string]::IsNullOrWhiteSpace($wifiInterface)) {
        Write-NetworkLog "Could not confirm SSID '$ssid' within timeout. Falling back to adapter '$wifiInterface'."
    }
}

if ([string]::IsNullOrWhiteSpace($wifiInterface)) {
    throw "Could not resolve connected Wi-Fi interface for SSID '$ssid'. Ensure the Wi-Fi profile exists and auto-connect is enabled."
}

Write-NetworkLog "Applying static IPv4 profile on interface '$wifiInterface'..."

$applied = $false
for ($attempt = 1; $attempt -le [Math]::Max(1, $RetryCount); $attempt++) {
    $maxAttempts = [Math]::Max(1, $RetryCount)
    Write-NetworkLog "Attempt $attempt/$($maxAttempts): set address + DNS."

    & netsh interface ipv4 set address name="$wifiInterface" static $kioskIp $netmask $gateway 1 2>&1 |
        ForEach-Object { Write-NetworkLog "$_" }
    if ($LASTEXITCODE -ne 0) {
        Write-NetworkLog "netsh set address returned exit code $LASTEXITCODE."
        Start-Sleep -Seconds 2
        continue
    }

    & netsh interface ipv4 set dnsservers name="$wifiInterface" static $gateway primary 2>&1 |
        ForEach-Object { Write-NetworkLog "$_" }
    if ($LASTEXITCODE -ne 0) {
        Write-NetworkLog "netsh set dnsservers returned exit code $LASTEXITCODE."
        Start-Sleep -Seconds 2
        continue
    }

    Start-Sleep -Seconds 1

    if (Test-StaticIpProfile -InterfaceAlias $wifiInterface -IpAddress $kioskIp -Gateway $gateway) {
        $applied = $true
        break
    }

    Write-NetworkLog "Verification mismatch after attempt $attempt. Retrying..."
    Start-Sleep -Seconds 2
}

if (-not $applied) {
    $strict = Get-EnvBool -Name "PRINTBIT_ESP32_STATIC_IP_STRICT" -Default $false
    if ($strict) {
        throw "Failed to enforce static IP profile on '$wifiInterface' after $RetryCount attempt(s)."
    } else {
        Write-NetworkLog "WARNING: Could not apply static IP ($kioskIp) on '$wifiInterface'. Kiosk will proceed with dynamic IP discovery."
        return
    }
}

Write-NetworkLog "Static IP enforcement successful: $wifiInterface => $kioskIp (gw $gateway)."
