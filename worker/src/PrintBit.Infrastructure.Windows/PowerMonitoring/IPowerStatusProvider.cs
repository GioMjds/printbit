using PrintBit.Shared.Power;

namespace PrintBit.Infrastructure.Windows.PowerMonitoring;

public interface IPowerStatusProvider
{
    bool TryGetStatus(out PowerStatusSnapshot snapshot, out string? error);
}
