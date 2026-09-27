using System.Threading;
using System.Threading.Tasks;
using PrintBit.Infrastructure.IPC;

namespace PrintBit.Infrastructure.Services.PrintService;

public interface IJobOrchestrator
{
    Task<PrintJobResult> ProcessJobAsync(
        PrintJobRequest request,
        string jsonFilePath,
        CancellationToken cancellationToken);
}
