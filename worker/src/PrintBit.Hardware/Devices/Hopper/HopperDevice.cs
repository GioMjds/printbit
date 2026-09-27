using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PrintBit.Hardware.Devices.Hopper.Protocol;
using PrintBit.Infrastructure.Services.SerialService;

namespace PrintBit.Hardware.Devices.Hopper;

/// <summary>
/// Controls the coin hopper device over a serial connection, implementing single-flight
/// dispense execution, progress event dispatching, and dynamic timeout watchdog monitoring.
/// </summary>
public sealed class HopperDevice : IHopper, IDisposable
{
    private readonly ISerialConnection _serialConnection;
    private readonly ILogger<HopperDevice> _logger;
    private readonly TimeProvider _timeProvider;
    private readonly object _lock = new();

    private bool _disposed;
    private bool _isDispensing;
    private string? _activeRequestId;
    private int _activeCoinCount;
    private int _dispensedSoFar;
    private TaskCompletionSource<HopperDispenseResult>? _activeTcs;

    /// <summary>
    /// Gets a value indicating whether a dispense operation is currently in flight.
    /// </summary>
    public bool IsDispensing
    {
        get
        {
            lock (_lock)
            {
                return _isDispensing;
            }
        }
    }

    /// <summary>
    /// Occurs when dispense progress is reported by the hardware.
    /// </summary>
    public event EventHandler<(string RequestId, int Dispensed, int Total)>? ProgressReceived;

    public HopperDevice(
        ISerialConnection serialConnection,
        ILogger<HopperDevice>? logger = null,
        TimeProvider? timeProvider = null)
    {
        _serialConnection = serialConnection ?? throw new ArgumentNullException(nameof(serialConnection));
        _logger = logger ?? NullLogger<HopperDevice>.Instance;
        _timeProvider = timeProvider ?? TimeProvider.System;

        _serialConnection.LineReceived += OnLineReceived;
    }

    public HopperDevice(
        ILogger<HopperDevice> logger,
        ISerialConnection serialConnection)
        : this(serialConnection, logger)
    {
    }

    /// <summary>
    /// Dispenses the specified number of coins asynchronously.
    /// Dynamic timeout: Math.Max(5000, 5000 + (coinCount * 1500)) ms when not overridden.
    /// </summary>
    public async Task<HopperDispenseResult> DispenseAsync(
        string requestId,
        int coinCount,
        int? timeoutMs = null,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(coinCount);
        if (timeoutMs.HasValue)
        {
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(timeoutMs.Value);
        }

        TaskCompletionSource<HopperDispenseResult> tcs;
        lock (_lock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);

            if (_isDispensing)
            {
                _logger.LogWarning(
                    "Hopper dispense rejected: another dispense operation is in progress (active: {ActiveReq}, requested: {RequestedReq})",
                    _activeRequestId,
                    requestId);
                return new HopperDispenseResult(
                    false,
                    requestId,
                    0,
                    "HOPPER_BUSY",
                    "Another dispense operation is in progress");
            }

            _isDispensing = true;
            _activeRequestId = requestId;
            _activeCoinCount = coinCount;
            _dispensedSoFar = 0;
            tcs = new TaskCompletionSource<HopperDispenseResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            _activeTcs = tcs;
        }

        var effectiveTimeout = timeoutMs ?? Math.Max(5000, 5000 + (coinCount * 1500));
        var command = $"HOPPER DISPENSE {requestId} {coinCount}";

        try
        {
            try
            {
                _logger.LogInformation("Sending hopper command: {Command} (timeout: {TimeoutMs}ms)", command, effectiveTimeout);
                _serialConnection.SendLine(command);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to send hopper command '{Command}'", command);
                var sendFailed = new HopperDispenseResult(false, requestId, 0, "SEND_FAILED", ex.Message);
                tcs.TrySetResult(sendFailed);
                return sendFailed;
            }

            var delayTask = Task.Delay(TimeSpan.FromMilliseconds(effectiveTimeout), _timeProvider, ct);
            var completedTask = await Task.WhenAny(tcs.Task, delayTask).ConfigureAwait(false);

            if (completedTask == tcs.Task)
            {
                return await tcs.Task.ConfigureAwait(false);
            }

            int dispensedCount;
            lock (_lock)
            {
                dispensedCount = _dispensedSoFar;
            }

            if (ct.IsCancellationRequested)
            {
                _logger.LogWarning("Hopper dispense {RequestId} cancelled by caller", requestId);
                var cancelResult = new HopperDispenseResult(
                    false,
                    requestId,
                    dispensedCount,
                    "CANCELLED",
                    "Hopper dispense was cancelled");
                tcs.TrySetResult(cancelResult);
                return cancelResult;
            }
            else
            {
                _logger.LogWarning("Hopper dispense {RequestId} timed out after {TimeoutMs}ms", requestId, effectiveTimeout);
                var timeoutResult = new HopperDispenseResult(
                    false,
                    requestId,
                    dispensedCount,
                    "TIMEOUT",
                    "Hopper dispense timed out");
                tcs.TrySetResult(timeoutResult);
                return timeoutResult;
            }
        }
        finally
        {
            lock (_lock)
            {
                _isDispensing = false;
                _activeRequestId = null;
                _activeCoinCount = 0;
                _dispensedSoFar = 0;
                _activeTcs = null;
            }
        }
    }

    private void OnLineReceived(object? sender, string line)
    {
        if (_disposed)
        {
            return;
        }

        if (!HopperProtocolParser.TryParse(line, out var response) || response is null)
        {
            return;
        }

        string? activeRequestId;
        int activeCoinCount;
        TaskCompletionSource<HopperDispenseResult>? activeTcs;

        lock (_lock)
        {
            if (!_isDispensing || _activeRequestId is null)
            {
                return;
            }

            activeRequestId = _activeRequestId;
            activeCoinCount = _activeCoinCount;
            activeTcs = _activeTcs;
        }

        bool isMatch = string.Equals(response.RequestId, activeRequestId, StringComparison.OrdinalIgnoreCase) ||
                       string.Equals(response.RequestId, "legacy", StringComparison.OrdinalIgnoreCase);

        if (!isMatch)
        {
            _logger.LogDebug(
                "Ignored hopper response for RequestId '{ResponseId}'; active request is '{ActiveId}'",
                response.RequestId,
                activeRequestId);
            return;
        }

        switch (response)
        {
            case HopperAckResponse:
                _logger.LogInformation("Hopper acknowledged dispense {RequestId}", activeRequestId);
                break;

            case HopperProgressResponse progress:
                lock (_lock)
                {
                    _dispensedSoFar = progress.Dispensed;
                }
                _logger.LogInformation(
                    "Hopper dispense progress for {RequestId}: {Dispensed}/{Total}",
                    activeRequestId,
                    progress.Dispensed,
                    progress.Total);
                try
                {
                    ProgressReceived?.Invoke(this, (activeRequestId, progress.Dispensed, progress.Total));
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error dispatching ProgressReceived event");
                }
                break;

            case HopperDoneResponse done:
                int finalCount;
                lock (_lock)
                {
                    finalCount = done.DispensedCount > 0
                        ? done.DispensedCount
                        : (_dispensedSoFar > 0 ? _dispensedSoFar : activeCoinCount);
                }
                _logger.LogInformation(
                    "Hopper dispense completed for {RequestId} (dispensed: {Count})",
                    activeRequestId,
                    finalCount);
                activeTcs?.TrySetResult(new HopperDispenseResult(
                    true,
                    activeRequestId,
                    finalCount,
                    null,
                    "Dispense completed successfully"));
                break;

            case HopperErrorResponse error:
                int countSoFar;
                lock (_lock)
                {
                    countSoFar = _dispensedSoFar;
                }
                _logger.LogWarning(
                    "Hopper error for {RequestId}: [{Code}] {Detail}",
                    activeRequestId,
                    error.Code,
                    error.Detail);
                activeTcs?.TrySetResult(new HopperDispenseResult(
                    false,
                    activeRequestId,
                    countSoFar,
                    error.Code,
                    error.Detail));
                break;
        }
    }

    public void Dispose()
    {
        TaskCompletionSource<HopperDispenseResult>? pendingTcs = null;
        string? activeRequestId = null;
        int dispensedSoFar = 0;

        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;

            _serialConnection.LineReceived -= OnLineReceived;

            if (_isDispensing)
            {
                pendingTcs = _activeTcs;
                activeRequestId = _activeRequestId;
                dispensedSoFar = _dispensedSoFar;
            }
        }

        if (pendingTcs is not null && activeRequestId is not null)
        {
            pendingTcs.TrySetResult(new HopperDispenseResult(
                false,
                activeRequestId,
                dispensedSoFar,
                "DISPOSED",
                "Hopper device was disposed"));
        }

        GC.SuppressFinalize(this);
    }
}
