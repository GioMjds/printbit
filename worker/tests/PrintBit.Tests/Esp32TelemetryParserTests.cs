using System.Net;
using Xunit;
using PrintBit.Hardware.Devices.ESP32.Protocol;

namespace PrintBit.Tests;

public class Esp32TelemetryParserTests
{
    [Theory]
    [InlineData("AP_IP:192.168.4.1", Esp32TelemetryType.ApIp, "192.168.4.1")]
    [InlineData("STA_IP:192.168.1.50", Esp32TelemetryType.StaIp, "192.168.1.50")]
    [InlineData("KIOSK_IP:192.168.4.2", Esp32TelemetryType.KioskIp, "192.168.4.2")]
    [InlineData("coin_target:http://192.168.4.2:3000/api/coin", Esp32TelemetryType.CoinTarget, "http://192.168.4.2:3000/api/coin")]
    [InlineData("portal_target:http://192.168.4.1:80/portal", Esp32TelemetryType.PortalTarget, "http://192.168.4.1:80/portal")]
    [InlineData("WIFI_STA_CONNECTED", Esp32TelemetryType.WifiStaConnected, "connected")]
    [InlineData("WIFI_STA_DISCONNECTED", Esp32TelemetryType.WifiStaDisconnected, "disconnected")]
    [InlineData("WIFI_STA_CONNECTING:MySSID", Esp32TelemetryType.WifiStaConnecting, "MySSID")]
    [InlineData("WIFI_SETUP_READY:PrintBit-AP", Esp32TelemetryType.WifiSetupReady, "PrintBit-AP")]
    [InlineData("  AP_IP:10.0.0.1\r\n", Esp32TelemetryType.ApIp, "10.0.0.1")]
    [InlineData("WIFI_STA_CONNECTED\r\n", Esp32TelemetryType.WifiStaConnected, "connected")]
    public void TryParse_ValidLines_ReturnsExpectedEvent(string input, Esp32TelemetryType expectedType, string expectedValue)
    {
        var success = Esp32TelemetryParser.TryParse(input, out var result);
        Assert.True(success);
        Assert.NotNull(result);
        Assert.Equal(expectedType, result.Type);
        Assert.Equal(expectedValue, result.Value);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("RANDOM_DATA")]
    [InlineData("AP_IP:not-an-ip")]
    [InlineData("STA_IP:999.999.999.999")]
    [InlineData("KIOSK_IP:256.1.1.1")]
    [InlineData("coin_target:")]
    [InlineData("coin_target:   ")]
    [InlineData("portal_target:")]
    [InlineData("portal_target:   ")]
    public void TryParse_InvalidLines_ReturnsFalse(string? input)
    {
        var success = Esp32TelemetryParser.TryParse(input, out var result);
        Assert.False(success);
        Assert.Null(result);
    }
}
