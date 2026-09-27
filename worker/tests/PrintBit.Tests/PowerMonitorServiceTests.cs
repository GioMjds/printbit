using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.HardwareService.Services;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Infrastructure.Windows.PowerMonitoring;
using PrintBit.Shared.Configurations;
using PrintBit.Shared.Power;
using PrintBit.Shared.Printing;
using Xunit;

namespace PrintBit.Tests;

public class PowerMonitorServiceTests
{
    private class FakePowerStatusProvider : IPowerStatusProvider
    {
        public bool ShouldSucceed { get; set; } = true;
        public PowerStatusSnapshot CurrentSnapshot { get; set; } = new(
            AcLineStatus.Online,
            IsCharging: true,
            BatteryPercentage: 90,
            IsBatteryLow: false,
            IsBatteryCritical: false);
        public string? ErrorMessage { get; set; }

        public bool TryGetStatus(out PowerStatusSnapshot snapshot, out string? error)
        {
            if (!ShouldSucceed)
            {
                snapshot = new PowerStatusSnapshot(AcLineStatus.Unknown, null, null, null, null);
                error = ErrorMessage ?? "Hardware error querying power status";
                return false;
            }

            snapshot = CurrentSnapshot;
            error = null;
            return true;
        }
    }

    [Fact]
    public async Task InitialPoll_SendsInitialPowerStatusSnapshot_AndInitializesGate()
    {
        var provider = new FakePowerStatusProvider
        {
            CurrentSnapshot = new PowerStatusSnapshot(AcLineStatus.Online, true, 95, false, false)
        };
        var gate = new PowerSafetyGate();
        var healthMonitorMock = new Mock<IPrinterHealthMonitor>();
        int spoolStatus = 0;
        string spoolDesc = "OK";
        healthMonitorMock
            .Setup(h => h.IsHealthy(It.IsAny<string>(), out spoolStatus, out spoolDesc))
            .Returns(true);

        var pipeMock = new Mock<IWorkerEventPipeClient>();
        var sentEvents = new List<WorkerPrintEvent>();
        pipeMock
            .Setup(p => p.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => sentEvents.Add(evt))
            .ReturnsAsync(true);

        var hardwareOptions = Options.Create(new HardwareSettings { PrinterName = "Test Printer" });
        var powerOptions = Options.Create(new PowerSettings
        {
            PollIntervalSeconds = 2,
            StableRecoverySeconds = 10,
            HeartbeatIntervalSeconds = 10
        });

        var service = new PowerMonitorService(
            NullLogger<PowerMonitorService>.Instance,
            provider,
            gate,
            healthMonitorMock.Object,
            pipeMock.Object,
            hardwareOptions,
            powerOptions);

        var t0 = new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);
        await service.PollOnceAsync(t0);

        Assert.Single(sentEvents);
        var initialEvt = sentEvents[0];
        Assert.Equal(WorkerPrintEventType.PowerStatusSnapshot, initialEvt.Type);
        Assert.Equal(PowerOperationalState.Recovering, initialEvt.OperationalState);
        Assert.False(initialEvt.AcceptingTransactions);
        Assert.Equal(1L, initialEvt.PowerSequence);
        Assert.False(string.IsNullOrWhiteSpace(initialEvt.PowerSourceInstanceId));
        Assert.Equal(AcLineStatus.Online, initialEvt.PowerStatus?.AcLineStatus);

        // Gate should be closed during recovery
        Assert.False(gate.IsDispatchAllowed);
        Assert.Equal(PowerOperationalState.Recovering, gate.CurrentState);
    }

    [Fact]
    public async Task AcLoss_ImmediatelyTransitionsToEmergency_ClosesGate_AndEmitsPowerStatusChanged()
    {
        var provider = new FakePowerStatusProvider
        {
            CurrentSnapshot = new PowerStatusSnapshot(AcLineStatus.Online, true, 90, false, false)
        };
        var gate = new PowerSafetyGate(PowerOperationalState.Operational);
        var healthMonitorMock = new Mock<IPrinterHealthMonitor>();
        int spoolStatus = 0;
        string spoolDesc = "OK";
        healthMonitorMock
            .Setup(h => h.IsHealthy(It.IsAny<string>(), out spoolStatus, out spoolDesc))
            .Returns(true);

        var pipeMock = new Mock<IWorkerEventPipeClient>();
        var sentEvents = new List<WorkerPrintEvent>();
        pipeMock
            .Setup(p => p.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => sentEvents.Add(evt))
            .ReturnsAsync(true);

        var stateMachine = new PowerSafetyStateMachine(TimeSpan.FromSeconds(10), PowerOperationalState.Operational);
        var service = new PowerMonitorService(
            NullLogger<PowerMonitorService>.Instance,
            provider,
            gate,
            healthMonitorMock.Object,
            pipeMock.Object,
            Options.Create(new HardwareSettings { PrinterName = "Test Printer" }),
            Options.Create(new PowerSettings()),
            stateMachine);

        var t0 = new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);
        // Initial poll in operational
        await service.PollOnceAsync(t0);
        sentEvents.Clear();

        // AC loss
        provider.CurrentSnapshot = new PowerStatusSnapshot(AcLineStatus.Offline, false, 89, false, false);
        await service.PollOnceAsync(t0.AddSeconds(2));

        Assert.Single(sentEvents);
        var changedEvt = sentEvents[0];
        Assert.Equal(WorkerPrintEventType.PowerStatusChanged, changedEvt.Type);
        Assert.Equal(PowerOperationalState.PowerEmergency, changedEvt.OperationalState);
        Assert.False(changedEvt.AcceptingTransactions);
        Assert.Equal(AcLineStatus.Offline, changedEvt.PowerStatus?.AcLineStatus);
        Assert.False(gate.IsDispatchAllowed);
        Assert.Equal(PowerOperationalState.PowerEmergency, gate.CurrentState);
    }

    [Fact]
    public async Task ProviderFailure_ImmediatelyEntersEmergency_ClosesGate_AndEmitsPowerStatusChanged()
    {
        var provider = new FakePowerStatusProvider
        {
            CurrentSnapshot = new PowerStatusSnapshot(AcLineStatus.Online, true, 90, false, false)
        };
        var gate = new PowerSafetyGate(PowerOperationalState.Operational);
        var healthMonitorMock = new Mock<IPrinterHealthMonitor>();
        int spoolStatus = 0;
        string spoolDesc = "OK";
        healthMonitorMock
            .Setup(h => h.IsHealthy(It.IsAny<string>(), out spoolStatus, out spoolDesc))
            .Returns(true);

        var pipeMock = new Mock<IWorkerEventPipeClient>();
        var sentEvents = new List<WorkerPrintEvent>();
        pipeMock
            .Setup(p => p.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => sentEvents.Add(evt))
            .ReturnsAsync(true);

        var stateMachine = new PowerSafetyStateMachine(TimeSpan.FromSeconds(10), PowerOperationalState.Operational);
        var service = new PowerMonitorService(
            NullLogger<PowerMonitorService>.Instance,
            provider,
            gate,
            healthMonitorMock.Object,
            pipeMock.Object,
            Options.Create(new HardwareSettings { PrinterName = "Test Printer" }),
            Options.Create(new PowerSettings()),
            stateMachine);

        var t0 = new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);
        await service.PollOnceAsync(t0);
        sentEvents.Clear();

        // Native API failure
        provider.ShouldSucceed = false;
        provider.ErrorMessage = "kernel32!GetSystemPowerStatus failed with error 5";
        await service.PollOnceAsync(t0.AddSeconds(2));

        Assert.Single(sentEvents);
        var emergencyEvt = sentEvents[0];
        Assert.Equal(WorkerPrintEventType.PowerStatusChanged, emergencyEvt.Type);
        Assert.Equal(PowerOperationalState.PowerEmergency, emergencyEvt.OperationalState);
        Assert.False(emergencyEvt.AcceptingTransactions);
        Assert.Equal(AcLineStatus.Unknown, emergencyEvt.PowerStatus?.AcLineStatus);
        Assert.False(gate.IsDispatchAllowed);
        Assert.Equal(PowerOperationalState.PowerEmergency, gate.CurrentState);
    }

    [Fact]
    public async Task RetryingUnsentEvent_WhenPipeSendFails_RetainsAndRetriesOnNextPoll()
    {
        var provider = new FakePowerStatusProvider
        {
            CurrentSnapshot = new PowerStatusSnapshot(AcLineStatus.Offline, false, 80, false, false)
        };
        var gate = new PowerSafetyGate();
        var healthMonitorMock = new Mock<IPrinterHealthMonitor>();
        var pipeMock = new Mock<IWorkerEventPipeClient>();

        // Fail first send, succeed second
        bool shouldSucceed = false;
        var sentEvents = new List<WorkerPrintEvent>();
        pipeMock
            .Setup(p => p.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Returns<WorkerPrintEvent, CancellationToken>((evt, _) =>
            {
                if (shouldSucceed)
                {
                    sentEvents.Add(evt);
                    return Task.FromResult(true);
                }
                return Task.FromResult(false);
            });

        var service = new PowerMonitorService(
            NullLogger<PowerMonitorService>.Instance,
            provider,
            gate,
            healthMonitorMock.Object,
            pipeMock.Object,
            Options.Create(new HardwareSettings()),
            Options.Create(new PowerSettings()));

        var t0 = new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

        // First poll: send fails
        await service.PollOnceAsync(t0);
        Assert.Empty(sentEvents);
        Assert.NotNull(service.PendingEvent);
        Assert.Equal(1L, service.PendingEvent.PowerSequence);

        // Second poll: no status changes, but pipe is now healthy
        shouldSucceed = true;
        await service.PollOnceAsync(t0.AddSeconds(2));

        Assert.Single(sentEvents);
        Assert.Equal(1L, sentEvents[0].PowerSequence);
        Assert.Null(service.PendingEvent);
    }

    [Fact]
    public async Task TenSecondHeartbeat_SendsPowerStatusSnapshot_WhenStateUnchanged()
    {
        var provider = new FakePowerStatusProvider
        {
            CurrentSnapshot = new PowerStatusSnapshot(AcLineStatus.Online, true, 95, false, false)
        };
        var gate = new PowerSafetyGate(PowerOperationalState.Operational);
        var healthMonitorMock = new Mock<IPrinterHealthMonitor>();
        int spoolStatus = 0;
        string spoolDesc = "OK";
        healthMonitorMock
            .Setup(h => h.IsHealthy(It.IsAny<string>(), out spoolStatus, out spoolDesc))
            .Returns(true);

        var pipeMock = new Mock<IWorkerEventPipeClient>();
        var sentEvents = new List<WorkerPrintEvent>();
        pipeMock
            .Setup(p => p.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => sentEvents.Add(evt))
            .ReturnsAsync(true);

        var stateMachine = new PowerSafetyStateMachine(TimeSpan.FromSeconds(10), PowerOperationalState.Operational);
        var service = new PowerMonitorService(
            NullLogger<PowerMonitorService>.Instance,
            provider,
            gate,
            healthMonitorMock.Object,
            pipeMock.Object,
            Options.Create(new HardwareSettings()),
            Options.Create(new PowerSettings { HeartbeatIntervalSeconds = 10 }),
            stateMachine);

        var t0 = new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

        // t0: Initial snapshot
        await service.PollOnceAsync(t0);
        Assert.Single(sentEvents);
        Assert.Equal(WorkerPrintEventType.PowerStatusSnapshot, sentEvents[0].Type);
        Assert.Equal(1L, sentEvents[0].PowerSequence);

        // t0 + 2s: no change, <10s -> no new event
        await service.PollOnceAsync(t0.AddSeconds(2));
        Assert.Single(sentEvents);

        // t0 + 8s: no change, <10s -> no new event
        await service.PollOnceAsync(t0.AddSeconds(8));
        Assert.Single(sentEvents);

        // t0 + 10s: >= 10s -> heartbeat snapshot emitted
        await service.PollOnceAsync(t0.AddSeconds(10));
        Assert.Equal(2, sentEvents.Count);
        var heartbeatEvt = sentEvents[1];
        Assert.Equal(WorkerPrintEventType.PowerStatusSnapshot, heartbeatEvt.Type);
        Assert.Equal(2L, heartbeatEvt.PowerSequence);
        Assert.Equal(PowerOperationalState.Operational, heartbeatEvt.OperationalState);
    }

    [Fact]
    public async Task Recovery_TransitionsToOperational_OnlyAfterPrinterHealthSucceeds()
    {
        var provider = new FakePowerStatusProvider
        {
            CurrentSnapshot = new PowerStatusSnapshot(AcLineStatus.Online, true, 80, false, false)
        };
        var gate = new PowerSafetyGate(PowerOperationalState.PowerEmergency);
        var healthMonitorMock = new Mock<IPrinterHealthMonitor>();
        bool printerHealthy = false;
        int spoolStatus = 0;
        string spoolDesc = "Error";
        healthMonitorMock
            .Setup(h => h.IsHealthy(It.IsAny<string>(), out spoolStatus, out spoolDesc))
            .Returns(() => printerHealthy);

        var pipeMock = new Mock<IWorkerEventPipeClient>();
        var sentEvents = new List<WorkerPrintEvent>();
        pipeMock
            .Setup(p => p.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback<WorkerPrintEvent, CancellationToken>((evt, _) => sentEvents.Add(evt))
            .ReturnsAsync(true);

        var service = new PowerMonitorService(
            NullLogger<PowerMonitorService>.Instance,
            provider,
            gate,
            healthMonitorMock.Object,
            pipeMock.Object,
            Options.Create(new HardwareSettings { PrinterName = "Epson" }),
            Options.Create(new PowerSettings { StableRecoverySeconds = 10, HeartbeatIntervalSeconds = 10 }));

        var t0 = new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

        // t0: AC online detected, enters Recovering
        await service.PollOnceAsync(t0);
        Assert.Equal(PowerOperationalState.Recovering, gate.CurrentState);
        Assert.False(gate.IsDispatchAllowed);

        // t0 + 10s: 10s elapsed, but printer is UNHEALTHY
        printerHealthy = false;
        await service.PollOnceAsync(t0.AddSeconds(10));
        Assert.Equal(PowerOperationalState.Recovering, gate.CurrentState);
        Assert.False(gate.IsDispatchAllowed);

        // t0 + 12s: printer becomes HEALTHY
        printerHealthy = true;
        spoolDesc = "OK";
        sentEvents.Clear();
        await service.PollOnceAsync(t0.AddSeconds(12));

        Assert.Equal(PowerOperationalState.Operational, gate.CurrentState);
        Assert.True(gate.IsDispatchAllowed);
        Assert.Single(sentEvents);
        Assert.Equal(WorkerPrintEventType.PowerStatusChanged, sentEvents[0].Type);
        Assert.Equal(PowerOperationalState.Operational, sentEvents[0].OperationalState);
        Assert.True(sentEvents[0].AcceptingTransactions);
    }

    [Theory]
    [InlineData(1, 0, 100, AcLineStatus.Online, false, false, false, 100)]
    [InlineData(0, 8, 50, AcLineStatus.Offline, true, false, false, 50)]
    [InlineData(255, 255, 255, AcLineStatus.Unknown, null, null, null, null)]
    [InlineData(1, 10, 20, AcLineStatus.Online, true, true, false, 20)] // 8 (charging) + 2 (low) = 10
    [InlineData(0, 12, 3, AcLineStatus.Offline, true, false, true, 3)]   // 8 (charging) + 4 (critical) = 12
    [InlineData(5, 0, 80, AcLineStatus.Unknown, false, false, false, 80)] // non-standard AC status -> Unknown
    public void NativePowerStatusProvider_MapStatus_MapsCorrectly(
        byte acByte,
        byte flagByte,
        byte percentByte,
        AcLineStatus expectedAc,
        bool? expectedCharging,
        bool? expectedLow,
        bool? expectedCritical,
        int? expectedPercent)
    {
        var raw = new NativePowerStatusProvider.SYSTEM_POWER_STATUS
        {
            ACLineStatus = acByte,
            BatteryFlag = flagByte,
            BatteryLifePercent = percentByte,
            SystemStatusFlag = 0,
            BatteryLifeTime = -1,
            BatteryFullLifeTime = -1
        };

        var snapshot = NativePowerStatusProvider.MapStatus(raw);

        Assert.Equal(expectedAc, snapshot.AcLineStatus);
        Assert.Equal(expectedCharging, snapshot.IsCharging);
        Assert.Equal(expectedLow, snapshot.IsBatteryLow);
        Assert.Equal(expectedCritical, snapshot.IsBatteryCritical);
        Assert.Equal(expectedPercent, snapshot.BatteryPercentage);
    }

    [Fact]
    public async Task PrintQueueWatcher_LeavesFilesUntouched_WhenGateRejectsLease()
    {
        var tempQueue = Path.Combine(Path.GetTempPath(), "printbit_test_queue_" + Guid.NewGuid().ToString("N"));
        var tempFailed = Path.Combine(Path.GetTempPath(), "printbit_test_failed_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempQueue);
        Directory.CreateDirectory(tempFailed);

        try
        {
            var pdfPath = Path.Combine(tempQueue, "TX-1_SCK-1.pdf");
            var jsonPath = Path.Combine(tempQueue, "TX-1_SCK-1.json");
            await File.WriteAllTextAsync(pdfPath, "%PDF-1.4 dummy content");
            await File.WriteAllTextAsync(jsonPath, "{\"copies\":1}");

            var gateMock = new Mock<IPowerSafetyGate>();
            gateMock.Setup(g => g.TryAcquirePrintLease()).Returns((IPowerDispatchLease?)null);

            var orchestratorMock = new Mock<IJobOrchestrator>();
            var watcher = new PrintQueueWatcher(
                NullLogger<PrintQueueWatcher>.Instance,
                orchestratorMock.Object,
                Options.Create(new HardwareSettings
                {
                    PrintQueueDirectory = tempQueue,
                    FailedDirectory = tempFailed
                }),
                gateMock.Object);

            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(1500));
            try
            {
                await watcher.StartAsync(cts.Token);
                await Task.Delay(1200, cts.Token);
            }
            catch (OperationCanceledException) { }
            finally
            {
                await watcher.StopAsync(CancellationToken.None);
            }

            // Orchestrator must NEVER be called
            orchestratorMock.Verify(
                o => o.ProcessJobAsync(It.IsAny<PrintJobRequest>(), It.IsAny<string>(), It.IsAny<CancellationToken>()),
                Times.Never);

            // Files must remain untouched in queue, NOT moved to failed or deleted
            Assert.True(File.Exists(pdfPath), "PDF file should remain in queue directory");
            Assert.True(File.Exists(jsonPath), "JSON file should remain in queue directory");
            Assert.Empty(Directory.GetFiles(tempFailed));
        }
        finally
        {
            if (Directory.Exists(tempQueue)) Directory.Delete(tempQueue, true);
            if (Directory.Exists(tempFailed)) Directory.Delete(tempFailed, true);
        }
    }

    [Fact]
    public async Task PrintQueueWatcher_AcquiresLeaseAndDispatches_WhenGateAllowsLease()
    {
        var tempQueue = Path.Combine(Path.GetTempPath(), "printbit_test_queue_" + Guid.NewGuid().ToString("N"));
        var tempFailed = Path.Combine(Path.GetTempPath(), "printbit_test_failed_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempQueue);
        Directory.CreateDirectory(tempFailed);

        try
        {
            var pdfPath = Path.Combine(tempQueue, "TX-2_SCK-2.pdf");
            var jsonPath = Path.Combine(tempQueue, "TX-2_SCK-2.json");
            await File.WriteAllTextAsync(pdfPath, "%PDF-1.4 dummy content");
            await File.WriteAllTextAsync(jsonPath, "{\"copies\":1}");

            var leaseMock = new Mock<IPowerDispatchLease>();
            bool leaseDisposed = false;
            leaseMock.Setup(l => l.Dispose()).Callback(() => leaseDisposed = true);

            var gateMock = new Mock<IPowerSafetyGate>();
            gateMock.Setup(g => g.TryAcquirePrintLease()).Returns(leaseMock.Object);

            var orchestratorMock = new Mock<IJobOrchestrator>();
            orchestratorMock
                .Setup(o => o.ProcessJobAsync(It.IsAny<PrintJobRequest>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync(new PrintBit.Infrastructure.Services.PrintService.PrintJobResult
                {
                    Success = true,
                    Message = "Success"
                });

            var watcher = new PrintQueueWatcher(
                NullLogger<PrintQueueWatcher>.Instance,
                orchestratorMock.Object,
                Options.Create(new HardwareSettings
                {
                    PrintQueueDirectory = tempQueue,
                    FailedDirectory = tempFailed
                }),
                gateMock.Object);

            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(1500));
            try
            {
                await watcher.StartAsync(cts.Token);
                await Task.Delay(1200, cts.Token);
            }
            catch (OperationCanceledException) { }
            finally
            {
                await watcher.StopAsync(CancellationToken.None);
            }

            // Orchestrator must be called
            orchestratorMock.Verify(
                o => o.ProcessJobAsync(It.IsAny<PrintJobRequest>(), It.IsAny<string>(), It.IsAny<CancellationToken>()),
                Times.Once);

            // Lease must be disposed after execution
            leaseMock.Verify(l => l.Dispose(), Times.Once);
            Assert.True(leaseDisposed);

            // Files must be deleted on success
            Assert.False(File.Exists(pdfPath));
            Assert.False(File.Exists(jsonPath));
        }
        finally
        {
            if (Directory.Exists(tempQueue)) Directory.Delete(tempQueue, true);
            if (Directory.Exists(tempFailed)) Directory.Delete(tempFailed, true);
        }
    }
}
