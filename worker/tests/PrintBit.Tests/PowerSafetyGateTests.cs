using System;
using System.Threading.Tasks;
using PrintBit.Infrastructure.Windows.PowerMonitoring;
using PrintBit.Shared.Power;
using Xunit;

namespace PrintBit.Tests;

public class PowerSafetyGateTests
{
    [Fact]
    public void InitialState_IsClosed_DisallowsDispatch()
    {
        var gate = new PowerSafetyGate();

        Assert.False(gate.IsDispatchAllowed);
        Assert.Null(gate.TryAcquirePrintLease());
        Assert.Equal(0, gate.ActiveLeaseCount);
        Assert.Equal(PowerOperationalState.PowerEmergency, gate.CurrentState);
    }

    [Fact]
    public void Apply_Operational_AllowsDispatchAndLeaseAcquisition()
    {
        var gate = new PowerSafetyGate();

        gate.Apply(PowerOperationalState.Operational);

        Assert.True(gate.IsDispatchAllowed);
        Assert.Equal(PowerOperationalState.Operational, gate.CurrentState);

        using var lease = gate.TryAcquirePrintLease();
        Assert.NotNull(lease);
        Assert.Equal(1, gate.ActiveLeaseCount);
    }

    [Fact]
    public void MultipleLeases_CanBeAcquiredWhenOperational_AndDisposedIndependently()
    {
        var gate = new PowerSafetyGate();
        gate.Apply(PowerOperationalState.Operational);

        var lease1 = gate.TryAcquirePrintLease();
        var lease2 = gate.TryAcquirePrintLease();

        Assert.NotNull(lease1);
        Assert.NotNull(lease2);
        Assert.Equal(2, gate.ActiveLeaseCount);

        lease1.Dispose();
        Assert.Equal(1, gate.ActiveLeaseCount);

        // Idempotent dispose
        lease1.Dispose();
        Assert.Equal(1, gate.ActiveLeaseCount);

        lease2.Dispose();
        Assert.Equal(0, gate.ActiveLeaseCount);
    }

    [Fact]
    public void ExistingLease_SurvivesTransitionToPowerEmergency_AndRejectsNewLeases()
    {
        var gate = new PowerSafetyGate();
        gate.Apply(PowerOperationalState.Operational);

        var existingLease = gate.TryAcquirePrintLease();
        Assert.NotNull(existingLease);
        Assert.Equal(1, gate.ActiveLeaseCount);

        // Transition to PowerEmergency
        gate.Apply(PowerOperationalState.PowerEmergency);

        // Gate is now closed
        Assert.False(gate.IsDispatchAllowed);
        Assert.Equal(PowerOperationalState.PowerEmergency, gate.CurrentState);

        // New lease cannot be acquired
        var newLease = gate.TryAcquirePrintLease();
        Assert.Null(newLease);

        // Existing lease is STILL alive and tracked
        Assert.Equal(1, gate.ActiveLeaseCount);

        // When the existing lease finishes and disposes, count decrements cleanly
        existingLease.Dispose();
        Assert.Equal(0, gate.ActiveLeaseCount);
    }

    [Fact]
    public void ExistingLease_SurvivesTransitionToRecovering_AndRejectsNewLeases()
    {
        var gate = new PowerSafetyGate();
        gate.Apply(PowerOperationalState.Operational);

        var existingLease = gate.TryAcquirePrintLease();
        Assert.NotNull(existingLease);
        Assert.Equal(1, gate.ActiveLeaseCount);

        // Transition to Recovering
        gate.Apply(PowerOperationalState.Recovering);

        Assert.False(gate.IsDispatchAllowed);
        Assert.Null(gate.TryAcquirePrintLease());
        Assert.Equal(1, gate.ActiveLeaseCount);

        existingLease.Dispose();
        Assert.Equal(0, gate.ActiveLeaseCount);
    }

    [Fact]
    public void Apply_WithStateMachine_UpdatesGateState()
    {
        var gate = new PowerSafetyGate();
        var sm = new PowerSafetyStateMachine();
        var t0 = new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

        // Advance machine to Operational
        sm.Advance(AcLineStatus.Online, isPrinterHealthy: true, t0);
        sm.Advance(AcLineStatus.Online, isPrinterHealthy: true, t0.AddSeconds(10));
        Assert.Equal(PowerOperationalState.Operational, sm.CurrentState);

        gate.Apply(sm);

        Assert.True(gate.IsDispatchAllowed);
        using var lease = gate.TryAcquirePrintLease();
        Assert.NotNull(lease);
    }

    [Fact]
    public async Task ConcurrentLeaseAcquisitionAndDisposal_IsThreadSafe()
    {
        var gate = new PowerSafetyGate();
        gate.Apply(PowerOperationalState.Operational);

        const int iterations = 1000;
        var tasks = new Task[4];

        for (int i = 0; i < tasks.Length; i++)
        {
            tasks[i] = Task.Run(() =>
            {
                for (int j = 0; j < iterations; j++)
                {
                    var lease = gate.TryAcquirePrintLease();
                    if (lease != null)
                    {
                        lease.Dispose();
                    }
                }
            });
        }

        await Task.WhenAll(tasks);
        Assert.Equal(0, gate.ActiveLeaseCount);
    }
}
