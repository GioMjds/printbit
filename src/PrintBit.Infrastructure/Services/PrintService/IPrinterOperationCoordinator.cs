using System;
using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Services.PrintService;

public enum PrinterOperationKind
{
    None,
    Print,
    Recovery
}

public interface IPrinterOperationCoordinator
{
    PrinterOperationKind ActiveOperation { get; }
    Task<IDisposable> AcquirePrintAsync(CancellationToken cancellationToken);
    bool TryAcquireRecovery(out IDisposable? lease);
}
