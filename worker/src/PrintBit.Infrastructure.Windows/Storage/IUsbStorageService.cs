using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Windows.Storage;

public interface IUsbStorageService
{
    Task<IReadOnlyList<RemovableDrive>> ListRemovableAsync(CancellationToken cancellationToken);
    Task<UsbExportResult> ExportAsync(string sourcePath, string drive, CancellationToken cancellationToken);
}