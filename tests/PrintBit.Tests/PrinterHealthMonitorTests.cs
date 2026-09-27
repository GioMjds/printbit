using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Infrastructure.Windows.PrinterMonitoring;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public class PrinterHealthMonitorTests
{
    private class TestablePrinterHealthMonitor : PrinterHealthMonitor
    {
        public bool MockHealthy { get; set; } = true;
        public int MockWinSpoolStatus { get; set; } = 0;
        public string MockWinSpoolDesc { get; set; } = "OK";
        public int IsHealthyCallCount { get; set; } = 0;

        public TestablePrinterHealthMonitor(
            IOptions<HardwareSettings> hardwareOptions,
            IWorkerEventPipeClient eventPipe)
            : base(
                NullLogger<PrinterHealthMonitor>.Instance,
                hardwareOptions,
                eventPipe)
        {
        }

        public override bool IsHealthy(string printerName, out int winSpoolStatus, out string winSpoolDesc)
        {
            IsHealthyCallCount++;
            winSpoolStatus = MockWinSpoolStatus;
            winSpoolDesc = MockWinSpoolDesc;
            return MockHealthy;
        }
    }

    private sealed class WmiStatusMonitor : PrinterHealthMonitor
    {
        public int DetectedErrorState { get; set; }
        public int ExtendedPrinterStatus { get; set; }
        public bool IsOffline { get; set; }
        public string? EpsonPopupText { get; set; }

        public WmiStatusMonitor(
            IOptions<HardwareSettings> hardwareOptions,
            IWorkerEventPipeClient eventPipe,
            int detectedErrorState = 0,
            int extendedPrinterStatus = 3,
            bool isOffline = false,
            string? epsonPopupText = null)
            : base(
                NullLogger<PrinterHealthMonitor>.Instance,
                hardwareOptions,
                eventPipe)
        {
            DetectedErrorState = detectedErrorState;
            ExtendedPrinterStatus = extendedPrinterStatus;
            IsOffline = isOffline;
            EpsonPopupText = epsonPopupText;
        }

        protected override bool TryReadMonitorStatus(
            string printerName,
            out bool isOffline,
            out int detectedErrorState,
            out int extendedPrinterStatus)
        {
            isOffline = IsOffline;
            detectedErrorState = DetectedErrorState;
            extendedPrinterStatus = ExtendedPrinterStatus;
            return true;
        }

        protected override (bool HasPopup, int ProcessId, string WindowTitle, string Content)
            CheckEpsonStatusMonitorPopup(string printerName) =>
            EpsonPopupText is null
                ? (false, 0, string.Empty, string.Empty)
                : (true, 123, "EPSON Status Monitor 3", EpsonPopupText);

        public Task MonitorOnceAsync(CancellationToken cancellationToken) =>
            MonitorPrinterAsync(cancellationToken);
    }

    private sealed class DiagnosticPrinterHealthMonitor : PrinterHealthMonitor
    {
        public bool WinSpoolAvailable { get; init; } = true;
        public uint WinSpoolStatus { get; init; }
        public string WinSpoolDescription { get; init; } = "READY";
        public bool WmiAvailable { get; init; } = true;
        public bool WmiOffline { get; init; }
        public int DetectedErrorState { get; init; }
        public int ExtendedPrinterStatus { get; init; } = 3;
        public string? EpsonPopupText { get; init; }
        public string? WmiPortName { get; init; }

        public DiagnosticPrinterHealthMonitor()
            : base(
                NullLogger<PrinterHealthMonitor>.Instance,
                Options.Create(new HardwareSettings { PrinterName = "EPSON L5290 Series" }),
                Mock.Of<IWorkerEventPipeClient>())
        {
        }

        protected override bool TryGetWinSpoolStatus(
            string printerName,
            out uint status,
            out string description)
        {
            status = WinSpoolStatus;
            description = WinSpoolDescription;
            return WinSpoolAvailable;
        }

        protected override bool TryReadMonitorStatus(
            string printerName,
            out bool isOffline,
            out int detectedErrorState,
            out int extendedPrinterStatus)
        {
            isOffline = WmiOffline;
            detectedErrorState = DetectedErrorState;
            extendedPrinterStatus = ExtendedPrinterStatus;
            return WmiAvailable;
        }

        protected override bool TryReadPrinterPort(string printerName, out string? portName)
        {
            portName = WmiPortName;
            return WmiPortName is not null;
        }

        protected override (bool HasPopup, int ProcessId, string WindowTitle, string Content)
            CheckEpsonStatusMonitorPopup(string printerName) =>
            EpsonPopupText is null
                ? (false, 0, string.Empty, string.Empty)
                : (true, 123, "EPSON Status Monitor 3", EpsonPopupText);
    }

    [Fact]
    public async Task WaitForPrinterHealthyAsync_StopsOnCancellation()
    {
        var settings = new HardwareSettings { PrinterName = "TestPrinter" };
        var ipcSettings = new IpcSettings { WorkerReturnPipeName = "test-pipe" };
        
        var eventPipe = new WorkerEventPipeClient(
            NullLogger<WorkerEventPipeClient>.Instance,
            Options.Create(ipcSettings));

        var monitor = new TestablePrinterHealthMonitor(
            Options.Create(settings),
            eventPipe)
        {
            MockHealthy = false
        };

        using var cts = new CancellationTokenSource();
        // Cancel immediately
        cts.Cancel();

        // Pass 30 seconds timeout, but cancel immediately via token
        var result = await monitor.WaitForPrinterHealthyAsync("TestPrinter", 30, cts.Token);
        
        Assert.False(result);
    }

    [Fact]
    public async Task WaitForPrinterHealthyAsync_ReturnsTrueIfHealthy()
    {
        var settings = new HardwareSettings { PrinterName = "TestPrinter" };
        var ipcSettings = new IpcSettings { WorkerReturnPipeName = "test-pipe" };

        var eventPipe = new WorkerEventPipeClient(
            NullLogger<WorkerEventPipeClient>.Instance,
            Options.Create(ipcSettings));

        var monitor = new TestablePrinterHealthMonitor(
            Options.Create(settings),
            eventPipe)
        {
            MockHealthy = true
        };

        var result = await monitor.WaitForPrinterHealthyAsync("TestPrinter", 30, CancellationToken.None);

        Assert.True(result);
        Assert.Equal(1, monitor.IsHealthyCallCount);
    }

    [Fact]
    public async Task HasFatalHardwareError_WmiNoPaper_ReturnsTrue()
    {
        var eventPipe = new Mock<IWorkerEventPipeClient>();
        var monitor = new WmiStatusMonitor(
            Options.Create(new HardwareSettings { PrinterName = "EPSON L5290 Series" }),
            eventPipe.Object,
            detectedErrorState: 4);

        // Monitor once so _fatalErrorCode gets updated
        await monitor.MonitorOnceAsync(CancellationToken.None);
        var hasFatal = monitor.HasFatalHardwareError("EPSON L5290 Series", out var code, out var msg);

        Assert.True(hasFatal);
        Assert.Equal(4, code);
        Assert.Contains("No Paper", msg);
    }

    [Fact]
    public async Task MonitorPrinterAsync_WmiNoPaper_EmitsPrinterError()
    {
        var capturedEvents = new List<WorkerPrintEvent>();
        var eventPipe = new Mock<IWorkerEventPipeClient>();
        eventPipe
            .Setup(pipe => pipe.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => capturedEvents.Add(evt))
            .ReturnsAsync(true);

        var monitor = new WmiStatusMonitor(
            Options.Create(new HardwareSettings { PrinterName = "EPSON L5290 Series" }),
            eventPipe.Object,
            detectedErrorState: 4);

        await monitor.MonitorOnceAsync(CancellationToken.None);

        var printerError = Assert.Single(capturedEvents);
        Assert.Equal(WorkerPrintEventType.PrinterError, printerError.Type);
        Assert.Equal("EPSON L5290 Series", printerError.PrinterName);
        Assert.Equal("hardware_error", printerError.FailureStage);
        Assert.Contains("No Paper", printerError.Message);
    }

    [Fact]
    public async Task MonitorPrinterAsync_EpsonPopupError_EmitsPrinterError()
    {
        var capturedEvents = new List<WorkerPrintEvent>();
        var eventPipe = new Mock<IWorkerEventPipeClient>();
        eventPipe
            .Setup(pipe => pipe.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => capturedEvents.Add(evt))
            .ReturnsAsync(true);

        var monitor = new WmiStatusMonitor(
            Options.Create(new HardwareSettings { PrinterName = "EPSON L5290 Series" }),
            eventPipe.Object,
            epsonPopupText: "Paper is out. Load paper into the rear tray.");

        await monitor.MonitorOnceAsync(CancellationToken.None);

        var printerError = Assert.Single(capturedEvents);
        Assert.Equal(WorkerPrintEventType.PrinterError, printerError.Type);
        Assert.Equal("hardware_error", printerError.FailureStage);
        Assert.Equal("99", printerError.ErrorCode);
        Assert.Contains("Paper is out", printerError.Message);
        Assert.True(monitor.HasFatalHardwareError(
            "EPSON L5290 Series",
            out var errorCode,
            out var errorMessage));
        Assert.Equal(99, errorCode);
        Assert.Contains("Paper is out", errorMessage);
    }

    [Fact]
    public void ContainsEpsonErrorKeyword_PaperOutDialog_ReturnsTrue()
    {
        const string popupContent =
            "EPSON Status Monitor 3 : EPSON L5290 Series\nPaper out or incorrect loading";

        Assert.True(PrinterHealthMonitor.ContainsEpsonErrorKeyword(popupContent));
    }

    [Fact]
    public void GetDiagnostic_HealthyProbes_ReturnsHealthyWithoutIssue()
    {
        var diagnostic = new DiagnosticPrinterHealthMonitor()
            .GetDiagnostic("EPSON L5290 Series");

        Assert.Equal(PrinterHealthState.Healthy, diagnostic.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.None, diagnostic.IssueKind);
        Assert.Equal(0, diagnostic.WinSpoolStatus);
        Assert.Equal("READY", diagnostic.WinSpoolDescription);
        Assert.Null(diagnostic.WmiCode);
        Assert.Null(diagnostic.WmiDescription);
        Assert.Null(diagnostic.EpsonPopupText);
        Assert.True(diagnostic.IsHealthy);
    }

    [Fact]
    public void ExactQueueDiagnostic_ReportsCurrentPort()
    {
        var monitor = new DiagnosticPrinterHealthMonitor { WmiPortName = "USB005" };

        Assert.Equal("USB005", monitor.GetDiagnostic("EPSON L5290 Series").PortName);
    }

    [Theory]
    [InlineData(4, "No Paper")]
    [InlineData(6, "No Toner")]
    [InlineData(7, "Door Open")]
    [InlineData(8, "Jammed")]
    [InlineData(10, "Service Requested")]
    public void GetDiagnostic_WmiPhysicalFault_ReturnsPhysicalFault(int code, string description)
    {
        var diagnostic = new DiagnosticPrinterHealthMonitor
        {
            DetectedErrorState = code
        }.GetDiagnostic("EPSON L5290 Series");

        Assert.Equal(PrinterHealthState.Fault, diagnostic.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.PhysicalFault, diagnostic.IssueKind);
        Assert.Equal(code, diagnostic.WmiCode);
        Assert.Contains(description, diagnostic.WmiDescription);
        Assert.False(diagnostic.IsHealthy);
    }

    [Fact]
    public void GetDiagnostic_EpsonPopupError_ReturnsPhysicalFault()
    {
        var diagnostic = new DiagnosticPrinterHealthMonitor
        {
            EpsonPopupText = "Paper jam. Open the cover."
        }.GetDiagnostic("EPSON L5290 Series");

        Assert.Equal(PrinterHealthState.Fault, diagnostic.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.PhysicalFault, diagnostic.IssueKind);
        Assert.Equal("Paper jam. Open the cover.", diagnostic.EpsonPopupText);
        Assert.False(diagnostic.IsHealthy);
    }

    [Fact]
    public void GetDiagnostic_MissingQueue_ReturnsUnavailableWindowsQueueFault()
    {
        var diagnostic = new DiagnosticPrinterHealthMonitor
        {
            WinSpoolAvailable = false,
            WinSpoolDescription = "Failed to OpenPrinter",
            WmiAvailable = false
        }.GetDiagnostic("Missing Printer");

        Assert.Equal(PrinterHealthState.Unavailable, diagnostic.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.WindowsQueueFault, diagnostic.IssueKind);
        Assert.Equal("Failed to OpenPrinter", diagnostic.WinSpoolDescription);
        Assert.Contains("not found", diagnostic.WmiDescription);
        Assert.False(diagnostic.IsHealthy);
    }

    [Theory]
    [InlineData(true, 3, 0)]
    [InlineData(false, 7, 0)]
    [InlineData(false, 3, WinSpoolApi.PRINTER_STATUS_OFFLINE)]
    public void GetDiagnostic_OfflineQueue_ReturnsOfflineWindowsQueueFault(
        bool wmiOffline,
        int extendedPrinterStatus,
        uint winSpoolStatus)
    {
        var diagnostic = new DiagnosticPrinterHealthMonitor
        {
            WmiOffline = wmiOffline,
            ExtendedPrinterStatus = extendedPrinterStatus,
            WinSpoolStatus = winSpoolStatus,
            WinSpoolDescription = winSpoolStatus == 0 ? "READY" : "OFFLINE"
        }.GetDiagnostic("EPSON L5290 Series");

        Assert.Equal(PrinterHealthState.Offline, diagnostic.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.WindowsQueueFault, diagnostic.IssueKind);
        Assert.False(diagnostic.IsHealthy);
    }

    [Fact]
    public void GetDiagnostic_WinSpoolFault_ReturnsWindowsQueueFault()
    {
        var diagnostic = new DiagnosticPrinterHealthMonitor
        {
            WinSpoolStatus = WinSpoolApi.PRINTER_STATUS_ERROR,
            WinSpoolDescription = "ERROR"
        }.GetDiagnostic("EPSON L5290 Series");

        Assert.Equal(PrinterHealthState.Fault, diagnostic.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.WindowsQueueFault, diagnostic.IssueKind);
        Assert.False(diagnostic.IsHealthy);
    }

    [Theory]
    [InlineData(6, "Stopped Printing")]
    [InlineData(9, "Error")]
    public void GetDiagnostic_WmiQueueFault_ReturnsWindowsQueueFault(int status, string description)
    {
        var diagnostic = new DiagnosticPrinterHealthMonitor
        {
            ExtendedPrinterStatus = status
        }.GetDiagnostic("EPSON L5290 Series");

        Assert.Equal(PrinterHealthState.Fault, diagnostic.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.WindowsQueueFault, diagnostic.IssueKind);
        Assert.Equal(status, diagnostic.WmiCode);
        Assert.Contains(description, diagnostic.WmiDescription);
        Assert.False(diagnostic.IsHealthy);
    }

    [Fact]
    public void GetDiagnostic_UnavailableWmiQueue_ReturnsUnavailableWindowsQueueFault()
    {
        var diagnostic = new DiagnosticPrinterHealthMonitor
        {
            ExtendedPrinterStatus = 11
        }.GetDiagnostic("EPSON L5290 Series");

        Assert.Equal(PrinterHealthState.Unavailable, diagnostic.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.WindowsQueueFault, diagnostic.IssueKind);
        Assert.Equal(11, diagnostic.WmiCode);
        Assert.Contains("Not Available", diagnostic.WmiDescription);
        Assert.False(diagnostic.IsHealthy);
    }

    [Fact]
    public void HasFatalHardwareError_WinSpoolUnavailableWithHealthyWmi_RetainsFalseResult()
    {
        var monitor = new DiagnosticPrinterHealthMonitor
        {
            WinSpoolAvailable = false,
            WinSpoolDescription = "Failed to OpenPrinter"
        };

        var hasFatalError = monitor.HasFatalHardwareError(
            "EPSON L5290 Series",
            out var errorCode,
            out var errorMessage);

        Assert.False(hasFatalError);
        Assert.Equal(0, errorCode);
        Assert.Empty(errorMessage);
    }

    [Fact]
    public async Task BroadcastInitialSnapshotAsync_WhenOnline_BroadcastsOnlineSnapshot()
    {
        var capturedEvents = new List<WorkerPrintEvent>();
        var eventPipe = new Mock<IWorkerEventPipeClient>();
        eventPipe
            .Setup(pipe => pipe.PublishAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => capturedEvents.Add(evt))
            .ReturnsAsync(true);

        var monitor = new WmiStatusMonitor(
            Options.Create(new HardwareSettings { PrinterName = "EPSON L5290 Series" }),
            eventPipe.Object,
            isOffline: false);

        var result = await monitor.BroadcastInitialSnapshotAsync(CancellationToken.None);

        Assert.True(result);
        var snapshot = Assert.Single(capturedEvents);
        Assert.Equal(WorkerPrintEventType.PrinterStatusSnapshot, snapshot.Type);
        Assert.Equal("EPSON L5290 Series", snapshot.PrinterName);
        Assert.Equal("Printer is online", snapshot.Message);
    }

    [Fact]
    public async Task BroadcastInitialSnapshotAsync_WhenOffline_BroadcastsOfflineSnapshot()
    {
        var capturedEvents = new List<WorkerPrintEvent>();
        var eventPipe = new Mock<IWorkerEventPipeClient>();
        eventPipe
            .Setup(pipe => pipe.PublishAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => capturedEvents.Add(evt))
            .ReturnsAsync(true);

        var monitor = new WmiStatusMonitor(
            Options.Create(new HardwareSettings { PrinterName = "EPSON L5290 Series" }),
            eventPipe.Object,
            isOffline: true);

        var result = await monitor.BroadcastInitialSnapshotAsync(CancellationToken.None);

        Assert.True(result);
        var snapshot = Assert.Single(capturedEvents);
        Assert.Equal(WorkerPrintEventType.PrinterStatusSnapshot, snapshot.Type);
        Assert.Equal("EPSON L5290 Series", snapshot.PrinterName);
        Assert.Equal("Printer is offline", snapshot.Message);
    }

    [Fact]
    public async Task StartAsync_BroadcastsInitialSnapshotOnStartup()
    {
        var tcs = new TaskCompletionSource<WorkerPrintEvent>();
        var eventPipe = new Mock<IWorkerEventPipeClient>();
        eventPipe
            .Setup(pipe => pipe.PublishAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => tcs.TrySetResult(evt))
            .ReturnsAsync(true);
        eventPipe
            .Setup(pipe => pipe.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => tcs.TrySetResult(evt))
            .ReturnsAsync(true);

        var monitor = new WmiStatusMonitor(
            Options.Create(new HardwareSettings { PrinterName = "EPSON L5290 Series" }),
            eventPipe.Object,
            isOffline: false);

        await monitor.StartAsync(CancellationToken.None);
        var snapshot = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await monitor.StopAsync(CancellationToken.None);

        Assert.Equal(WorkerPrintEventType.PrinterStatusSnapshot, snapshot.Type);
        Assert.Equal("EPSON L5290 Series", snapshot.PrinterName);
        Assert.Equal("Printer is online", snapshot.Message);
    }

    [Fact]
    public async Task MonitorPrinterAsync_WhenHardwareErrorClears_BroadcastsHealthyPrinterEvent()
    {
        var capturedEvents = new List<WorkerPrintEvent>();
        var eventPipe = new Mock<IWorkerEventPipeClient>();
        eventPipe
            .Setup(pipe => pipe.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => capturedEvents.Add(evt))
            .ReturnsAsync(true);

        var monitor = new WmiStatusMonitor(
            Options.Create(new HardwareSettings { PrinterName = "EPSON L5290 Series" }),
            eventPipe.Object,
            detectedErrorState: 4,
            isOffline: false);

        await monitor.MonitorOnceAsync(CancellationToken.None);
        Assert.Equal(WorkerPrintEventType.PrinterError, Assert.Single(capturedEvents).Type);

        monitor.DetectedErrorState = 0;
        await monitor.MonitorOnceAsync(CancellationToken.None);

        Assert.Equal(2, capturedEvents.Count);
        Assert.Equal(WorkerPrintEventType.PrinterOnline, capturedEvents[1].Type);
        Assert.Equal("Printer is online", capturedEvents[1].Message);
    }
}
