using System;
using System.Collections.Concurrent;
using System.Linq;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PrintBit.Infrastructure.Windows.PowerMonitoring;

namespace PrintBit.Hardware.Devices.CoinAcceptor;

/// <summary>
/// Represents the coin acceptor hardware device, orchestrating coin pulse decoding,
/// hybrid power safety gating, and session locking.
/// </summary>
public sealed class CoinAcceptorDevice : ICoinAcceptor, IDisposable
{
    private readonly CoinPulseDecoder _decoder;
    private readonly IPowerSafetyGate _powerSafetyGate;
    private readonly ILogger<CoinAcceptorDevice> _logger;
    private readonly ConcurrentDictionary<string, string> _locks = new();

    private volatile bool _disposed;

    /// <summary>
    /// Gets a value indicating whether coin acceptance is currently locked,
    /// either due to power safety emergency or one or more active session locks.
    /// </summary>
    public bool IsLocked => !_powerSafetyGate.IsDispatchAllowed || !_locks.IsEmpty;

    /// <summary>
    /// Occurs when a coin is successfully decoded and accepted under healthy power and session conditions.
    /// </summary>
    public event EventHandler<int>? CoinAccepted;

    /// <summary>
    /// Occurs when a coin is decoded but rejected due to power emergency or an active session lock.
    /// </summary>
    public event EventHandler<(int Value, string Reason)>? CoinRejected;

    public CoinAcceptorDevice(
        CoinPulseDecoder decoder,
        IPowerSafetyGate powerSafetyGate,
        ILogger<CoinAcceptorDevice>? logger = null)
    {
        _decoder = decoder ?? throw new ArgumentNullException(nameof(decoder));
        _powerSafetyGate = powerSafetyGate ?? throw new ArgumentNullException(nameof(powerSafetyGate));
        _logger = logger ?? NullLogger<CoinAcceptorDevice>.Instance;

        _decoder.CoinResolved += OnCoinResolved;
    }

    /// <summary>
    /// Acquires or updates a lock identified by the specified owner ID with an optional reason.
    /// </summary>
    public void Lock(string ownerId, string? reason = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(ownerId);

        string effectiveReason = string.IsNullOrWhiteSpace(reason) ? ownerId : reason;
        _locks[ownerId] = effectiveReason;
        _logger.LogInformation("Coin acceptor locked by '{OwnerId}' (reason: {Reason})", ownerId, effectiveReason);
    }

    /// <summary>
    /// Releases the lock identified by the specified owner ID.
    /// </summary>
    /// <returns>True if the lock was found and removed; otherwise, false.</returns>
    public bool Unlock(string ownerId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(ownerId);

        bool removed = _locks.TryRemove(ownerId, out _);
        if (removed)
        {
            _logger.LogInformation("Coin acceptor unlocked by '{OwnerId}'", ownerId);
        }

        return removed;
    }

    /// <summary>
    /// Clears all active locks.
    /// </summary>
    public void ResetLocks()
    {
        _locks.Clear();
        _logger.LogInformation("All coin acceptor locks have been reset");
    }

    private void OnCoinResolved(object? sender, int coinValue)
    {
        if (_disposed)
        {
            return;
        }

        if (!_powerSafetyGate.IsDispatchAllowed)
        {
            _logger.LogWarning("Coin value {Value} rejected: power emergency active", coinValue);
            try
            {
                CoinRejected?.Invoke(this, (coinValue, "power_emergency"));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error occurred while dispatching CoinRejected event");
            }
            return;
        }

        var activeLock = _locks.FirstOrDefault();
        if (activeLock.Key is not null)
        {
            var lockReasonOrOwner = string.IsNullOrWhiteSpace(activeLock.Value) ? activeLock.Key : activeLock.Value;
            _logger.LogInformation("Coin value {Value} rejected: active session lock ({Reason})", coinValue, lockReasonOrOwner);
            try
            {
                CoinRejected?.Invoke(this, (coinValue, lockReasonOrOwner));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error occurred while dispatching CoinRejected event");
            }
            return;
        }

        _logger.LogInformation("Coin value {Value} accepted", coinValue);
        try
        {
            CoinAccepted?.Invoke(this, coinValue);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error occurred while dispatching CoinAccepted event");
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _decoder.CoinResolved -= OnCoinResolved;
        _locks.Clear();

        GC.SuppressFinalize(this);
    }
}
