using System;

using PrintBit.Shared.Power;

namespace PrintBit.Infrastructure.Windows.PowerMonitoring;

public interface IPowerSafetyGate
{
    IPowerDispatchLease? TryAcquirePrintLease();
    bool IsDispatchAllowed { get; }
    void Apply(PowerOperationalState state);
    void Apply(PowerSafetyStateMachine stateMachine);
}

public interface IPowerDispatchLease : IDisposable
{
}
