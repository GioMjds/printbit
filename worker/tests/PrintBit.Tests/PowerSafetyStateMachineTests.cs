using System;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.Windows.PowerMonitoring;
using PrintBit.Shared.Configurations;
using PrintBit.Shared.Power;
using Xunit;

namespace PrintBit.Tests;

public class PowerSafetyStateMachineTests
{
    private readonly DateTimeOffset _t0 = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void InitialState_IsPowerEmergency_Closed()
    {
        var machine = new PowerSafetyStateMachine();

        Assert.Equal(PowerOperationalState.PowerEmergency, machine.CurrentState);
    }

    [Fact]
    public void Advance_WhenAcOffline_RemainsPowerEmergency()
    {
        var machine = new PowerSafetyStateMachine();

        var state = machine.Advance(AcLineStatus.Offline, isPrinterHealthy: true, _t0);

        Assert.Equal(PowerOperationalState.PowerEmergency, state);
        Assert.Equal(PowerOperationalState.PowerEmergency, machine.CurrentState);
    }

    [Fact]
    public void Advance_WhenAcUnknown_RemainsPowerEmergency()
    {
        var machine = new PowerSafetyStateMachine();

        var state = machine.Advance(AcLineStatus.Unknown, isPrinterHealthy: true, _t0);

        Assert.Equal(PowerOperationalState.PowerEmergency, state);
        Assert.Equal(PowerOperationalState.PowerEmergency, machine.CurrentState);
    }

    [Fact]
    public void Advance_WhenAcOnline_TransitionsToRecovering_ForFewerThan10Seconds()
    {
        var machine = new PowerSafetyStateMachine();

        // At t0, AC comes online
        var state1 = machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0);
        Assert.Equal(PowerOperationalState.Recovering, state1);

        // At t0 + 2s, AC still online, printer healthy, but elapsed < 10s
        var state2 = machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(2));
        Assert.Equal(PowerOperationalState.Recovering, state2);

        // At t0 + 9.9s, still < 10s
        var state3 = machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(9.9));
        Assert.Equal(PowerOperationalState.Recovering, state3);
    }

    [Fact]
    public void Advance_WhenAcOnlineFor10Seconds_AndPrinterHealthy_ReopensToOperational()
    {
        var machine = new PowerSafetyStateMachine();

        machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0);
        var state = machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(10));

        Assert.Equal(PowerOperationalState.Operational, state);
        Assert.Equal(PowerOperationalState.Operational, machine.CurrentState);
    }

    [Fact]
    public void Advance_WhenAcOnlineFor10Seconds_ButPrinterUnhealthy_RemainsRecovering()
    {
        var machine = new PowerSafetyStateMachine();

        machine.Advance(AcLineStatus.Online, isPrinterHealthy: false, _t0);
        
        // 10s elapsed, but printer unhealthy -> remains Recovering
        var state10s = machine.Advance(AcLineStatus.Online, isPrinterHealthy: false, _t0.AddSeconds(10));
        Assert.Equal(PowerOperationalState.Recovering, state10s);
        Assert.Equal(PowerOperationalState.Recovering, machine.CurrentState);

        // Later at 12s, printer becomes healthy -> transitions to Operational
        var state12s = machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(12));
        Assert.Equal(PowerOperationalState.Operational, state12s);
        Assert.Equal(PowerOperationalState.Operational, machine.CurrentState);
    }

    [Fact]
    public void Advance_WhenInOperational_AndAcBecomesOffline_TransitionsToPowerEmergency()
    {
        var machine = new PowerSafetyStateMachine();

        // Reach Operational
        machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0);
        machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(10));
        Assert.Equal(PowerOperationalState.Operational, machine.CurrentState);

        // AC drops to Offline
        var state = machine.Advance(AcLineStatus.Offline, isPrinterHealthy: true, _t0.AddSeconds(15));
        Assert.Equal(PowerOperationalState.PowerEmergency, state);
        Assert.Equal(PowerOperationalState.PowerEmergency, machine.CurrentState);
    }

    [Fact]
    public void Advance_WhenInOperational_AndAcBecomesUnknown_TransitionsToPowerEmergency()
    {
        var machine = new PowerSafetyStateMachine();

        // Reach Operational
        machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0);
        machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(10));
        Assert.Equal(PowerOperationalState.Operational, machine.CurrentState);

        // AC drops to Unknown
        var state = machine.Advance(AcLineStatus.Unknown, isPrinterHealthy: true, _t0.AddSeconds(15));
        Assert.Equal(PowerOperationalState.PowerEmergency, state);
        Assert.Equal(PowerOperationalState.PowerEmergency, machine.CurrentState);
    }

    [Fact]
    public void Advance_WhenAcDropsDuringRecovery_Resets10SecondTimer()
    {
        var machine = new PowerSafetyStateMachine();

        // AC online at t0
        machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0);
        // AC still online at t0 + 6s
        machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(6));

        // AC drops at t0 + 7s
        var dropState = machine.Advance(AcLineStatus.Offline, isPrinterHealthy: true, _t0.AddSeconds(7));
        Assert.Equal(PowerOperationalState.PowerEmergency, dropState);

        // AC recovers at t0 + 10s
        var recover1 = machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(10));
        Assert.Equal(PowerOperationalState.Recovering, recover1);

        // At t0 + 15s (only 5s after new recovery start), must still be Recovering!
        var recover2 = machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(15));
        Assert.Equal(PowerOperationalState.Recovering, recover2);

        // At t0 + 20s (10s after new recovery start), transitions to Operational
        var operational = machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(20));
        Assert.Equal(PowerOperationalState.Operational, operational);
    }

    [Fact]
    public void Advance_WithPowerStatusSnapshot_RespectsAcLineStatus_AndIgnoresIsChargingFalse()
    {
        var machine = new PowerSafetyStateMachine();

        // IsCharging == false must NEVER be treated as an outage when AcLineStatus is Online
        var snapshotOnlineNotCharging = new PowerStatusSnapshot(
            AcLineStatus.Online,
            IsCharging: false,
            BatteryPercentage: 100,
            IsBatteryLow: false,
            IsBatteryCritical: false);

        var state1 = machine.Advance(snapshotOnlineNotCharging, isPrinterHealthy: true, _t0);
        Assert.Equal(PowerOperationalState.Recovering, state1);

        var state2 = machine.Advance(snapshotOnlineNotCharging, isPrinterHealthy: true, _t0.AddSeconds(10));
        Assert.Equal(PowerOperationalState.Operational, state2);
    }

    [Fact]
    public void Advance_WithNullSnapshot_FailsClosedToPowerEmergency()
    {
        var machine = new PowerSafetyStateMachine();

        // Reach Operational
        machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0);
        machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(10));
        Assert.Equal(PowerOperationalState.Operational, machine.CurrentState);

        // Null snapshot (API failure / unknown) -> PowerEmergency
        var state = machine.Advance((PowerStatusSnapshot?)null, isPrinterHealthy: true, _t0.AddSeconds(15));
        Assert.Equal(PowerOperationalState.PowerEmergency, state);
    }

    [Fact]
    public void Constructor_WithOptions_UsesConfiguredStableRecoverySeconds()
    {
        var settings = new PowerSettings { StableRecoverySeconds = 5 };
        var options = Options.Create(settings);
        var machine = new PowerSafetyStateMachine(options);

        machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0);
        // At 4 seconds: still recovering
        var state4s = machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(4));
        Assert.Equal(PowerOperationalState.Recovering, state4s);

        // At 5 seconds: operational
        var state5s = machine.Advance(AcLineStatus.Online, isPrinterHealthy: true, _t0.AddSeconds(5));
        Assert.Equal(PowerOperationalState.Operational, state5s);
    }
}
