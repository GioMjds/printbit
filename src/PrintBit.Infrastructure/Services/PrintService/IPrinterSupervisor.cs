using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Services.PrintService;

public interface IPrinterSupervisor
{
    PrinterSupervisorSnapshot CurrentSnapshot { get; }

    bool IsReady { get; }

    Task<PrinterRecoveryResult> AttemptManualRecoveryAsync(
        CancellationToken cancellationToken = default);
}
