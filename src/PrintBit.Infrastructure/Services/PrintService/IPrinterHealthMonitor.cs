using System;
using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Services.PrintService;

public interface IPrinterHealthMonitor
{
    PrinterHealthDiagnostic GetDiagnostic(string printerName);
    bool IsHealthy(string printerName, out int winSpoolStatus, out string winSpoolDesc);
    bool HasFatalHardwareError(string printerName, out int errorCode, out string errorMessage);
    Task<bool> WaitForPrinterHealthyAsync(
        string printerName,
        int timeoutSeconds,
        CancellationToken cancellationToken);
    (bool JobExists, uint StatusMask, string JobStatus, int PagesPrinted, int TotalPages, string? JobId) QueryJobStatus(
        string printerName,
        string documentName);
    void CancelMatchingJobs(string printerName, string documentName, string? spoolerJobId);
}
