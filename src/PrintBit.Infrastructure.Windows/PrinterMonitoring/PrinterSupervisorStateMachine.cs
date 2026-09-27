using System;
using System.Collections.Generic;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.Windows.PrinterMonitoring;

public sealed record SupervisorObservation(
    SpoolerStatusSnapshot Spooler,
    PrinterHealthDiagnostic Printer,
    PrinterOperationKind ActiveOperation);

public sealed record SupervisorTransition(
    PrinterSupervisorState State,
    SupervisorDecision Decision,
    bool StateChanged,
    int AttemptsInWindow);

public sealed class PrinterSupervisorStateMachine
{
    private readonly PrinterRecoverySettings _settings;
    private readonly ISystemClock _clock;
    private readonly List<DateTime> _failedRecoveryAttempts = [];
    private bool _circuitOpen;
    private int _healthySamples;
    private bool _manualHalfOpen;
    private bool _recoveryOutstanding;
    private int _unhealthySamples;

    public PrinterSupervisorStateMachine(PrinterRecoverySettings settings, ISystemClock clock)
    {
        _settings = settings ?? throw new ArgumentNullException(nameof(settings));
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));

        if (!_settings.IsValidSupervisorPolicy())
        {
            throw new ArgumentException("Printer supervisor policy settings must be positive.", nameof(settings));
        }
    }

    public PrinterSupervisorState State { get; private set; } = PrinterSupervisorState.Starting;
    public bool IsCircuitOpen => _circuitOpen;

    public SupervisorTransition Observe(SupervisorObservation observation)
    {
        ArgumentNullException.ThrowIfNull(observation);
        ArgumentNullException.ThrowIfNull(observation.Spooler);
        ArgumentNullException.ThrowIfNull(observation.Printer);

        PruneFailedRecoveryAttempts();

        if (observation.Printer.IssueKind == PrinterHealthIssueKind.PhysicalFault)
        {
            _healthySamples = 0;
            _unhealthySamples = 0;
            return TransitionTo(PrinterSupervisorState.Maintenance);
        }

        if (_circuitOpen && !_manualHalfOpen)
        {
            return TransitionTo(PrinterSupervisorState.CircuitOpen);
        }

        if (_recoveryOutstanding)
        {
            return CurrentTransition();
        }

        if (IsHealthy(observation))
        {
            return ObserveHealthy(observation.ActiveOperation);
        }

        return ObserveUnhealthy(observation);
    }

    public SupervisorTransition CompleteRecovery(bool succeeded)
    {
        PruneFailedRecoveryAttempts();

        if (!_recoveryOutstanding)
        {
            return CurrentTransition();
        }

        var wasManualHalfOpen = _manualHalfOpen;
        _manualHalfOpen = false;
        _recoveryOutstanding = false;
        _unhealthySamples = 0;

        if (succeeded)
        {
            if (wasManualHalfOpen)
            {
                _circuitOpen = false;
                _failedRecoveryAttempts.Clear();
            }

            _healthySamples = 1;
            return TransitionTo(PrinterSupervisorState.Starting);
        }

        _healthySamples = 0;

        if (wasManualHalfOpen)
        {
            _circuitOpen = true;
            return TransitionTo(PrinterSupervisorState.CircuitOpen);
        }

        _failedRecoveryAttempts.Add(_clock.UtcNow);
        PruneFailedRecoveryAttempts();

        if (_failedRecoveryAttempts.Count >= _settings.CircuitBreakerFailureLimit)
        {
            _circuitOpen = true;
            return TransitionTo(PrinterSupervisorState.CircuitOpen);
        }

        return TransitionTo(PrinterSupervisorState.Maintenance);
    }

    public bool BeginManualHalfOpen(PrinterOperationKind activeOperation)
    {
        if (!_circuitOpen || State != PrinterSupervisorState.CircuitOpen ||
            _recoveryOutstanding || activeOperation != PrinterOperationKind.None)
        {
            return false;
        }

        State = PrinterSupervisorState.Recovering;
        _healthySamples = 0;
        _manualHalfOpen = true;
        _recoveryOutstanding = true;
        _unhealthySamples = 0;
        return true;
    }

    public bool BeginManualRecovery(PrinterOperationKind activeOperation)
    {
        if (_circuitOpen) return BeginManualHalfOpen(activeOperation);
        if (_recoveryOutstanding || activeOperation != PrinterOperationKind.None) return false;
        State = PrinterSupervisorState.Recovering;
        _healthySamples = 0;
        _recoveryOutstanding = true;
        return true;
    }

    // A lease race or changed diagnostic is a deferral, not a failed repair attempt.
    public SupervisorTransition DeferRecovery()
    {
        _recoveryOutstanding = false;
        _manualHalfOpen = false;
        return TransitionTo(_circuitOpen ? PrinterSupervisorState.CircuitOpen : PrinterSupervisorState.Maintenance);
    }

    private SupervisorTransition ObserveHealthy(PrinterOperationKind activeOperation)
    {
        _unhealthySamples = 0;

        if (activeOperation != PrinterOperationKind.None)
        {
            return TransitionTo(activeOperation == PrinterOperationKind.Print
                ? PrinterSupervisorState.Busy
                : PrinterSupervisorState.Recovering);
        }

        _healthySamples++;
        return _healthySamples >= _settings.HealthySamplesBeforeReady
            ? TransitionTo(PrinterSupervisorState.Ready)
            : CurrentTransition();
    }

    private SupervisorTransition ObserveUnhealthy(SupervisorObservation observation)
    {
        _healthySamples = 0;

        _unhealthySamples++;

        if (observation.ActiveOperation == PrinterOperationKind.Print)
        {
            return TransitionTo(PrinterSupervisorState.Busy);
        }

        if (observation.ActiveOperation == PrinterOperationKind.Recovery)
        {
            return TransitionTo(PrinterSupervisorState.Recovering);
        }

        if (!string.IsNullOrEmpty(observation.Spooler.ErrorMessage) ||
            (observation.Spooler.IsRunning
                ? observation.Printer.IssueKind != PrinterHealthIssueKind.WindowsQueueFault
                : !string.Equals(observation.Spooler.Status, "Stopped", StringComparison.OrdinalIgnoreCase)))
        {
            _unhealthySamples = 0;
            return TransitionTo(PrinterSupervisorState.Maintenance);
        }

        if (_unhealthySamples < _settings.UnhealthySamplesBeforeRecovery)
        {
            return CurrentTransition();
        }

        var decision = observation.Spooler.IsRunning
            ? SupervisorDecision.RestartSpooler
            : SupervisorDecision.StartSpooler;
        _recoveryOutstanding = true;
        return TransitionTo(PrinterSupervisorState.Recovering, decision);
    }

    private bool IsHealthy(SupervisorObservation observation) =>
        observation.Spooler.IsRunning && observation.Printer.IsHealthy;

    private SupervisorTransition TransitionTo(
        PrinterSupervisorState nextState,
        SupervisorDecision decision = SupervisorDecision.None)
    {
        var stateChanged = State != nextState;
        State = nextState;
        return new SupervisorTransition(State, decision, stateChanged, _failedRecoveryAttempts.Count);
    }

    private SupervisorTransition CurrentTransition() =>
        new(State, SupervisorDecision.None, false, _failedRecoveryAttempts.Count);

    private void PruneFailedRecoveryAttempts()
    {
        var cutoff = _clock.UtcNow.AddMinutes(-_settings.CircuitBreakerWindowMinutes);
        _failedRecoveryAttempts.RemoveAll(attempt => attempt < cutoff);
    }
}
