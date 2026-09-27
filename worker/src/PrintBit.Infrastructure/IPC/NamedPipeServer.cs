using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace PrintBit.Infrastructure.IPC;

public class NamedPipeServer : INamedPipeServer
{
    private const string PipeName = "printbit.hardware";

    private readonly ILogger<NamedPipeServer> _logger;

    private readonly List<NamedPipeServerStream> _clients = [];

    private readonly object _clientsLock = new();

    public event Func<PipeMessage, CancellationToken, Task>? MessageReceived;

    public NamedPipeServer(
        ILogger<NamedPipeServer> logger)
    {
        _logger = logger;
    }

    public Task StartAsync(
        CancellationToken cancellationToken = default)
    {
        _ = AcceptClientsAsync(cancellationToken);
        return Task.CompletedTask;
    }

    public async Task BroadcastAsync(
        PipeMessage message,
        CancellationToken cancellationToken = default)
    {
        var json = JsonSerializer.Serialize(message);
        var bytes = Encoding.UTF8.GetBytes(json + "\n");
        var disconnectedClients = new List<NamedPipeServerStream>();
        List<NamedPipeServerStream> connectedClients;

        lock (_clientsLock)
        {
            connectedClients = [.. _clients];
        }

        foreach (var client in connectedClients)
        {
            try
            {
                if (!client.IsConnected)
                {
                    disconnectedClients.Add(client);
                    continue;
                }

                await client.WriteAsync(bytes, cancellationToken);
                await client.FlushAsync(cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "Named pipe broadcast failed for a client; disconnecting");

                disconnectedClients.Add(client);
            }
        }

        foreach (var disconnected in disconnectedClients)
        {
            RemoveClient(disconnected);
        }
    }

    private async Task AcceptClientsAsync(
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var server = new NamedPipeServerStream(
                PipeName,
                PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);

            try
            {
                await server.WaitForConnectionAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                server.Dispose();
                break;
            }

            lock (_clientsLock)
            {
                _clients.Add(server);
            }

            _logger.LogInformation("Named pipe client connected");

            _ = ReadClientMessagesAsync(server, cancellationToken);
        }
    }

    private async Task ReadClientMessagesAsync(
        NamedPipeServerStream client,
        CancellationToken cancellationToken)
    {
        try
        {
            using var reader = new StreamReader(
                client,
                Encoding.UTF8,
                detectEncodingFromByteOrderMarks: false,
                bufferSize: 1024,
                leaveOpen: true);

            while (!cancellationToken.IsCancellationRequested && client.IsConnected)
            {
                var line = await reader.ReadLineAsync();

                if (string.IsNullOrWhiteSpace(line))
                {
                    if (line is null)
                    {
                        break;
                    }

                    continue;
                }

                PipeMessage? message = null;

                try
                {
                    message = JsonSerializer.Deserialize<PipeMessage>(line);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        ex,
                        "Invalid named pipe message payload: {payload}",
                        line);
                }

                if (message is null || MessageReceived is null)
                {
                    continue;
                }

                await MessageReceived.Invoke(
                    message,
                    cancellationToken);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "Named pipe client read loop terminated");
        }
        finally
        {
            RemoveClient(client);
        }
    }

    private void RemoveClient(
        NamedPipeServerStream client)
    {
        lock (_clientsLock)
        {
            _clients.Remove(client);
        }

        try
        {
            client.Dispose();
        }
        catch
        {
        }
    }
}
