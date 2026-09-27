using System.Threading;
using System.Threading.Tasks;
using PrintBit.Application.Events;
using PrintBit.Hardware.Devices.ESP32;
using PrintBit.Hardware.Devices.Hopper;
using PrintBit.Infrastructure.IPC;

namespace PrintBit.Application.Services;

public interface IHardwareOrchestrator
{
    void AnnounceKioskIp(string ip, int port, string path);
    void SendWifiCommand(string action);

    bool IsCoinSlotLocked { get; }
    void LockCoinSlot(string ownerId, string? reason = null);
    bool UnlockCoinSlot(string ownerId);
    void ResetCoinSlotLocks();

    bool IsDispensingCoins { get; }
    Task<HopperDispenseResult> DispenseCoinsAsync(string requestId, int coinCount, int? timeoutMs = null, CancellationToken ct = default);

    Task HandleEsp32MessageAsync(Esp32Message message);
    Task<bool> HandlePrintRequestAsync(StartPrintEvent request, string source, CancellationToken cancellationToken = default);
    Task HandlePipeMessageAsync(PipeMessage message, CancellationToken cancellationToken = default);
}
