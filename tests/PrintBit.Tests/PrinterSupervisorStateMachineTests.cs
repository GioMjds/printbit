using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Infrastructure.Windows.PrinterMonitoring;
using PrintBit.Shared.Configurations;

namespace PrintBit.Tests;

public class PrinterSupervisorStateMachineTests
{
    [Fact]
    public void TwoWindowsFailures_RequestAutomaticRecovery()
    {
        var machine = CreateMachine();

        machine.Observe(WindowsQueueFault());
        var transition = machine.Observe(WindowsQueueFault());

        Assert.Equal(PrinterSupervisorState.Recovering, transition.State);
        Assert.Equal(SupervisorDecision.RestartSpooler, transition.Decision);
        Assert.True(transition.StateChanged);
    }

    [Fact]
    public void PhysicalFault_ImmediatelyEntersMaintenanceWithoutRecovery()
    {
        var machine = CreateMachine();

        var transition = machine.Observe(PhysicalFault());

        Assert.Equal(PrinterSupervisorState.Maintenance, transition.State);
        Assert.Equal(SupervisorDecision.None, transition.Decision);
        Assert.True(transition.StateChanged);
    }

    [Fact]
    public void RecoveryIsDeferredWhilePrintIsActive()
    {
        var machine = CreateMachine();

        machine.Observe(WindowsQueueFault(PrinterOperationKind.Print));
        var deferred = machine.Observe(WindowsQueueFault(PrinterOperationKind.Print));
        var recovery = machine.Observe(WindowsQueueFault());

        Assert.Equal(PrinterSupervisorState.Busy, deferred.State);
        Assert.Equal(SupervisorDecision.None, deferred.Decision);
        Assert.Equal(PrinterSupervisorState.Recovering, recovery.State);
        Assert.Equal(SupervisorDecision.RestartSpooler, recovery.Decision);
    }

    [Fact]
    public void TwoHealthySamples_ReturnToReady()
    {
        var machine = CreateMachine();

        machine.Observe(Healthy());
        var transition = machine.Observe(Healthy());

        Assert.Equal(PrinterSupervisorState.Ready, transition.State);
        Assert.Equal(SupervisorDecision.None, transition.Decision);
        Assert.True(transition.StateChanged);
    }

    [Fact]
    public void ThreeFailuresWithinTenMinutes_OpenCircuit()
    {
        var machine = CreateMachine();

        FailAutomaticRecovery(machine);
        FailAutomaticRecovery(machine);
        var transition = FailAutomaticRecovery(machine);

        Assert.Equal(PrinterSupervisorState.CircuitOpen, transition.State);
        Assert.Equal(SupervisorDecision.None, transition.Decision);
        Assert.Equal(3, transition.AttemptsInWindow);
    }

    [Fact]
    public void OldFailures_ArePruned()
    {
        var clock = new MutableSystemClock(new DateTime(2026, 9, 9, 0, 0, 0, DateTimeKind.Utc));
        var machine = CreateMachine(clock);

        FailAutomaticRecovery(machine);
        FailAutomaticRecovery(machine);
        clock.UtcNow = clock.UtcNow.AddMinutes(11);
        var transition = FailAutomaticRecovery(machine);

        Assert.NotEqual(PrinterSupervisorState.CircuitOpen, transition.State);
        Assert.Equal(1, transition.AttemptsInWindow);
    }

    [Fact]
    public void SuccessfulHalfOpen_ClosesCircuit()
    {
        var machine = CreateOpenCircuitMachine();

        Assert.True(machine.BeginManualHalfOpen(PrinterOperationKind.None));
        var transition = machine.CompleteRecovery(true);

        Assert.Equal(PrinterSupervisorState.Starting, transition.State);
        Assert.Equal(SupervisorDecision.None, transition.Decision);
        Assert.Equal(0, transition.AttemptsInWindow);
    }

    [Fact]
    public void FailedHalfOpen_KeepsCircuitOpen()
    {
        var machine = CreateOpenCircuitMachine();

        Assert.True(machine.BeginManualHalfOpen(PrinterOperationKind.None));
        var transition = machine.CompleteRecovery(false);

        Assert.Equal(PrinterSupervisorState.CircuitOpen, transition.State);
        Assert.Equal(SupervisorDecision.None, transition.Decision);
        Assert.Equal(3, transition.AttemptsInWindow);
    }

    [Fact]
    public void FailedManualHalfOpen_AfterAutomaticFailuresAgeOut_KeepsCircuitOpenWithoutRecordingAutomaticFailure()
    {
        var clock = new MutableSystemClock(new DateTime(2026, 9, 9, 0, 0, 0, DateTimeKind.Utc));
        var machine = CreateOpenCircuitMachine(clock);
        clock.UtcNow = clock.UtcNow.AddMinutes(11);

        Assert.True(machine.BeginManualHalfOpen(PrinterOperationKind.None));
        var transition = machine.CompleteRecovery(false);

        Assert.Equal(PrinterSupervisorState.CircuitOpen, transition.State);
        Assert.Equal(0, transition.AttemptsInWindow);
    }

    [Fact]
    public void PhysicalFaultDuringOpenCircuit_PreservesLatchAndBlocksLaterAutomaticRecovery()
    {
        var machine = CreateOpenCircuitMachine();

        var maintenance = machine.Observe(PhysicalFault());
        var afterFaultClears = machine.Observe(Healthy());
        var windowsFault = machine.Observe(WindowsQueueFault());

        Assert.Equal(PrinterSupervisorState.Maintenance, maintenance.State);
        Assert.Equal(SupervisorDecision.None, maintenance.Decision);
        Assert.Equal(PrinterSupervisorState.CircuitOpen, afterFaultClears.State);
        Assert.Equal(SupervisorDecision.None, afterFaultClears.Decision);
        Assert.Equal(PrinterSupervisorState.CircuitOpen, windowsFault.State);
        Assert.Equal(SupervisorDecision.None, windowsFault.Decision);
    }

    [Fact]
    public void SuccessfulAutomaticRecovery_PreservesPriorFailureHistory()
    {
        var machine = CreateMachine();

        FailAutomaticRecovery(machine);
        RequestAutomaticRecovery(machine);
        var success = machine.CompleteRecovery(true);
        var nextFailure = FailAutomaticRecovery(machine);

        Assert.Equal(PrinterSupervisorState.Starting, success.State);
        Assert.Equal(1, success.AttemptsInWindow);
        Assert.Equal(PrinterSupervisorState.Maintenance, nextFailure.State);
        Assert.Equal(2, nextFailure.AttemptsInWindow);
    }

    [Fact]
    public void InterveningObservations_DoNotDiscardOutstandingRecoveryCompletion()
    {
        var machine = CreateMachine();

        RequestAutomaticRecovery(machine);
        var duplicate = machine.Observe(WindowsQueueFault());
        machine.Observe(PhysicalFault());
        var completion = machine.CompleteRecovery(false);
        var duplicateCompletion = machine.CompleteRecovery(false);

        Assert.Equal(SupervisorDecision.None, duplicate.Decision);
        Assert.Equal(PrinterSupervisorState.Maintenance, completion.State);
        Assert.Equal(1, completion.AttemptsInWindow);
        Assert.Equal(1, duplicateCompletion.AttemptsInWindow);
    }

    [Fact]
    public void FailedAutomaticRecovery_BelowCircuitThreshold_EntersMaintenanceAndCanResample()
    {
        var machine = CreateMachine();

        RequestAutomaticRecovery(machine);
        var failed = machine.CompleteRecovery(false);
        machine.Observe(WindowsQueueFault());
        var retry = machine.Observe(WindowsQueueFault());

        Assert.Equal(PrinterSupervisorState.Maintenance, failed.State);
        Assert.Equal(SupervisorDecision.RestartSpooler, retry.Decision);
        Assert.Equal(PrinterSupervisorState.Recovering, retry.State);
    }

    [Fact]
    public void FailureAtRollingWindowCutoff_IsRetained()
    {
        var clock = new MutableSystemClock(new DateTime(2026, 9, 9, 0, 0, 0, DateTimeKind.Utc));
        var machine = CreateMachine(clock);

        FailAutomaticRecovery(machine);
        clock.UtcNow = clock.UtcNow.AddMinutes(10);
        var transition = FailAutomaticRecovery(machine);

        Assert.Equal(2, transition.AttemptsInWindow);
    }

    private static PrinterSupervisorStateMachine CreateMachine(MutableSystemClock? clock = null) =>
        new(new PrinterRecoverySettings(), clock ?? new MutableSystemClock(DateTime.UtcNow));

    private static PrinterSupervisorStateMachine CreateOpenCircuitMachine(MutableSystemClock? clock = null)
    {
        var machine = CreateMachine(clock);
        FailAutomaticRecovery(machine);
        FailAutomaticRecovery(machine);
        FailAutomaticRecovery(machine);
        return machine;
    }

    private static SupervisorTransition FailAutomaticRecovery(PrinterSupervisorStateMachine machine)
    {
        RequestAutomaticRecovery(machine);
        return machine.CompleteRecovery(false);
    }

    private static SupervisorTransition RequestAutomaticRecovery(PrinterSupervisorStateMachine machine)
    {
        machine.Observe(WindowsQueueFault());
        return machine.Observe(WindowsQueueFault());
    }

    private static SupervisorObservation Healthy() =>
        new(
            new SpoolerStatusSnapshot { IsRunning = true, Status = "Running" },
            new PrinterHealthDiagnostic
            {
                PrinterState = PrinterHealthState.Healthy,
                IssueKind = PrinterHealthIssueKind.None
            },
            PrinterOperationKind.None);

    private static SupervisorObservation WindowsQueueFault(PrinterOperationKind operation = PrinterOperationKind.None) =>
        new(
            new SpoolerStatusSnapshot { IsRunning = true, Status = "Running" },
            new PrinterHealthDiagnostic
            {
                PrinterState = PrinterHealthState.Offline,
                IssueKind = PrinterHealthIssueKind.WindowsQueueFault
            },
            operation);

    private static SupervisorObservation PhysicalFault() =>
        new(
            new SpoolerStatusSnapshot { IsRunning = true, Status = "Running" },
            new PrinterHealthDiagnostic
            {
                PrinterState = PrinterHealthState.Fault,
                IssueKind = PrinterHealthIssueKind.PhysicalFault
            },
            PrinterOperationKind.None);

    private sealed class MutableSystemClock(DateTime utcNow) : ISystemClock
    {
        public DateTime UtcNow { get; set; } = utcNow;
    }
}
