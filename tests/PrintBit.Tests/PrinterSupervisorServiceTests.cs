using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.HardwareService.Services;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Infrastructure.Windows.PrinterMonitoring;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public class PrinterSupervisorServiceTests
{
    [Fact]
    public async Task IncompleteRepairKeepsPublishingHeartbeatsWithoutDuplicateRepair()
    {
        using var f = new Fixture();
        f.Fault(false);
        f.BlockRepair = new(TaskCreationOptions.RunContinuationsAsynchronously);
        await f.Start();
        await f.Tick();
        await f.Tick();
        await f.Tick();
        await f.Tick();
        Assert.Equal(new long[] { 1, 2, 3, 4 }, f.Snapshots.Select(s => s.Sequence));
        Assert.All(f.Snapshots.Skip(1), s => Assert.Equal(PrinterSupervisorPublicStatus.Recovering, s.Status));
        Assert.Equal(1, f.Starts);
        Assert.Equal(PrinterOperationKind.Recovery, f.Coordinator.ActiveOperation);
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.OnPublish = s => { if (s.Sequence == 5) completed.TrySetResult(); };
        f.BlockRepair.SetResult();
        await completed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(5, f.Service.CurrentSnapshot.Sequence);
        Assert.False(f.Service.IsReady);
        await f.Tick();
        Assert.True(f.Service.IsReady);
        Assert.Equal(1, f.Starts);
        await f.Stop();
    }

    [Fact]
    public async Task HeartbeatsRequireTwoHealthySamplesAndIncreaseSequence()
    {
        using var f = new Fixture();
        await f.Start();
        await f.Tick();
        Assert.False(f.Service.IsReady);
        await f.Tick();
        Assert.True(f.Service.IsReady);
        await f.Tick();
        Assert.Equal(new long[] { 1, 2, 3 }, f.Snapshots.Select(s => s.Sequence));
        Assert.Equal("USB007", f.Service.CurrentSnapshot.Printer.PortName);
        Assert.Equal(f.Clock.UtcNow, f.Service.CurrentSnapshot.TimestampUtc);
        await f.Stop();
    }

    [Theory]
    [InlineData(false, "StartSpooler")]
    [InlineData(true, "RestartSpooler")]
    public async Task SecondUnhealthySampleRepairsAndPublishesTransitionBeforeAction(bool running, string action)
    {
        using var f = new Fixture();
        f.Fault(running);
        f.OnRepair = () => Assert.Equal(PrinterSupervisorPublicStatus.Recovering, f.Snapshots.Last().Status);
        await f.Start();
        await f.Tick();
        Assert.Equal(0, f.Starts + f.Restarts);
        await f.Tick();
        Assert.Equal(running ? 0 : 1, f.Starts);
        Assert.Equal(running ? 1 : 0, f.Restarts);
        Assert.Equal(action, f.Service.CurrentSnapshot.Recovery.LastAction);
        Assert.False(f.Service.IsReady);
        await f.Tick();
        Assert.True(f.Service.IsReady);
        Assert.Equal(Enumerable.Range(1, f.Snapshots.Count).Select(i => (long)i), f.Snapshots.Select(s => s.Sequence));
        await f.Stop();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PhysicalFaultNeverStartsOrRestarts(bool running)
    {
        using var f = new Fixture();
        f.Fault(running, PrinterHealthIssueKind.PhysicalFault);
        await f.Start();
        await f.Tick();
        await f.Tick();
        Assert.Equal(PrinterSupervisorPublicStatus.Maintenance, f.Service.CurrentSnapshot.Status);
        Assert.Equal(0, f.Starts);
        Assert.Equal(0, f.Restarts);
        var result = await f.Service.AttemptManualRecoveryAsync();
        Assert.Equal(PrinterRecoveryOutcome.ManualInterventionRequired, result.Outcome);
        Assert.Equal(0, f.Starts);
        Assert.Equal(0, f.Restarts);
        await f.Stop();
    }

    [Theory]
    [InlineData("Running", null, PrinterHealthIssueKind.Unknown)]
    [InlineData("Running", "query failed", PrinterHealthIssueKind.WindowsQueueFault)]
    [InlineData("Unknown", "access denied", PrinterHealthIssueKind.WindowsQueueFault)]
    public async Task UnconfirmedWindowsFaultNeverRepairs(string status, string? error, PrinterHealthIssueKind issue)
    {
        using var f = new Fixture();
        f.Fault(status == "Running", issue);
        f.Spooler = new() { IsRunning = status == "Running", Status = status, ErrorMessage = error };
        await f.Start();
        await f.Tick();
        await f.Tick();
        Assert.Equal(PrinterSupervisorPublicStatus.Maintenance, f.Service.CurrentSnapshot.Status);
        Assert.Equal(0, f.Starts + f.Restarts);
        Assert.Equal(0, f.Service.CurrentSnapshot.Recovery.AttemptsInWindow);
        await f.Stop();
    }

    [Fact]
    public async Task PrintingDefersRecoveryUntilLeaseReleased()
    {
        using var f = new Fixture();
        f.Fault(false);
        var lease = await f.Coordinator.AcquirePrintAsync(CancellationToken.None);
        await f.Start();
        await f.Tick();
        await f.Tick();
        Assert.Equal(PrinterSupervisorPublicStatus.Busy, f.Service.CurrentSnapshot.Status);
        Assert.Equal(0, f.Starts + f.Restarts);
        lease.Dispose();
        await f.Tick();
        Assert.Equal(1, f.Starts);
        await f.Stop();
    }

    [Fact]
    public async Task LeaseRaceDoesNotConsumeCircuitAttemptAndRetriesOnLaterObservation()
    {
        using var f = new Fixture();
        f.Fault(false);
        IDisposable? print = null;
        f.OnPublish = s =>
        {
            if (s.Status == PrinterSupervisorPublicStatus.Recovering && print is null)
                print = f.Coordinator.AcquirePrintAsync(CancellationToken.None).GetAwaiter().GetResult();
        };
        await f.Start();
        await f.Tick();
        await f.Tick();
        Assert.Equal(0, f.Starts);
        Assert.Equal(0, f.Service.CurrentSnapshot.Recovery.AttemptsInWindow);
        f.OnPublish = null;
        print!.Dispose();
        await f.Tick();
        await f.Tick();
        Assert.Equal(1, f.Starts);
        await f.Stop();
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ThirdFailureOpensCircuitAndOnlyManualHalfOpenCanRecover(bool manualSuccess)
    {
        using var f = new Fixture();
        f.Fault(false);
        f.RepairSucceeds = false;
        await f.Start();
        for (var i = 0; i < 6; i++) await f.Tick();
        Assert.Equal(3, f.Starts);
        Assert.True(f.Service.CurrentSnapshot.Recovery.CircuitOpen);
        Assert.Equal(3, f.Service.CurrentSnapshot.Recovery.AttemptsInWindow);
        Assert.Equal(PrinterSupervisorPublicStatus.Maintenance, f.Service.CurrentSnapshot.Status);
        await f.Tick();
        Assert.Equal(3, f.Starts);
        f.RepairSucceeds = manualSuccess;
        var result = await f.Service.AttemptManualRecoveryAsync();
        Assert.Equal(manualSuccess ? PrinterRecoveryOutcome.Recovered : PrinterRecoveryOutcome.RestartFailed, result.Outcome);
        Assert.Equal(4, f.Starts);
        Assert.Equal(!manualSuccess, f.Service.CurrentSnapshot.Recovery.CircuitOpen);
        Assert.False(f.Service.IsReady);
        await f.Tick();
        Assert.Equal(manualSuccess, f.Service.IsReady);
        await f.Stop();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PipeFailureWarnsAndLaterTicksContinue(bool throws)
    {
        using var f = new Fixture();
        f.PipeFails = true;
        f.PipeThrows = throws;
        await f.Start();
        await f.Tick();
        f.PipeFails = false;
        f.PipeThrows = false;
        await f.Tick();
        Assert.True(f.Service.IsReady);
        Assert.Equal(2, f.Service.CurrentSnapshot.Sequence);
        Assert.Contains(LogLevel.Warning, f.Log.Levels);
        await f.Stop();
    }

    private sealed class Fixture : IDisposable
    {
        public readonly PrintOperationCoordinator Coordinator = new();
        public readonly FakeClock Clock = new();
        public readonly ManualTicks Ticks = new();
        public readonly TestLogger Log = new();
        public readonly List<PrinterSupervisorSnapshot> Snapshots = [];
        public readonly PrinterSupervisorService Service;
        public SpoolerStatusSnapshot Spooler = new() { IsRunning = true, Status = "Running" };
        public PrinterHealthDiagnostic Diagnostic = Healthy();
        public int Starts, Restarts;
        public bool RepairSucceeds = true, PipeFails, PipeThrows;
        public TaskCompletionSource? BlockRepair;
        public Action? OnRepair;
        public Action<PrinterSupervisorSnapshot>? OnPublish;

        public Fixture()
        {
            var monitor = new Mock<IPrinterHealthMonitor>(MockBehavior.Strict);
            monitor.Setup(x => x.GetDiagnostic("Printer")).Returns(() => Diagnostic);
            var spooler = new Mock<IPrintSpoolerController>(MockBehavior.Strict);
            spooler.Setup(x => x.GetStatusAsync(It.IsAny<CancellationToken>())).ReturnsAsync(() => Spooler);
            spooler.Setup(x => x.StartAsync(It.IsAny<CancellationToken>())).Returns((CancellationToken token) => Repair(true, token));
            spooler.Setup(x => x.RestartAsync(It.IsAny<CancellationToken>())).Returns((CancellationToken token) => Repair(false, token));
            var pipe = new Mock<IWorkerEventPipeClient>(MockBehavior.Strict);
            pipe.Setup(x => x.PublishSupervisorAsync(It.IsAny<PrinterSupervisorSnapshot>(), It.IsAny<CancellationToken>()))
                .Returns((PrinterSupervisorSnapshot snapshot, CancellationToken _) =>
                {
                    Snapshots.Add(snapshot);
                    OnPublish?.Invoke(snapshot);
                    if (PipeThrows) throw new IOException("pipe unavailable");
                    return Task.FromResult(!PipeFails);
                });
            var settings = Options.Create(new PrinterRecoverySettings { SupervisorEnabled = true });
            var hardware = Options.Create(new HardwareSettings { PrinterName = "Printer" });
            var recovery = new PrinterRecoveryService(monitor.Object, spooler.Object, Coordinator, settings, hardware);
            Service = new PrinterSupervisorService(monitor.Object, spooler.Object, Coordinator, recovery,
                pipe.Object, settings, hardware, Clock, Log, Ticks);
        }

        public void Fault(bool running, PrinterHealthIssueKind issue = PrinterHealthIssueKind.WindowsQueueFault)
        {
            Spooler = new() { IsRunning = running, Status = running ? "Running" : "Stopped" };
            Diagnostic = new() { PrinterState = PrinterHealthState.Fault, IssueKind = issue, PortName = "USB007" };
        }

        private async Task<SpoolerRestartResult> Repair(bool start, CancellationToken token)
        {
            Assert.Equal(PrinterOperationKind.Recovery, Coordinator.ActiveOperation);
            if (start) Starts++; else Restarts++;
            OnRepair?.Invoke();
            if (BlockRepair is not null) await BlockRepair.Task.WaitAsync(token);
            if (RepairSucceeds)
            {
                Spooler = new() { IsRunning = true, Status = "Running" };
                Diagnostic = Healthy();
            }
            return new() { Success = RepairSucceeds, FinalStatus = Spooler.Status, Error = RepairSucceeds ? null : "service failure" };
        }

        public Task Start() => Service.StartAsync(CancellationToken.None);
        public Task Tick() => Ticks.TickAsync();
        public Task Stop() => Service.StopAsync(CancellationToken.None);
        public void Dispose() { Service.Dispose(); Coordinator.Dispose(); }
        private static PrinterHealthDiagnostic Healthy() => new() { PrinterState = PrinterHealthState.Healthy, IssueKind = PrinterHealthIssueKind.None, PortName = "USB007" };
    }

    private sealed class FakeClock : ISystemClock
    {
        public DateTime UtcNow => new(2026, 9, 10, 0, 0, 0, DateTimeKind.Utc);
    }

    // The next wait acknowledges completion of the preceding tick; no polling or sleeps.
    private sealed class ManualTicks : IPrinterSupervisorTickSource
    {
        private readonly Channel<TaskCompletionSource> _ticks = Channel.CreateUnbounded<TaskCompletionSource>();
        private TaskCompletionSource? _previous;
        public async ValueTask<bool> WaitForNextTickAsync(CancellationToken token)
        {
            _previous?.TrySetResult();
            _previous = await _ticks.Reader.ReadAsync(token);
            return true;
        }
        public async Task TickAsync()
        {
            var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await _ticks.Writer.WriteAsync(completed);
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        }
        public void Dispose() => _ticks.Writer.TryComplete();
    }

    private sealed class TestLogger : ILogger<PrinterSupervisorService>
    {
        public List<LogLevel> Levels { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter) => Levels.Add(level);
    }
}
