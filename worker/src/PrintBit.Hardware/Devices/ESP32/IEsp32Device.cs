using PrintBit.Hardware.Devices.ESP32.Protocol;

namespace PrintBit.Hardware.Devices.ESP32;

public interface IEsp32Device
{
    string? ApIp { get; }
    string? StaIp { get; }
    string? KioskIp { get; }
    event EventHandler<Esp32TelemetryEvent>? TelemetryReceived;
    void SendKioskIpAnnouncement(string ip, int port, string path);
    void SendWifiCommand(string action);
}
