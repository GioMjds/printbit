using System;
using System.IO;
using System.Text.Json;
using PrintBit.Infrastructure.IPC;
using Xunit;

namespace PrintBit.Tests;

public class WorkerPlatformCommandTests
{
    [Fact]
    public void TryParseHardwareCommand_ParsesGetDefenderHealth()
    {
        const string json = """{"type":"GetDefenderHealth","requestId":"def-1"}""";
        var ok = WorkerCommandParser.TryParseHardwareCommand(json, 8192, out var command, out var error, out var requestId, out var type);
        Assert.True(ok, error);
        Assert.IsType<GetDefenderHealthCommand>(command);
        Assert.Equal("def-1", requestId);
        Assert.Equal("GetDefenderHealth", type);
    }

    [Fact]
    public void TryParseHardwareCommand_ParsesScanFileSecurity()
    {
        const string json = """{"type":"ScanFileSecurity","requestId":"sec-1","filePath":"C:\\PrintBit\\uploads\\x.upload"}""";
        var ok = WorkerCommandParser.TryParseHardwareCommand(json, 8192, out var command, out var error, out var requestId, out var type);
        Assert.True(ok, error);
        var typed = Assert.IsType<ScanFileSecurityCommand>(command);
        Assert.Equal("sec-1", requestId);
        Assert.Equal("ScanFileSecurity", type);
        Assert.Equal(@"C:\PrintBit\uploads\x.upload", typed.FilePath);
    }

    [Fact]
    public void TryParseHardwareCommand_RejectsRelativeSecurityPath()
    {
        const string json = """{"type":"ScanFileSecurity","requestId":"sec-2","filePath":"relative.upload"}""";
        Assert.False(WorkerCommandParser.TryParseHardwareCommand(json, 8192, out _, out var error));
        Assert.Contains("absolute", error!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TryParseHardwareCommand_ParsesListUsbDrives()
    {
        const string json = """{"type":"ListUsbDrives","requestId":"usb-1"}""";
        var ok = WorkerCommandParser.TryParseHardwareCommand(json, 8192, out var command, out var error, out var requestId, out var type);
        Assert.True(ok, error);
        Assert.IsType<ListUsbDrivesCommand>(command);
        Assert.Equal("usb-1", requestId);
        Assert.Equal("ListUsbDrives", type);
    }

    [Fact]
    public void TryParseHardwareCommand_ParsesExportScanToUsb()
    {
        const string json = """{"type":"ExportScanToUsb","requestId":"usb-2","sourcePath":"C:\\PrintBit\\scans\\doc.pdf","drive":"E:"}""";
        var ok = WorkerCommandParser.TryParseHardwareCommand(json, 8192, out var command, out var error, out var requestId, out var type);
        Assert.True(ok, error);
        var typed = Assert.IsType<ExportScanToUsbCommand>(command);
        Assert.Equal("usb-2", requestId);
        Assert.Equal(@"C:\PrintBit\scans\doc.pdf", typed.SourcePath);
        Assert.Equal("E:", typed.Drive);
    }

    [Theory]
    [InlineData("E")]
    [InlineData("E:\\")]
    [InlineData("1:")]
    [InlineData("")]
    public void TryParseHardwareCommand_RejectsInvalidUsbDrive(string drive)
    {
        var json = $$"""{"type":"ExportScanToUsb","requestId":"usb-3","sourcePath":"C:\\PrintBit\\scans\\doc.pdf","drive":"{{drive}}"}""";
        Assert.False(WorkerCommandParser.TryParseHardwareCommand(json, 8192, out _, out var error));
        Assert.NotNull(error);
    }

    [Fact]
    public void TryParseHardwareCommand_ParsesGetTrustedTimeStatus_Defaults()
    {
        const string json = """{"type":"GetTrustedTimeStatus","requestId":"time-1"}""";
        var ok = WorkerCommandParser.TryParseHardwareCommand(json, 8192, out var command, out var error, out var requestId, out var type);
        Assert.True(ok, error);
        var typed = Assert.IsType<GetTrustedTimeStatusCommand>(command);
        Assert.Equal("time-1", requestId);
        Assert.Null(typed.NtpServer);
        Assert.Equal(60_000, typed.MaxDriftMs);
    }

    [Fact]
    public void TryParseHardwareCommand_ParsesGetTrustedTimeStatus_CustomServer()
    {
        const string json = """{"type":"GetTrustedTimeStatus","requestId":"time-2","ntpServer":"time.windows.com","maxDriftMs":15000}""";
        var ok = WorkerCommandParser.TryParseHardwareCommand(json, 8192, out var command, out var error, out var requestId, out var type);
        Assert.True(ok, error);
        var typed = Assert.IsType<GetTrustedTimeStatusCommand>(command);
        Assert.Equal("time.windows.com", typed.NtpServer);
        Assert.Equal(15_000, typed.MaxDriftMs);
    }

    [Fact]
    public void TryParseHardwareCommand_RejectsInvalidNtpServer()
    {
        const string json = """{"type":"GetTrustedTimeStatus","requestId":"time-3","ntpServer":"bad server; injection"}""";
        Assert.False(WorkerCommandParser.TryParseHardwareCommand(json, 8192, out _, out var error));
        Assert.Contains("invalid", error!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TryParseHardwareCommand_RejectsNegativeDrift()
    {
        const string json = """{"type":"GetTrustedTimeStatus","requestId":"time-4","maxDriftMs":-1}""";
        Assert.False(WorkerCommandParser.TryParseHardwareCommand(json, 8192, out _, out var error));
        Assert.Contains("non-negative", error!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TryParseHardwareCommand_ParsesPrepareHotspotPlatform()
    {
        const string json = """{"type":"PrepareHotspotPlatform","requestId":"net-1","port":3000,"preferredSubnetPrefixes":["192.168.4.","10.0."]}""";
        var ok = WorkerCommandParser.TryParseHardwareCommand(json, 8192, out var command, out var error, out var requestId, out var type);
        Assert.True(ok, error);
        var typed = Assert.IsType<PrepareHotspotPlatformCommand>(command);
        Assert.Equal("net-1", requestId);
        Assert.Equal(3000, typed.Port);
        Assert.Equal(["192.168.4.", "10.0."], typed.PreferredSubnetPrefixes);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(65536)]
    public void TryParseHardwareCommand_RejectsInvalidHotspotPort(int port)
    {
        var json = $$"""{"type":"PrepareHotspotPlatform","requestId":"net-2","port":{{port}}}""";
        Assert.False(WorkerCommandParser.TryParseHardwareCommand(json, 8192, out _, out var error));
        Assert.Contains("Port", error!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TryParseHardwareCommand_RejectsInvalidSubnetPrefix()
    {
        const string json = """{"type":"PrepareHotspotPlatform","requestId":"net-3","port":3000,"preferredSubnetPrefixes":["invalid.prefix"]}""";
        Assert.False(WorkerCommandParser.TryParseHardwareCommand(json, 8192, out _, out var error));
        Assert.Contains("prefix", error!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ResponseSerialization_ProducesExpectedCamelCaseJson()
    {
        var defenderRes = new DefenderHealthResponse
        {
            RequestId = "def-res-1",
            Success = true,
            Status = "clean",
            SignatureAgeHours = 2.5,
            Detail = "Up to date"
        };
        var json = JsonSerializer.Serialize(defenderRes, WorkerCommandParser.JsonOptions);
        Assert.Contains(@"""requestId"":""def-res-1""", json);
        Assert.Contains(@"""type"":""GetDefenderHealth""", json);
        Assert.Contains(@"""signatureAgeHours"":2.5", json);
    }
}
