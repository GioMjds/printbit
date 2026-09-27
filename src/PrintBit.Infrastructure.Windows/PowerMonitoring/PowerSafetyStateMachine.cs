using System;
using Microsoft.Extensions.Options;
using PrintBit.Shared.Configurations;
using PrintBit.Shared.Power;

namespace PrintBit.Infrastructure.Windows.PowerMonitoring;

public class PowerSafetyStateMachine
{
    private readonly object _sync = new();
    private readonly TimeSpan _stableRecoveryDuration;
    private PowerOperationalState _currentState;
    private DateTimeOffset? _recoveryStartedAt;

    public PowerSafetyStateMachine()
        : this(TimeSpan.FromSeconds(10), PowerOperationalState.PowerEmergency)
    {
    }

    public PowerSafetyStateMachine(IOptions<PowerSettings> options)
        : this(
            options?.Value != null && options.Value.StableRecoverySeconds > 0
                ? TimeSpan.FromSeconds(options.Value.StableRecoverySeconds)
                : TimeSpan.FromSeconds(10),
            PowerOperationalState.PowerEmergency)
    {
    }

    public PowerSafetyStateMachine(
        TimeSpan? stableRecoveryDuration = null,
        PowerOperationalState initialState = PowerOperationalState.PowerEmergency)
    {
        _stableRecoveryDuration = stableRecoveryDuration ?? TimeSpan.FromSeconds(10);
        _currentState = initialState;
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

    public TimeSpan StableRecoveryDuration => _stableRecoveryDuration;

    public DateTimeOffset? RecoveryStartedAt
    {
        get
        {
            lock (_sync)
            {
                return _recoveryStartedAt;
            }
        }
    }

    public PowerOperationalState Advance(AcLineStatus acStatus, bool isPrinterHealthy, DateTimeOffset timestamp)
    {
        lock (_sync)
        {
            if (acStatus != AcLineStatus.Online)
            {
                _recoveryStartedAt = null;
                _currentState = PowerOperationalState.PowerEmergency;
                return _currentState;
            }

            if (_currentState == PowerOperationalState.Operational)
            {
                return _currentState;
            }

            if (_currentState == PowerOperationalState.PowerEmergency)
            {
                _recoveryStartedAt = timestamp;
                _currentState = PowerOperationalState.Recovering;
            }

            if (_recoveryStartedAt == null)
            {
                _recoveryStartedAt = timestamp;
            }
            else if (timestamp < _recoveryStartedAt.Value)
            {
                _recoveryStartedAt = timestamp;
            }

            var elapsed = timestamp - _recoveryStartedAt.Value;
            if (elapsed >= _stableRecoveryDuration && isPrinterHealthy)
            {
                _currentState = PowerOperationalState.Operational;
                _recoveryStartedAt = null;
            }

            return _currentState;
        }
    }

    public PowerOperationalState Advance(PowerStatusSnapshot? snapshot, bool isPrinterHealthy, DateTimeOffset timestamp)
    {
        var acStatus = snapshot?.AcLineStatus ?? AcLineStatus.Unknown;
        return Advance(acStatus, isPrinterHealthy, timestamp);
    }
}
