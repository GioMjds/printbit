using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Infrastructure.Windows.PrinterMonitoring;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public class PrinterRecoveryServiceTests
{
    [Theory]
    [InlineData(SupervisorDecision.StartSpooler, false)]
    [InlineData(SupervisorDecision.RestartSpooler, true)]
    public async Task ExplicitDecisionPhysicalFaultNeverStartsOrRestarts(SupervisorDecision decision, bool running)
    {
        _healthMonitorMock.Setup(h => h.GetDiagnostic(It.IsAny<string>())).Returns(new PrinterHealthDiagnostic
        {
            PrinterState = PrinterHealthState.Fault, IssueKind = PrinterHealthIssueKind.PhysicalFault
        });
        _spoolerControllerMock.Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot { IsRunning = running, Status = running ? "Running" : "Stopped" });
        var result = await CreateService().AttemptRepairAsync(decision, CancellationToken.None);
        Assert.Equal(PrinterRecoveryOutcome.ManualInterventionRequired, result.Outcome);
        _spoolerControllerMock.Verify(s => s.StartAsync(It.IsAny<CancellationToken>()), Times.Never);
        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task StartFailureReportsStartActionWithoutClaimingRestart()
    {
        _healthMonitorMock.Setup(h => h.GetDiagnostic(It.IsAny<string>())).Returns(new PrinterHealthDiagnostic
        {
            PrinterState = PrinterHealthState.Unavailable, IssueKind = PrinterHealthIssueKind.WindowsQueueFault
        });
        _spoolerControllerMock.Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot { Status = "Stopped" });
        _spoolerControllerMock.Setup(s => s.StartAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerRestartResult { Success = false, FinalStatus = "Stopped", Error = "denied" });
        var result = await CreateService().AttemptRepairAsync(SupervisorDecision.StartSpooler, CancellationToken.None);
        Assert.Equal("StartSpooler", result.Action);
        Assert.DoesNotContain("restart", result.Message!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("denied", result.Message);
    }
    private readonly Mock<IPrinterHealthMonitor> _healthMonitorMock;
    private readonly Mock<IPrintSpoolerController> _spoolerControllerMock;
    private readonly Mock<IPrinterOperationCoordinator> _coordinatorMock;
    private readonly PrinterRecoverySettings _recoverySettings;
    private readonly HardwareSettings _hardwareSettings;
    private readonly Mock<IDisposable> _leaseMock;

    public PrinterRecoveryServiceTests()
    {
        _healthMonitorMock = new Mock<IPrinterHealthMonitor>();
        _spoolerControllerMock = new Mock<IPrintSpoolerController>();
        _coordinatorMock = new Mock<IPrinterOperationCoordinator>();
        _leaseMock = new Mock<IDisposable>();

        _recoverySettings = new PrinterRecoverySettings
        {
            ServiceName = "Spooler",
            PrinterName = "EPSON L5290 Series",
            SpoolerTransitionTimeoutSeconds = 30,
            HealthRecheckTimeoutSeconds = 10,
            HealthRecheckIntervalSeconds = 2
        };

        _hardwareSettings = new HardwareSettings
        {
            PrinterName = "EPSON L5290 Series"
        };

        // Default coordinator allows lease
        IDisposable? lease = _leaseMock.Object;
        _coordinatorMock
            .Setup(c => c.TryAcquireRecovery(out lease))
            .Returns(true);
    }

    private PrinterRecoveryService CreateService(PrinterRecoverySettings? settings = null)
    {
        return new PrinterRecoveryService(
            _healthMonitorMock.Object,
            _spoolerControllerMock.Object,
            _coordinatorMock.Object,
            Options.Create(settings ?? _recoverySettings),
            Options.Create(_hardwareSettings));
    }

    [Fact]
    public async Task AttemptRepairAsync_WhenPrinterIsHealthy_ReturnsHealthyWithoutRestart()
    {
        // Arrange
        _healthMonitorMock
            .Setup(h => h.GetDiagnostic("EPSON L5290 Series"))
            .Returns(new PrinterHealthDiagnostic
            {
                PrinterState = PrinterHealthState.Healthy,
                IssueKind = PrinterHealthIssueKind.None,
                WinSpoolDescription = "Ready"
            });

        _spoolerControllerMock
            .Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot
            {
                IsRunning = true,
                Status = "Running"
            });

        var service = CreateService();

        // Act
        var result = await service.AttemptRepairAsync(CancellationToken.None);

        // Assert
        Assert.Equal(PrinterRecoveryOutcome.Healthy, result.Outcome);
        Assert.Equal(PrinterRecoveryCommandType.AttemptPrinterRecovery, result.Type);
        Assert.Null(result.Action);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Null(result.SpoolerState.ErrorMessage);
        Assert.Equal(PrinterHealthState.Healthy.ToString(), result.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.None.ToString(), result.IssueKind);
        Assert.False(string.IsNullOrWhiteSpace(result.Message));
        Assert.True(result.StartedAt <= result.CompletedAt);

        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Never);
        _leaseMock.Verify(l => l.Dispose(), Times.Once);
    }

    [Theory]
    [InlineData("Paper Out", 4)]
    [InlineData("Door Open", 7)]
    public async Task AttemptRepairAsync_WhenPhysicalFault_ReturnsManualInterventionRequiredWithoutRestart(
        string errorDesc, int wmiCode)
    {
        // Arrange
        _healthMonitorMock
            .Setup(h => h.GetDiagnostic("EPSON L5290 Series"))
            .Returns(new PrinterHealthDiagnostic
            {
                PrinterState = PrinterHealthState.Fault,
                IssueKind = PrinterHealthIssueKind.PhysicalFault,
                WmiCode = wmiCode,
                WmiDescription = errorDesc,
                WinSpoolDescription = errorDesc
            });

        _spoolerControllerMock
            .Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot
            {
                IsRunning = true,
                Status = "Running"
            });

        var service = CreateService();

        // Act
        var result = await service.AttemptRepairAsync(CancellationToken.None);

        // Assert
        Assert.Equal(PrinterRecoveryOutcome.ManualInterventionRequired, result.Outcome);
        Assert.Equal(PrinterRecoveryCommandType.AttemptPrinterRecovery, result.Type);
        Assert.Null(result.Action);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Null(result.SpoolerState.ErrorMessage);
        Assert.Equal(PrinterHealthState.Fault.ToString(), result.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.PhysicalFault.ToString(), result.IssueKind);
        Assert.False(string.IsNullOrWhiteSpace(result.Message));

        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Never);
        _leaseMock.Verify(l => l.Dispose(), Times.Once);
    }

    [Fact]
    public async Task AttemptRepairAsync_WhenWindowsQueueFault_RestartsSpoolerAndReturnsRecovered()
    {
        // Arrange
        var offlineDiagnostic = new PrinterHealthDiagnostic
        {
            PrinterState = PrinterHealthState.Offline,
            IssueKind = PrinterHealthIssueKind.WindowsQueueFault,
            WinSpoolDescription = "Printer offline"
        };

        var healthyDiagnostic = new PrinterHealthDiagnostic
        {
            PrinterState = PrinterHealthState.Healthy,
            IssueKind = PrinterHealthIssueKind.None,
            WinSpoolDescription = "Ready"
        };

        _healthMonitorMock
            .SetupSequence(h => h.GetDiagnostic("EPSON L5290 Series"))
            .Returns(offlineDiagnostic)
            .Returns(healthyDiagnostic);

        _spoolerControllerMock
            .Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot
            {
                IsRunning = true,
                Status = "Running"
            });

        _spoolerControllerMock
            .Setup(s => s.RestartAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerRestartResult
            {
                Success = true,
                FinalStatus = "Running"
            });

        var service = CreateService();

        // Act
        var result = await service.AttemptRepairAsync(CancellationToken.None);

        // Assert
        Assert.Equal(PrinterRecoveryOutcome.Recovered, result.Outcome);
        Assert.Equal(PrinterRecoveryCommandType.AttemptPrinterRecovery, result.Type);
        Assert.Equal("RestartSpooler", result.Action);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Null(result.SpoolerState.ErrorMessage);
        Assert.Equal(PrinterHealthState.Healthy.ToString(), result.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.None.ToString(), result.IssueKind);
        Assert.False(string.IsNullOrWhiteSpace(result.Message));

        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Once);
        _leaseMock.Verify(l => l.Dispose(), Times.Once);
    }

    [Fact]
    public async Task AttemptRepairAsync_WhenSpoolerStopped_StartsWithoutRestarting()
    {
        var offlineDiagnostic = new PrinterHealthDiagnostic
        {
            PrinterState = PrinterHealthState.Offline,
            IssueKind = PrinterHealthIssueKind.WindowsQueueFault,
            WinSpoolDescription = "Printer offline"
        };
        var healthyDiagnostic = new PrinterHealthDiagnostic
        {
            PrinterState = PrinterHealthState.Healthy,
            IssueKind = PrinterHealthIssueKind.None,
            WinSpoolDescription = "Ready"
        };
        _healthMonitorMock
            .SetupSequence(h => h.GetDiagnostic("EPSON L5290 Series"))
            .Returns(offlineDiagnostic)
            .Returns(healthyDiagnostic);
        _spoolerControllerMock
            .Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot { IsRunning = false, Status = "Stopped" });
        _spoolerControllerMock
            .Setup(s => s.StartAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerRestartResult { Success = true, FinalStatus = "Running" });

        var result = await CreateService().AttemptRepairAsync(CancellationToken.None);

        Assert.Equal(PrinterRecoveryOutcome.Recovered, result.Outcome);
        Assert.Equal("StartSpooler", result.Action);
        Assert.DoesNotContain("restart", result.Message!, StringComparison.OrdinalIgnoreCase);
        _spoolerControllerMock.Verify(s => s.StartAsync(It.IsAny<CancellationToken>()), Times.Once);
        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task AttemptRepairAsync_WhenSpoolerRestartFails_ReturnsRestartFailed()
    {
        // Arrange
        _healthMonitorMock
            .Setup(h => h.GetDiagnostic("EPSON L5290 Series"))
            .Returns(new PrinterHealthDiagnostic
            {
                PrinterState = PrinterHealthState.Offline,
                IssueKind = PrinterHealthIssueKind.WindowsQueueFault,
                WinSpoolDescription = "Printer offline"
            });

        _spoolerControllerMock
            .Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot
            {
                IsRunning = true,
                Status = "Running"
            });

        _spoolerControllerMock
            .Setup(s => s.RestartAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerRestartResult
            {
                Success = false,
                Error = "Service cannot be stopped",
                FinalStatus = "Running"
            });

        var service = CreateService();

        // Act
        var result = await service.AttemptRepairAsync(CancellationToken.None);

        // Assert
        Assert.Equal(PrinterRecoveryOutcome.RestartFailed, result.Outcome);
        Assert.Equal(PrinterRecoveryCommandType.AttemptPrinterRecovery, result.Type);
        Assert.Equal("RestartSpooler", result.Action);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Equal("Service cannot be stopped", result.SpoolerState.ErrorMessage);
        Assert.Equal(PrinterHealthState.Offline.ToString(), result.PrinterState);
        Assert.Contains("Service cannot be stopped", result.Message);

        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Once);
        _leaseMock.Verify(l => l.Dispose(), Times.Once);
    }

    [Fact]
    public async Task AttemptRepairAsync_WhenLeaseOccupied_ReturnsWorkerBusyWithoutQueryOrRestart()
    {
        // Arrange
        IDisposable? lease = null;
        _coordinatorMock
            .Setup(c => c.TryAcquireRecovery(out lease))
            .Returns(false);

        var service = CreateService();

        // Act
        var result = await service.AttemptRepairAsync(CancellationToken.None);

        // Assert
        Assert.Equal(PrinterRecoveryOutcome.WorkerBusy, result.Outcome);
        Assert.Equal(PrinterRecoveryCommandType.AttemptPrinterRecovery, result.Type);
        Assert.Null(result.Action);
        Assert.Null(result.SpoolerState);
        Assert.Null(result.PrinterState);
        Assert.Null(result.IssueKind);
        Assert.Equal("Printer recovery is unavailable while an operation is active.", result.Message);
        Assert.True(result.StartedAt <= result.CompletedAt);

        _healthMonitorMock.Verify(h => h.GetDiagnostic(It.IsAny<string>()), Times.Never);
        _spoolerControllerMock.Verify(s => s.GetStatusAsync(It.IsAny<CancellationToken>()), Times.Never);
        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task AttemptRepairAsync_WhenRecheckExpiresWithWindowsQueueFault_ReturnsRestartFailed()
    {
        // Arrange
        var fastSettings = new PrinterRecoverySettings
        {
            ServiceName = "Spooler",
            PrinterName = "EPSON L5290 Series",
            SpoolerTransitionTimeoutSeconds = 30,
            HealthRecheckTimeoutSeconds = 0,
            HealthRecheckIntervalSeconds = 0
        };

        var offlineDiagnostic = new PrinterHealthDiagnostic
        {
            PrinterState = PrinterHealthState.Offline,
            IssueKind = PrinterHealthIssueKind.WindowsQueueFault,
            WinSpoolDescription = "Printer offline"
        };

        _healthMonitorMock
            .Setup(h => h.GetDiagnostic("EPSON L5290 Series"))
            .Returns(offlineDiagnostic);

        _spoolerControllerMock
            .Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot
            {
                IsRunning = true,
                Status = "Running"
            });

        _spoolerControllerMock
            .Setup(s => s.RestartAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerRestartResult
            {
                Success = true,
                FinalStatus = "Running"
            });

        var service = CreateService(fastSettings);

        // Act
        var result = await service.AttemptRepairAsync(CancellationToken.None);

        // Assert
        Assert.Equal(PrinterRecoveryOutcome.RestartFailed, result.Outcome);
        Assert.Equal(PrinterRecoveryCommandType.AttemptPrinterRecovery, result.Type);
        Assert.Equal("RestartSpooler", result.Action);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Null(result.SpoolerState.ErrorMessage);
        Assert.Equal(PrinterHealthState.Offline.ToString(), result.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.WindowsQueueFault.ToString(), result.IssueKind);
        Assert.Contains("recheck deadline", result.Message);

        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Once);
        _leaseMock.Verify(l => l.Dispose(), Times.Once);
    }

    [Fact]
    public async Task AttemptRepairAsync_WhenRecheckExpiresWithPhysicalFault_ReturnsManualInterventionRequired()
    {
        // Arrange
        var fastSettings = new PrinterRecoverySettings
        {
            ServiceName = "Spooler",
            PrinterName = "EPSON L5290 Series",
            SpoolerTransitionTimeoutSeconds = 30,
            HealthRecheckTimeoutSeconds = 0,
            HealthRecheckIntervalSeconds = 0
        };

        var initialDiagnostic = new PrinterHealthDiagnostic
        {
            PrinterState = PrinterHealthState.Offline,
            IssueKind = PrinterHealthIssueKind.WindowsQueueFault,
            WinSpoolDescription = "Printer offline"
        };

        var physicalFaultDiagnostic = new PrinterHealthDiagnostic
        {
            PrinterState = PrinterHealthState.Fault,
            IssueKind = PrinterHealthIssueKind.PhysicalFault,
            WinSpoolDescription = "Paper Jam"
        };

        _healthMonitorMock
            .SetupSequence(h => h.GetDiagnostic("EPSON L5290 Series"))
            .Returns(initialDiagnostic) // pre-restart check
            .Returns(physicalFaultDiagnostic); // post-restart recheck

        _spoolerControllerMock
            .Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot
            {
                IsRunning = true,
                Status = "Running"
            });

        _spoolerControllerMock
            .Setup(s => s.RestartAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerRestartResult
            {
                Success = true,
                FinalStatus = "Running"
            });

        var service = CreateService(fastSettings);

        // Act
        var result = await service.AttemptRepairAsync(CancellationToken.None);

        // Assert
        Assert.Equal(PrinterRecoveryOutcome.ManualInterventionRequired, result.Outcome);
        Assert.Equal(PrinterRecoveryCommandType.AttemptPrinterRecovery, result.Type);
        Assert.Null(result.Action);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Null(result.SpoolerState.ErrorMessage);
        Assert.Equal(PrinterHealthState.Fault.ToString(), result.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.PhysicalFault.ToString(), result.IssueKind);
        Assert.Contains("physical printer fault detected", result.Message);
        Assert.Contains("Manual intervention required", result.Message);

        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Once);
        _leaseMock.Verify(l => l.Dispose(), Times.Once);
    }

    [Fact]
    public async Task GetStatusAsync_WhenHealthy_ReturnsHealthySnapshotWithoutRestart()
    {
        // Arrange
        _healthMonitorMock
            .Setup(h => h.GetDiagnostic("EPSON L5290 Series"))
            .Returns(new PrinterHealthDiagnostic
            {
                PrinterState = PrinterHealthState.Healthy,
                IssueKind = PrinterHealthIssueKind.None,
                WinSpoolDescription = "Ready"
            });

        _spoolerControllerMock
            .Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot
            {
                IsRunning = true,
                Status = "Running"
            });

        var service = CreateService();

        // Act
        var result = await service.GetStatusAsync(CancellationToken.None);

        // Assert
        Assert.Equal(PrinterRecoveryOutcome.Healthy, result.Outcome);
        Assert.Equal(PrinterRecoveryCommandType.GetPrinterRecoveryStatus, result.Type);
        Assert.Null(result.Action);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Null(result.SpoolerState.ErrorMessage);
        Assert.Equal(PrinterHealthState.Healthy.ToString(), result.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.None.ToString(), result.IssueKind);
        Assert.False(string.IsNullOrWhiteSpace(result.Message));

        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Never);
        _coordinatorMock.Verify(c => c.TryAcquireRecovery(out It.Ref<IDisposable?>.IsAny), Times.Never);
    }

    [Fact]
    public async Task GetStatusAsync_WhenPhysicalFault_ReturnsManualInterventionRequiredWithoutRestart()
    {
        // Arrange
        _healthMonitorMock
            .Setup(h => h.GetDiagnostic("EPSON L5290 Series"))
            .Returns(new PrinterHealthDiagnostic
            {
                PrinterState = PrinterHealthState.Fault,
                IssueKind = PrinterHealthIssueKind.PhysicalFault,
                WinSpoolDescription = "Paper Jam"
            });

        _spoolerControllerMock
            .Setup(s => s.GetStatusAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SpoolerStatusSnapshot
            {
                IsRunning = true,
                Status = "Running"
            });

        var service = CreateService();

        // Act
        var result = await service.GetStatusAsync(CancellationToken.None);

        // Assert
        Assert.Equal(PrinterRecoveryOutcome.ManualInterventionRequired, result.Outcome);
        Assert.Equal(PrinterRecoveryCommandType.GetPrinterRecoveryStatus, result.Type);
        Assert.Null(result.Action);
        Assert.NotNull(result.SpoolerState);
        Assert.True(result.SpoolerState.IsRunning);
        Assert.Equal("Running", result.SpoolerState.Status);
        Assert.Null(result.SpoolerState.ErrorMessage);
        Assert.Equal(PrinterHealthState.Fault.ToString(), result.PrinterState);
        Assert.Equal(PrinterHealthIssueKind.PhysicalFault.ToString(), result.IssueKind);
        Assert.Contains("Paper Jam", result.Message);

        _spoolerControllerMock.Verify(s => s.RestartAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}

