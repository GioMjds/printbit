using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Windows.PrinterMonitoring;

public sealed class SpoolerStatusSnapshot
{
    public bool IsRunning { get; init; }
    public string Status { get; init; } = string.Empty;
    public string? ErrorMessage { get; init; }
}

public sealed class SpoolerRestartResult
{
    public bool Success { get; init; }
    public string? Error { get; init; }
    public string FinalStatus { get; init; } = string.Empty;
}

public interface IPrintSpoolerController
{
    Task<SpoolerStatusSnapshot> GetStatusAsync(CancellationToken cancellationToken = default);
    Task<SpoolerRestartResult> StartAsync(CancellationToken cancellationToken = default);
    Task<SpoolerRestartResult> RestartAsync(CancellationToken cancellationToken = default);
}
