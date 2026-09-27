namespace PrintBit.Hardware.Devices.ESP32.Protocol
{
    public enum Esp32TelemetryType
    {
        ApIp,
        StaIp,
        KioskIp,
        CoinTarget,
        PortalTarget,
        WifiStaConnected,
        WifiStaDisconnected,
        WifiStaConnecting,
        WifiSetupReady
    }

    public sealed record Esp32TelemetryEvent(Esp32TelemetryType Type, string Value);
}
