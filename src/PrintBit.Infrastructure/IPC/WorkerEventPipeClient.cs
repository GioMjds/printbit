using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using PrintBit.Infrastructure.Services.PrintService;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.IPC;

public sealed class WorkerEventPipeClient : IWorkerEventPipeClient
{
    private readonly ILogger<WorkerEventPipeClient> _logger;

    private readonly IpcSettings _settings;

    public WorkerEventPipeClient(
        ILogger<WorkerEventPipeClient> logger,
        IOptions<IpcSettings> options)
    {
        _logger = logger;
        _settings = options.Value;
    }

    public Task<bool> PublishAsync(
        WorkerPrintEvent evt,
        CancellationToken cancellationToken = default) => SendAsync(evt, cancellationToken);

    public Task<bool> PublishSupervisorAsync(
        PrinterSupervisorSnapshot snapshot,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        return SendPayloadAsync(snapshot, snapshot.Type, cancellationToken);
    }

    /// <summary>
    /// Sends a newline-delimited JSON event to the worker return pipe.
    /// Returns true when the payload was written and flushed; false when
    /// the listener was unavailable (timeout, access denied, IO error).
    /// Callers can keep the event and retry on a later call. The connect
    /// timeout is sourced from <see cref="IpcSettings.ConnectTimeoutMs"/>.
    /// </summary>
    public Task<bool> SendAsync(
        WorkerPrintEvent evt,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(evt);
        return SendPayloadAsync(evt, evt.Type, cancellationToken);
    }

    private async Task<bool> SendPayloadAsync<T>(T value, WorkerPrintEventType type, CancellationToken cancellationToken)
    {
        await using var client = new NamedPipeClientStream(
            ".",
            _settings.WorkerReturnPipeName,
            PipeDirection.Out,
            PipeOptions.Asynchronous);

        try
        {
            await client.ConnectAsync(_settings.ConnectTimeoutMs, cancellationToken);

            var payload = JsonSerializer.Serialize(value, WorkerJson.Options) + "\n";
            var bytes = Encoding.UTF8.GetBytes(payload);

            await client.WriteAsync(bytes, cancellationToken);
            await client.FlushAsync(cancellationToken);

            _logger.LogInformation(
                "[PIPE → Node] Sent {type} to {pipe}",
                type,
                _settings.WorkerReturnPipeName);

            return true;
        }
        catch (TimeoutException ex)
        {
            _logger.LogWarning(
                ex,
                "[PIPE → Node] Connect timeout on {pipe} — Node.js may not be running",
                _settings.WorkerReturnPipeName);
            return false;
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogWarning(
                ex,
                "[PIPE → Node] Access denied connecting to {pipe}; ensure Node.js and the worker run under compatible Windows identities",
                _settings.WorkerReturnPipeName);
            return false;
        }
        catch (IOException ex)
        {
            _logger.LogWarning(
                ex,
                "[PIPE → Node] Failed to send event to {pipe}",
                _settings.WorkerReturnPipeName);
            return false;
        }
    }
}
