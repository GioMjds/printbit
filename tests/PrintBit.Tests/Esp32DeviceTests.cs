using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrintBit.Hardware.Devices.ESP32;
using PrintBit.Hardware.Devices.ESP32.Protocol;
using PrintBit.Infrastructure.Services.SerialService;
using Xunit;

namespace PrintBit.Tests;

public class Esp32DeviceTests
{
    private readonly Mock<ISerialConnection> _serialMock;
    private readonly Esp32Device _sut;

    public Esp32DeviceTests()
    {
        _serialMock = new Mock<ISerialConnection>();
        _sut = new Esp32Device(_serialMock.Object, NullLogger<Esp32Device>.Instance);
    }

    [Fact]
    public void InitialState_PropertiesAreNull()
    {
        Assert.Null(_sut.ApIp);
        Assert.Null(_sut.StaIp);
        Assert.Null(_sut.KioskIp);
    }

    [Fact]
    public void LineReceived_ApIp_UpdatesPropertyAndFiresTelemetryReceived()
    {
        Esp32TelemetryEvent? receivedEvent = null;
        object? eventSender = null;
        _sut.TelemetryReceived += (sender, args) =>
        {
            eventSender = sender;
            receivedEvent = args;
        };

        _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "AP_IP:192.168.4.1");

        Assert.Equal("192.168.4.1", _sut.ApIp);
        Assert.Null(_sut.StaIp);
        Assert.Null(_sut.KioskIp);
        Assert.Same(_sut, eventSender);
        Assert.NotNull(receivedEvent);
        Assert.Equal(Esp32TelemetryType.ApIp, receivedEvent.Type);
        Assert.Equal("192.168.4.1", receivedEvent.Value);
    }

    [Fact]
    public void LineReceived_StaIp_UpdatesPropertyAndFiresTelemetryReceived()
    {
        Esp32TelemetryEvent? receivedEvent = null;
        _sut.TelemetryReceived += (_, args) => receivedEvent = args;

        _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "STA_IP:192.168.1.105");

        Assert.Equal("192.168.1.105", _sut.StaIp);
        Assert.Null(_sut.ApIp);
        Assert.Null(_sut.KioskIp);
        Assert.NotNull(receivedEvent);
        Assert.Equal(Esp32TelemetryType.StaIp, receivedEvent.Type);
        Assert.Equal("192.168.1.105", receivedEvent.Value);
    }

    [Fact]
    public void LineReceived_KioskIp_UpdatesPropertyAndFiresTelemetryReceived()
    {
        Esp32TelemetryEvent? receivedEvent = null;
        _sut.TelemetryReceived += (_, args) => receivedEvent = args;

        _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "KIOSK_IP:192.168.4.2");

        Assert.Equal("192.168.4.2", _sut.KioskIp);
        Assert.Null(_sut.ApIp);
        Assert.Null(_sut.StaIp);
        Assert.NotNull(receivedEvent);
        Assert.Equal(Esp32TelemetryType.KioskIp, receivedEvent.Type);
        Assert.Equal("192.168.4.2", receivedEvent.Value);
    }

    [Fact]
    public void LineReceived_NonIpTelemetry_FiresEventWithoutModifyingIpProperties()
    {
        var receivedEvents = new List<Esp32TelemetryEvent>();
        _sut.TelemetryReceived += (_, args) => receivedEvents.Add(args);

        _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "WIFI_STA_CONNECTED");
        _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "coin_target:http://192.168.4.2:3000/api/coin");

        Assert.Null(_sut.ApIp);
        Assert.Null(_sut.StaIp);
        Assert.Null(_sut.KioskIp);
        Assert.Equal(2, receivedEvents.Count);
        Assert.Equal(Esp32TelemetryType.WifiStaConnected, receivedEvents[0].Type);
        Assert.Equal("connected", receivedEvents[0].Value);
        Assert.Equal(Esp32TelemetryType.CoinTarget, receivedEvents[1].Type);
        Assert.Equal("http://192.168.4.2:3000/api/coin", receivedEvents[1].Value);
    }

    [Theory]
    [InlineData("RANDOM_LOG_LINE")]
    [InlineData("COIN:5")]
    [InlineData("HOPPER:DONE")]
    [InlineData("AP_IP:invalid-ip")]
    [InlineData("STA_IP:300.300.300.300")]
    [InlineData("")]
    [InlineData("   ")]
    public void LineReceived_UnrelatedOrMalformedLines_Ignored(string line)
    {
        var eventFired = false;
        _sut.TelemetryReceived += (_, _) => eventFired = true;

        _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, line);

        Assert.False(eventFired);
        Assert.Null(_sut.ApIp);
        Assert.Null(_sut.StaIp);
        Assert.Null(_sut.KioskIp);
    }

    [Fact]
    public void SendKioskIpAnnouncement_WithLeadingSlash_SendsFormattedCommand()
    {
        _sut.SendKioskIpAnnouncement("192.168.4.2", 3000, "/portal");

        _serialMock.Verify(s => s.SendLine("KIOSK_IP 192.168.4.2 3000 /portal"), Times.Once);
    }

    [Fact]
    public void SendKioskIpAnnouncement_WithoutLeadingSlash_EnsuresLeadingSlash()
    {
        _sut.SendKioskIpAnnouncement("192.168.4.2", 3000, "portal");

        _serialMock.Verify(s => s.SendLine("KIOSK_IP 192.168.4.2 3000 /portal"), Times.Once);
    }

    [Fact]
    public void SendKioskIpAnnouncement_WithWhitespace_TrimsArgumentsAndFormats()
    {
        _sut.SendKioskIpAnnouncement("  192.168.4.2  ", 8080, "  portal/kiosk  ");

        _serialMock.Verify(s => s.SendLine("KIOSK_IP 192.168.4.2 8080 /portal/kiosk"), Times.Once);
    }

    [Theory]
    [InlineData("RECONNECT", "WIFI RECONNECT")]
    [InlineData("DISCONNECT", "WIFI DISCONNECT")]
    [InlineData("STATUS", "WIFI STATUS")]
    [InlineData("  RECONNECT  ", "WIFI RECONNECT")]
    public void SendWifiCommand_FormatsProperlyAndCallsSendLine(string action, string expectedCommand)
    {
        _sut.SendWifiCommand(action);

        _serialMock.Verify(s => s.SendLine(expectedCommand), Times.Once);
    }

    [Fact]
    public void Esp32Device_ImplementsIEsp32Device()
    {
        Assert.IsAssignableFrom<IEsp32Device>(_sut);
    }

    [Fact]
    public void Dispose_UnsubscribesFromLineReceived()
    {
        _sut.Dispose();

        var eventFired = false;
        _sut.TelemetryReceived += (_, _) => eventFired = true;

        _serialMock.Raise(s => s.LineReceived += null, _serialMock.Object, "AP_IP:192.168.4.1");

        Assert.False(eventFired);
        Assert.Null(_sut.ApIp);
    }
}
