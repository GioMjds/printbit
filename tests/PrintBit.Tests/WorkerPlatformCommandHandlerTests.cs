using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Moq;
using PrintBit.HardwareService.Services;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Windows.Networking;
using PrintBit.Infrastructure.Windows.Security;
using PrintBit.Infrastructure.Windows.Storage;
using PrintBit.Infrastructure.Windows.Time;
using Xunit;

namespace PrintBit.Tests;

public class WorkerPlatformCommandHandlerTests
{
    private readonly Mock<IAntivirusScanner> _scannerMock = new();
    private readonly Mock<IUsbStorageService> _usbMock = new();
    private readonly Mock<ITrustedTimeProvider> _timeMock = new();
    private readonly Mock<IKioskNetworkPlatform> _networkMock = new();
    private readonly Mock<ILogger<WorkerPlatformCommandHandler>> _loggerMock = new();

    private WorkerPlatformCommandHandler CreateHandler() =>
        new(_scannerMock.Object, _usbMock.Object, _timeMock.Object, _networkMock.Object, _loggerMock.Object);

    [Fact]
    public async Task HandleAsync_ScanFileSecurity_MapsToResponse()
    {
        _scannerMock.Setup(x => x.ScanFileAsync(@"C:\PrintBit\uploads\test.pdf", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new DefenderScanResult("clean", null, "Clean file", null));

        var handler = CreateHandler();
        var result = await handler.HandleAsync(
            new ScanFileSecurityCommand { RequestId = "sec-1", FilePath = @"C:\PrintBit\uploads\test.pdf" },
            CancellationToken.None);

        var response = Assert.IsType<FileSecurityScanResponse>(result);
        Assert.Equal("sec-1", response.RequestId);
        Assert.True(response.Success);
        Assert.Equal("clean", response.Status);
    }

    [Fact]
    public async Task HandleAsync_GetDefenderHealth_MapsToResponse()
    {
        _scannerMock.Setup(x => x.GetHealthAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new DefenderHealth("clean", 1.5, "Fresh", null));

        var handler = CreateHandler();
        var result = await handler.HandleAsync(
            new GetDefenderHealthCommand { RequestId = "def-1" },
            CancellationToken.None);

        var response = Assert.IsType<DefenderHealthResponse>(result);
        Assert.Equal("def-1", response.RequestId);
        Assert.True(response.Success);
        Assert.Equal(1.5, response.SignatureAgeHours);
    }

    [Fact]
    public async Task HandleAsync_ListUsbDrives_MapsToResponse()
    {
        _usbMock.Setup(x => x.ListRemovableAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync([new RemovableDrive("E:", "USB_KEY", 1000, 2000)]);

        var handler = CreateHandler();
        var result = await handler.HandleAsync(
            new ListUsbDrivesCommand { RequestId = "usb-1" },
            CancellationToken.None);

        var response = Assert.IsType<ListUsbDrivesResponse>(result);
        Assert.Equal("usb-1", response.RequestId);
        Assert.True(response.Success);
        Assert.Single(response.Drives);
        Assert.Equal("E:", response.Drives[0].Drive);
    }

    [Fact]
    public async Task HandleAsync_ExportScanToUsb_MapsToResponse()
    {
        _usbMock.Setup(x => x.ExportAsync(@"C:\PrintBit\scans\1.pdf", "E:", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new UsbExportResult(true, @"E:\PrintBit\Scans\1.pdf", "E:", null, "Exported"));

        var handler = CreateHandler();
        var result = await handler.HandleAsync(
            new ExportScanToUsbCommand { RequestId = "usb-2", SourcePath = @"C:\PrintBit\scans\1.pdf", Drive = "E:" },
            CancellationToken.None);

        var response = Assert.IsType<ExportScanToUsbResponse>(result);
        Assert.Equal("usb-2", response.RequestId);
        Assert.True(response.Success);
        Assert.Equal(@"E:\PrintBit\Scans\1.pdf", response.ExportPath);
    }

    [Fact]
    public async Task HandleAsync_GetTrustedTimeStatus_MapsToResponse()
    {
        var now = DateTime.UtcNow;
        _timeMock.Setup(x => x.GetStatusAsync("time.windows.com", 60_000, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new TrustedTimeSnapshot("ntp", true, 25, false, 60_000, now, "time.windows.com", now, "OK", null));

        var handler = CreateHandler();
        var result = await handler.HandleAsync(
            new GetTrustedTimeStatusCommand { RequestId = "time-1", NtpServer = "time.windows.com", MaxDriftMs = 60_000 },
            CancellationToken.None);

        var response = Assert.IsType<TrustedTimeStatusResponse>(result);
        Assert.Equal("time-1", response.RequestId);
        Assert.True(response.Success);
        Assert.True(response.Synced);
        Assert.Equal(25, response.OffsetMs);
    }

    [Fact]
    public async Task HandleAsync_PrepareHotspotPlatform_MapsToResponse()
    {
        _networkMock.Setup(x => x.PrepareAsync(It.IsAny<IReadOnlyList<string>>(), 3000, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new KioskNetworkSnapshot(true, "192.168.4.1", true, null, "Ready"));

        var handler = CreateHandler();
        var result = await handler.HandleAsync(
            new PrepareHotspotPlatformCommand { RequestId = "net-1", PreferredSubnetPrefixes = ["192.168.4."], Port = 3000 },
            CancellationToken.None);

        var response = Assert.IsType<PrepareHotspotPlatformResponse>(result);
        Assert.Equal("net-1", response.RequestId);
        Assert.True(response.Success);
        Assert.Equal("192.168.4.1", response.KioskIp);
        Assert.True(response.FirewallReady);
    }

    [Fact]
    public async Task HandleAsync_WhenExceptionThrown_ReturnsHardwareErrorResponse()
    {
        _scannerMock.Setup(x => x.GetHealthAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("Defender service crashed"));

        var handler = CreateHandler();
        var result = await handler.HandleAsync(
            new GetDefenderHealthCommand { RequestId = "err-1" },
            CancellationToken.None);

        var response = Assert.IsType<HardwareErrorResponse>(result);
        Assert.Equal("err-1", response.RequestId);
        Assert.False(response.Success);
        Assert.Equal("PLATFORM_COMMAND_FAILED", response.ErrorCode);
        Assert.Contains("Defender service crashed", response.Message);
    }
}
