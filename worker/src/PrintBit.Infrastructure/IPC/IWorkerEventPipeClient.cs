using PrintBit.Infrastructure.Services.PrintService;

namespace PrintBit.Infrastructure.IPC;

public interface IWorkerEventPipeClient
{
    Task<bool> SendAsync(
        WorkerPrintEvent evt,
        CancellationToken cancellationToken = default);

    Task<bool> PublishAsync(
        WorkerPrintEvent evt,
        CancellationToken cancellationToken = default) => SendAsync(evt, cancellationToken);

    Task<bool> PublishSupervisorAsync(
        PrinterSupervisorSnapshot snapshot,
        CancellationToken cancellationToken = default) => Task.FromResult(false);
}
