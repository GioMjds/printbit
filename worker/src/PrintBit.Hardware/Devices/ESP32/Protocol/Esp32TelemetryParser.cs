using System.Net;

namespace PrintBit.Hardware.Devices.ESP32.Protocol;

public static class Esp32TelemetryParser
{
    public static bool TryParse(string? rawLine, out Esp32TelemetryEvent? telemetry)
    {
        telemetry = null;
        if (string.IsNullOrWhiteSpace(rawLine)) return false;

        var token = rawLine.Trim();
        if (token == "WIFI_STA_CONNECTED")
        {
            telemetry = new Esp32TelemetryEvent(Esp32TelemetryType.WifiStaConnected, "connected");
            return true;
        }
        if (token == "WIFI_STA_DISCONNECTED")
        {
            telemetry = new Esp32TelemetryEvent(Esp32TelemetryType.WifiStaDisconnected, "disconnected");
            return true;
        }
        if (token.StartsWith("WIFI_STA_CONNECTING:"))
        {
            telemetry = new Esp32TelemetryEvent(Esp32TelemetryType.WifiStaConnecting, token["WIFI_STA_CONNECTING:".Length..].Trim());
            return true;
        }
        if (token.StartsWith("WIFI_SETUP_READY:"))
        {
            telemetry = new Esp32TelemetryEvent(Esp32TelemetryType.WifiSetupReady, token["WIFI_SETUP_READY:".Length..].Trim());
            return true;
        }
        if (token.StartsWith("AP_IP:") && TryParseIpv4(token["AP_IP:".Length..].Trim(), out var apIp))
        {
            telemetry = new Esp32TelemetryEvent(Esp32TelemetryType.ApIp, apIp);
            return true;
        }
        if (token.StartsWith("STA_IP:") && TryParseIpv4(token["STA_IP:".Length..].Trim(), out var staIp))
        {
            telemetry = new Esp32TelemetryEvent(Esp32TelemetryType.StaIp, staIp);
            return true;
        }
        if (token.StartsWith("KIOSK_IP:") && TryParseIpv4(token["KIOSK_IP:".Length..].Trim(), out var kioskIp))
        {
            telemetry = new Esp32TelemetryEvent(Esp32TelemetryType.KioskIp, kioskIp);
            return true;
        }
        if (token.StartsWith("coin_target:"))
        {
            var val = token["coin_target:".Length..].Trim();
            if (val.Length > 0)
            {
                telemetry = new Esp32TelemetryEvent(Esp32TelemetryType.CoinTarget, val);
                return true;
            }
        }
        if (token.StartsWith("portal_target:"))
        {
            var val = token["portal_target:".Length..].Trim();
            if (val.Length > 0)
            {
                telemetry = new Esp32TelemetryEvent(Esp32TelemetryType.PortalTarget, val);
                return true;
            }
        }

        return false;
    }

    private static bool TryParseIpv4(string ipCandidate, out string ip)
    {
        ip = string.Empty;
        if (IPAddress.TryParse(ipCandidate, out var parsed) && parsed.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            ip = parsed.ToString();
            return true;
        }
        return false;
    }
}