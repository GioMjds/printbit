using System;
using System.Threading;
using PrintBit.Shared.Power;

namespace PrintBit.Infrastructure.Windows.PowerMonitoring;

public class PowerSafetyGate : IPowerSafetyGate
{
    private readonly object _sync = new();
    private PowerOperationalState _currentState;
    private int _activeLeases;

    public PowerSafetyGate(PowerOperationalState initialState = PowerOperationalState.PowerEmergency)
    {
        _currentState = initialState;
    }

    public bool IsDispatchAllowed
    {
        get
        {
            lock (_sync)
            {
                return _currentState == PowerOperationalState.Operational;
            }
        }
    }

    public PowerOperationalState CurrentState
    {
        get
        {
            lock (_sync)
            {
                return _currentState;
            }
        }
    }

    public int ActiveLeaseCount
    {
        get
        {
            lock (_sync)
            {
                return _activeLeases;
            }
        }
    }

    public void Apply(PowerOperationalState state)
    {
        lock (_sync)
        {
            _currentState = state;
        }
    }

    public void Apply(PowerSafetyStateMachine stateMachine)
    {
        ArgumentNullException.ThrowIfNull(stateMachine);
        Apply(stateMachine.CurrentState);
    }

    public IPowerDispatchLease? TryAcquirePrintLease()
    {
        lock (_sync)
        {
            if (_currentState != PowerOperationalState.Operational)
            {
                return null;
            }

            _activeLeases++;
            return new PowerDispatchLease(this);
        }
    }

    internal void ReleaseLease()
    {
        lock (_sync)
        {
            if (_activeLeases > 0)
            {
                _activeLeases--;
            }
        }
    }

    private sealed class PowerDispatchLease : IPowerDispatchLease
    {
        private readonly PowerSafetyGate _gate;
        private int _disposed;

        public PowerDispatchLease(PowerSafetyGate gate)
        {
            _gate = gate;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                _gate.ReleaseLease();
            }
        }
    }
}
