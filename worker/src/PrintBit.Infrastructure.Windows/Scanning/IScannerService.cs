using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Windows.Scanning;

public interface IScannerService
{
    Task<ScannerRuntimeStatus> GetStatusAsync(CancellationToken cancellationToken = default);
    Task<ScannerCapabilities> ProbeCapabilitiesAsync(CancellationToken cancellationToken = default);
    Task<ScanResult> ExecuteScanAsync(ScanRequest request, CancellationToken cancellationToken = default);
    Task<bool> CancelScanAsync(string requestId);
}
