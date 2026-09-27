using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Windows.Security;

public interface IAntivirusScanner
{
    Task<DefenderHealth> GetHealthAsync(CancellationToken cancellationToken);
    Task<DefenderScanResult> ScanFileAsync(string filePath, CancellationToken cancellationToken);
}