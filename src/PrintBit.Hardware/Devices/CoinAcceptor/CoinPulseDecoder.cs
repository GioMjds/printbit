using System;
using System.Collections.Generic;
using System.Threading;

namespace PrintBit.Hardware.Devices.CoinAcceptor;

/// <summary>
/// Decodes incoming serial pulse tokens from the coin acceptor according to a sliding window.
/// Buffers multi-pulse fragments ("1" -> 1 or 10, "2" -> 20 or invalid) within a 140ms sliding window.
/// </summary>
public sealed class CoinPulseDecoder : IDisposable
{
    public const int FragmentWindowMs = 140;

    private readonly int _fragmentWindowMs;
    private readonly TimeProvider _timeProvider;
    private readonly ITimer _timer;
    private readonly object _stateLock = new();

    private string? _pendingFragment;
    private bool _disposed;

    public event EventHandler<int>? CoinResolved;
    public event EventHandler<(string Code, string Message)>? WarningEmitted;

    public CoinPulseDecoder(int fragmentWindowMs = FragmentWindowMs, TimeProvider? timeProvider = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(fragmentWindowMs);

        _fragmentWindowMs = fragmentWindowMs;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _timer = _timeProvider.CreateTimer(OnTimerElapsed, null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    public void ProcessToken(string token)
    {
        ArgumentNullException.ThrowIfNull(token);

        var trimmed = token.Trim();
        if (trimmed.Length == 0)
        {
            return;
        }

        List<Action> eventsToFire = new();

        lock (_stateLock)
        {
            if (_disposed)
            {
                return;
            }

            if (trimmed == "0")
            {
                if (_pendingFragment == "1")
                {
                    _timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
                    _pendingFragment = null;
                    eventsToFire.Add(() => CoinResolved?.Invoke(this, 10));
                }
                else if (_pendingFragment == "2")
                {
                    _timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
                    _pendingFragment = null;
                    eventsToFire.Add(() => CoinResolved?.Invoke(this, 20));
                }
                else
                {
                    eventsToFire.Add(() => WarningEmitted?.Invoke(this, ("UNEXPECTED_ZERO", "Received unexpected isolated '0' token")));
                }
            }
            else
            {
                // If there was a pending fragment, flush/evaluate it first
                if (_pendingFragment is not null)
                {
                    _timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
                    var flushedFragment = _pendingFragment;
                    _pendingFragment = null;

                    if (flushedFragment == "1")
                    {
                        eventsToFire.Add(() => CoinResolved?.Invoke(this, 1));
                    }
                    else if (flushedFragment == "2")
                    {
                        eventsToFire.Add(() => WarningEmitted?.Invoke(this, ("INVALID_FRAGMENT", "Unmatched coin fragment '2'")));
                    }
                }

                if (trimmed == "5")
                {
                    eventsToFire.Add(() => CoinResolved?.Invoke(this, 5));
                }
                else if (trimmed == "1")
                {
                    _pendingFragment = "1";
                    _timer.Change(TimeSpan.FromMilliseconds(_fragmentWindowMs), Timeout.InfiniteTimeSpan);
                }
                else if (trimmed == "2")
                {
                    _pendingFragment = "2";
                    _timer.Change(TimeSpan.FromMilliseconds(_fragmentWindowMs), Timeout.InfiniteTimeSpan);
                }
                else
                {
                    eventsToFire.Add(() => WarningEmitted?.Invoke(this, ("UNEXPECTED_TOKEN", $"Unexpected coin token '{trimmed}'")));
                }
            }
        }

        FireEvents(eventsToFire);
    }

    public void Flush()
    {
        List<Action> eventsToFire = new();

        lock (_stateLock)
        {
            if (_disposed || _pendingFragment is null)
            {
                return;
            }

            _timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            var flushedFragment = _pendingFragment;
            _pendingFragment = null;

            if (flushedFragment == "1")
            {
                eventsToFire.Add(() => CoinResolved?.Invoke(this, 1));
            }
            else if (flushedFragment == "2")
            {
                eventsToFire.Add(() => WarningEmitted?.Invoke(this, ("INVALID_FRAGMENT", "Unmatched coin fragment '2'")));
            }
        }

        FireEvents(eventsToFire);
    }

    private void OnTimerElapsed(object? state)
    {
        List<Action> eventsToFire = new();

        lock (_stateLock)
        {
            if (_disposed || _pendingFragment is null)
            {
                return;
            }

            var expiredFragment = _pendingFragment;
            _pendingFragment = null;

            if (expiredFragment == "1")
            {
                eventsToFire.Add(() => CoinResolved?.Invoke(this, 1));
            }
            else if (expiredFragment == "2")
            {
                eventsToFire.Add(() => WarningEmitted?.Invoke(this, ("INVALID_FRAGMENT", "Unmatched coin fragment '2'")));
            }
        }

        FireEvents(eventsToFire);
    }

    private static void FireEvents(List<Action> events)
    {
        foreach (var action in events)
        {
            try
            {
                action();
            }
            catch
            {
                // Prevent downstream subscriber exceptions from terminating ThreadPool / timer thread
            }
        }
    }

    public void Dispose()
    {
        lock (_stateLock)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _pendingFragment = null;
            _timer.Dispose();
        }

        GC.SuppressFinalize(this);
    }
}
