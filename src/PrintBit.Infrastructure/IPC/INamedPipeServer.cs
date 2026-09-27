namespace PrintBit.Infrastructure.IPC;

public interface INamedPipeServer
{
    event Func<PipeMessage, CancellationToken, Task>? MessageReceived;

    Task StartAsync(
        CancellationToken cancellationToken = default);

    Task BroadcastAsync(
        PipeMessage message,
        CancellationToken cancellationToken = default);
}
