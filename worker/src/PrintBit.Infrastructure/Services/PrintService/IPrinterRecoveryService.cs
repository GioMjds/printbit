using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Services.PrintService;

public interface IPrinterRecoveryService
{
    Task<PrinterRecoveryResult> GetStatusAsync(CancellationToken cancellationToken);
    Task<PrinterRecoveryResult> AttemptRepairAsync(CancellationToken cancellationToken);
    Task<PrinterRecoveryResult> AttemptRepairAsync(SupervisorDecision decision, CancellationToken cancellationToken);
    Task<PrinterRecoveryResult> RestartSpoolerAsync(string? targetPrinterName, CancellationToken cancellationToken);
}
