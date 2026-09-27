namespace PrintBit.Hardware.Devices.Hopper;

/// <summary>
/// Represents the result of a coin hopper dispense operation.
/// </summary>
public sealed record HopperDispenseResult(
    bool Success,
    string RequestId,
    int DispensedCoins,
    string? ErrorCode,
    string Message);

/// <summary>
/// Interface for coin hopper hardware operations.
/// </summary>
public interface IHopper
{
    /// <summary>
    /// Gets a value indicating whether a dispense operation is currently in flight.
    /// </summary>
    bool IsDispensing { get; }

    /// <summary>
    /// Occurs when dispense progress is reported by the hardware.
    /// </summary>
    event EventHandler<(string RequestId, int Dispensed, int Total)>? ProgressReceived;

    /// <summary>
    /// Dispenses the requested number of coins asynchronously.
    /// </summary>
    Task<HopperDispenseResult> DispenseAsync(string requestId, int coinCount, int? timeoutMs = null, CancellationToken ct = default);
}
