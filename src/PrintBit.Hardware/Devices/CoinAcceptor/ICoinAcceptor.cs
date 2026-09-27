using System;

namespace PrintBit.Hardware.Devices.CoinAcceptor;

public interface ICoinAcceptor
{
    bool IsLocked { get; }
    event EventHandler<int>? CoinAccepted;
    event EventHandler<(int Value, string Reason)>? CoinRejected;
    void Lock(string ownerId, string? reason = null);
    bool Unlock(string ownerId);
    void ResetLocks();
}
