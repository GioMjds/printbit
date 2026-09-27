using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Infrastructure.Windows.PrinterMonitoring;
using PrintBit.Shared.Configurations;

namespace PrintBit.HardwareService.Services;

public interface IPrinterSupervisorTickSource : IDisposable
{
    ValueTask<bool> WaitForNextTickAsync(CancellationToken cancellationToken);
}

public sealed class PeriodicPrinterSupervisorTickSource(TimeSpan interval) : IPrinterSupervisorTickSource
{
    private readonly PeriodicTimer _timer = new(interval);
    public ValueTask<bool> WaitForNextTickAsync(CancellationToken cancellationToken) =>
        _timer.WaitForNextTickAsync(cancellationToken);
    public void Dispose() => _timer.Dispose();
}

public sealed class SystemClock : ISystemClock
{
    public DateTime UtcNow => DateTime.UtcNow;
}

/// <summary>Serializes policy observations and manual recovery around the shared print/recovery lease.</summary>
public sealed class PrinterSupervisorService : BackgroundService, IPrinterSupervisor
{
    private readonly IPrinterHealthMonitor _monitor;
    private readonly IPrintSpoolerController _spooler;
    private readonly IPrinterOperationCoordinator _coordinator;
    private readonly IPrinterRecoveryService _recovery;
    private readonly IWorkerEventPipeClient _pipe;
    private readonly ISystemClock _clock;
    private readonly ILogger<PrinterSupervisorService> _logger;
    private readonly IPrinterSupervisorTickSource _ticks;
    private readonly PrinterSupervisorStateMachine _machine;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly CancellationTokenSource _shutdown = new();
    private readonly string _printerName;
    private long _sequence;
    private int _attempts;
    private string? _lastAction;
    private PrinterSupervisorSnapshot _snapshot;
    private Task<PrinterRecoveryResult>? _pendingRecovery;

    public PrinterSupervisorService(
        IPrinterHealthMonitor monitor,
        IPrintSpoolerController spooler,
        IPrinterOperationCoordinator coordinator,
        IPrinterRecoveryService recovery,
        IWorkerEventPipeClient pipe,
        IOptions<PrinterRecoverySettings> settings,
        IOptions<HardwareSettings> hardware,
        ISystemClock clock,
        ILogger<PrinterSupervisorService> logger,
        IPrinterSupervisorTickSource? ticks = null)
    {
        _monitor = monitor;
        _spooler = spooler;
        _coordinator = coordinator;
        _recovery = recovery;
        _pipe = pipe;
        _clock = clock;
        _logger = logger;
        _machine = new(settings.Value, clock);
        _ticks = ticks ?? new PeriodicPrinterSupervisorTickSource(TimeSpan.FromSeconds(settings.Value.SupervisorPollIntervalSeconds));
        _printerName = !string.IsNullOrWhiteSpace(settings.Value.PrinterName)
            ? settings.Value.PrinterName : hardware.Value.PrinterName;
        _snapshot = BuildSnapshot(UnknownObservation("Waiting for first health probe."), 0);
    }

    public PrinterSupervisorSnapshot CurrentSnapshot => Volatile.Read(ref _snapshot);
    public bool IsReady => CurrentSnapshot.Status == PrinterSupervisorPublicStatus.Ready;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (await _ticks.WaitForNextTickAsync(stoppingToken))
            {
                await _gate.WaitAsync(stoppingToken);
                try
                {
                    var observation = await ProbeAsync(stoppingToken);
                    var transition = _machine.Observe(observation);
                    _attempts = transition.AttemptsInWindow;
                    // Every tick publishes; a recovery transition reaches Node before service I/O begins.
                    await PublishAsync(observation, stoppingToken);
                    if (transition.Decision != SupervisorDecision.None)
                    {
                        var repair = InvokeRepairAsync(transition.Decision, stoppingToken);
                        if (repair.IsCompleted)
                            await ApplyRecoveryResultAsync(await repair, stoppingToken);
                        else
                            _pendingRecovery = CompletePendingRecoveryAsync(repair, stoppingToken);
                    }
                }
                finally { _gate.Release(); }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            _shutdown.Cancel();
            if (_pendingRecovery is not null)
            {
                try { await _pendingRecovery; }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
            }
        }
    }

    public async Task<PrinterRecoveryResult> AttemptManualRecoveryAsync(CancellationToken cancellationToken = default)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _shutdown.Token);
        cancellationToken = linked.Token;
        Task<PrinterRecoveryResult> pending;
        if (!await _gate.WaitAsync(0, cancellationToken)) return BusyResult();
        try
        {
            if (_coordinator.ActiveOperation != PrinterOperationKind.None) return BusyResult();
            var observation = await ProbeAsync(cancellationToken);
            if (observation.Printer.IssueKind == PrinterHealthIssueKind.PhysicalFault)
            {
                _attempts = _machine.Observe(observation).AttemptsInWindow;
                await PublishAsync(observation, cancellationToken);
                return ManualInterventionResult(observation);
            }

            // Observe allows a cleared physical fault to reveal a still-latched circuit.
            if (_machine.IsCircuitOpen) _machine.Observe(observation);
            if (!_machine.BeginManualRecovery(_coordinator.ActiveOperation)) return BusyResult();
            await PublishAsync(observation, cancellationToken);
            // The diagnostic-derived overload revalidates the action while holding the recovery lease.
            var repair = InvokeRepairAsync(null, cancellationToken);
            if (repair.IsCompleted)
                return await ApplyRecoveryResultAsync(await repair, cancellationToken);
            pending = _pendingRecovery = CompletePendingRecoveryAsync(repair, cancellationToken);
        }
        finally { _gate.Release(); }
        return await pending;
    }

    private async Task<PrinterRecoveryResult> InvokeRepairAsync(SupervisorDecision? decision, CancellationToken token)
    {
        try
        {
            return decision.HasValue
                ? await _recovery.AttemptRepairAsync(decision.Value, token)
                : await _recovery.AttemptRepairAsync(token);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Printer supervisor recovery failed.");
            return new PrinterRecoveryResult
            {
                Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
                Outcome = PrinterRecoveryOutcome.RestartFailed,
                Action = decision?.ToString(),
                Message = "Printer recovery failed. Check Worker logs.",
                StartedAt = _clock.UtcNow,
                CompletedAt = _clock.UtcNow
            };
        }
    }

    private async Task<PrinterRecoveryResult> CompletePendingRecoveryAsync(Task<PrinterRecoveryResult> repair, CancellationToken token)
    {
        try
        {
            var result = await repair;
            await _gate.WaitAsync(token);
            try { return await ApplyRecoveryResultAsync(result, token); }
            finally { _gate.Release(); }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            await _gate.WaitAsync(CancellationToken.None);
            try { _machine.DeferRecovery(); }
            finally { _gate.Release(); }
            throw;
        }
    }

    private async Task<PrinterRecoveryResult> ApplyRecoveryResultAsync(PrinterRecoveryResult result, CancellationToken token)
    {
        if (result.Action is not null) _lastAction = result.Action;
        var transition = result.Outcome switch
        {
            PrinterRecoveryOutcome.Healthy or PrinterRecoveryOutcome.Recovered => _machine.CompleteRecovery(true),
            PrinterRecoveryOutcome.WorkerBusy or PrinterRecoveryOutcome.ManualInterventionRequired => _machine.DeferRecovery(),
            _ => _machine.CompleteRecovery(false)
        };
        _attempts = transition.AttemptsInWindow;
        // Probe current evidence for the snapshot without counting an extra healthy policy sample.
        var observation = await ProbeAsync(token);
        if (observation.Printer.IssueKind == PrinterHealthIssueKind.PhysicalFault)
            _machine.Observe(observation);
        await PublishAsync(observation, token);
        return result;
    }

    private async Task<SupervisorObservation> ProbeAsync(CancellationToken token)
    {
        try
        {
            var spooler = await _spooler.GetStatusAsync(token);
            return new(spooler, _monitor.GetDiagnostic(_printerName), _coordinator.ActiveOperation);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Printer supervisor health probe failed.");
            return UnknownObservation("Health probe unavailable. Check Worker logs.");
        }
    }

    private SupervisorObservation UnknownObservation(string message) => new(
        new SpoolerStatusSnapshot { Status = "Unknown", ErrorMessage = message },
        new PrinterHealthDiagnostic
        {
            PrinterState = PrinterHealthState.Unavailable,
            IssueKind = PrinterHealthIssueKind.Unknown,
            WinSpoolDescription = message
        },
        _coordinator.ActiveOperation);

    private async Task PublishAsync(SupervisorObservation observation, CancellationToken token)
    {
        var snapshot = BuildSnapshot(observation, Interlocked.Increment(ref _sequence));
        Volatile.Write(ref _snapshot, snapshot);
        try
        {
            if (!await _pipe.PublishSupervisorAsync(snapshot, token))
                _logger.LogWarning("Printer supervisor snapshot {Sequence} was not delivered to Node.", snapshot.Sequence);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Printer supervisor snapshot {Sequence} could not be published.", snapshot.Sequence);
        }
    }

    private PrinterSupervisorSnapshot BuildSnapshot(SupervisorObservation observation, long sequence) => new(
        WorkerPrintEventType.PrinterSupervisorSnapshot,
        sequence,
        _clock.UtcNow,
        _machine.State switch
        {
            PrinterSupervisorState.Ready => PrinterSupervisorPublicStatus.Ready,
            PrinterSupervisorState.Busy => PrinterSupervisorPublicStatus.Busy,
            PrinterSupervisorState.Maintenance or PrinterSupervisorState.CircuitOpen => PrinterSupervisorPublicStatus.Maintenance,
            _ => PrinterSupervisorPublicStatus.Recovering
        },
        new(observation.Spooler.Status, string.IsNullOrEmpty(observation.Spooler.ErrorMessage)),
        new(observation.ActiveOperation == PrinterOperationKind.Print ? "busy"
            : observation.Printer.IsHealthy && observation.Spooler.IsRunning ? "idle" : "unhealthy", null),
        new(_printerName, observation.Printer.PortName,
            observation.Printer.PrinterState is PrinterHealthState.Healthy or PrinterHealthState.Fault,
            observation.Printer.IssueKind.ToString(),
            !string.IsNullOrWhiteSpace(observation.Printer.WinSpoolDescription)
                ? observation.Printer.WinSpoolDescription : observation.Printer.WmiDescription),
        new(_attempts, _machine.IsCircuitOpen, _lastAction));

    private PrinterRecoveryResult BusyResult() => new()
    {
        Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
        Outcome = PrinterRecoveryOutcome.WorkerBusy,
        Message = "Printer recovery is unavailable while an operation is active.",
        StartedAt = _clock.UtcNow,
        CompletedAt = _clock.UtcNow
    };

    private PrinterRecoveryResult ManualInterventionResult(SupervisorObservation observation) => new()
    {
        Type = PrinterRecoveryCommandType.AttemptPrinterRecovery,
        Outcome = PrinterRecoveryOutcome.ManualInterventionRequired,
        SpoolerState = new() { IsRunning = observation.Spooler.IsRunning, Status = observation.Spooler.Status, ErrorMessage = observation.Spooler.ErrorMessage },
        PrinterState = observation.Printer.PrinterState.ToString(),
        IssueKind = observation.Printer.IssueKind.ToString(),
        Message = "Physical printer fault detected. Manual intervention required.",
        StartedAt = _clock.UtcNow,
        CompletedAt = _clock.UtcNow
    };

    public override void Dispose()
    {
        _shutdown.Cancel();
        base.Dispose();
        _ticks.Dispose();
    }
}
