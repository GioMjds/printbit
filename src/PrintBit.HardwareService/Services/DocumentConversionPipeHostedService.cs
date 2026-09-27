using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.DocumentConversion;
using PrintBit.Shared.Configurations;

namespace PrintBit.HardwareService.Services;

public sealed class DocumentConversionPipeHostedService : BackgroundService
{
    private const int MaxMessageBytes = 8192;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly ILogger<DocumentConversionPipeHostedService> _logger;
    private readonly IDocumentConversionService _conversionService;
    private readonly DocumentConversionSettings _settings;

    public DocumentConversionPipeHostedService(
        ILogger<DocumentConversionPipeHostedService> logger,
        IDocumentConversionService conversionService,
        IOptions<DocumentConversionSettings> options)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _conversionService = conversionService ?? throw new ArgumentNullException(nameof(conversionService));
        _settings = options?.Value ?? new DocumentConversionSettings();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation(
            "Document conversion pipe listener starting on {pipe}",
            _settings.PipeName);

        var activeHandlers = new HashSet<Task>();
        var handlersLock = new object();
        NamedPipeServerStream? listeningServer = null;

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    listeningServer ??= CreateListeningServer();
                    await listeningServer.WaitForConnectionAsync(stoppingToken);

                    var connectedServer = listeningServer;
                    listeningServer = CreateListeningServer();

                    var handler = HandleConnectedClientAsync(
                        connectedServer,
                        stoppingToken);
                    TrackHandler(handler, activeHandlers, handlersLock);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (UnauthorizedAccessException ex)
                {
                    _logger.LogWarning(
                        ex,
                        "Document conversion pipe at {pipe} is already in use or access was denied. Retrying in 5 seconds...",
                        _settings.PipeName);

                    listeningServer?.Dispose();
                    listeningServer = null;

                    try
                    {
                        await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                    }
                    catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                    {
                        break;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(
                        ex,
                        "Unexpected error in document conversion pipe listener on {pipe}. Retrying in 1 second...",
                        _settings.PipeName);

                    listeningServer?.Dispose();
                    listeningServer = null;

                    try
                    {
                        await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
                    }
                    catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                    {
                        break;
                    }
                }
            }
        }
        finally
        {
            listeningServer?.Dispose();

            Task[] handlers;
            lock (handlersLock)
            {
                handlers = activeHandlers.ToArray();
            }

            try
            {
                await Task.WhenAll(handlers);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Normal host shutdown.
            }
        }

        _logger.LogInformation(
            "Document conversion pipe listener stopped on {pipe}",
            _settings.PipeName);
    }

    private NamedPipeServerStream CreateListeningServer()
    {
        return NamedPipeServerFactory.Create(
            _settings.PipeName,
            PipeDirection.InOut,
            maxNumberOfServerInstances: NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
    }

    private async Task HandleConnectedClientAsync(
        NamedPipeServerStream server,
        CancellationToken stoppingToken)
    {
        await using (server)
        {
            _logger.LogInformation("Document conversion pipe client connected");

            try
            {
                await ProcessRequestStreamAsync(server, server, stoppingToken);

                if (server.IsConnected && OperatingSystem.IsWindows())
                {
                    try
                    {
                        using var drainCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                        drainCts.CancelAfter(TimeSpan.FromSeconds(2));
                        await Task.Run(server.WaitForPipeDrain, drainCts.Token);
                    }
                    catch (Exception)
                    {
                        // Drain timeout or client already disconnected; proceed to disconnect
                    }
                }
            }
            catch (IOException ex)
            {
                _logger.LogInformation(
                    ex,
                    "Document conversion pipe client disconnected prematurely on {pipe}",
                    _settings.PipeName);
            }
            finally
            {
                if (server.IsConnected)
                {
                    server.Disconnect();
                }
            }
        }
    }

    private static void TrackHandler(
        Task handler,
        ISet<Task> activeHandlers,
        object handlersLock)
    {
        lock (handlersLock)
        {
            activeHandlers.Add(handler);
        }

        _ = handler.ContinueWith(
            t =>
            {
                lock (handlersLock)
                {
                    activeHandlers.Remove(t);
                }
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    public async Task<DocumentConversionResult?> ProcessRequestStreamAsync(
        Stream inputStream,
        Stream outputStream,
        CancellationToken cancellationToken)
    {
        var (line, oversized) = await ReadLineWithLimitAsync(inputStream, MaxMessageBytes, cancellationToken);

        if (line is null && !oversized)
        {
            // Empty stream / EOF without data
            return null;
        }

        DocumentConversionResult result;

        if (oversized || string.IsNullOrWhiteSpace(line))
        {
            result = new DocumentConversionResult
            {
                RequestId = string.Empty,
                Success = false,
                ErrorMessage = "Invalid or empty request"
            };

            _logger.LogWarning("Rejected invalid or empty document conversion request payload (oversized={oversized})", oversized);
        }
        else
        {
            DocumentConversionRequest? request = null;
            try
            {
                request = JsonSerializer.Deserialize<DocumentConversionRequest>(line, JsonOptions);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to deserialize document conversion request JSON");
            }

            if (request is null)
            {
                result = new DocumentConversionResult
                {
                    RequestId = string.Empty,
                    Success = false,
                    ErrorMessage = "Invalid or empty request"
                };
            }
            else
            {
                try
                {
                    result = await _conversionService.ConvertAsync(request, cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Unhandled exception converting document for RequestId={requestId}", request.RequestId);
                    result = new DocumentConversionResult
                    {
                        RequestId = request.RequestId,
                        Success = false,
                        ErrorMessage = $"Conversion error: {ex.Message}"
                    };
                }
            }
        }

        var responseJson = JsonSerializer.Serialize(result, JsonOptions) + "\n";
        var responseBytes = Encoding.UTF8.GetBytes(responseJson);

        await outputStream.WriteAsync(responseBytes, cancellationToken);
        await outputStream.FlushAsync(cancellationToken);

        return result;
    }

    private static async Task<(string? Line, bool Oversized)> ReadLineWithLimitAsync(
        Stream stream,
        int maxBytes,
        CancellationToken cancellationToken)
    {
        using var ms = new MemoryStream();
        var buffer = new byte[1024];
        var totalBytes = 0;
        var oversized = false;
        var foundNewline = false;

        while (true)
        {
            var read = await stream.ReadAsync(buffer, 0, buffer.Length, cancellationToken);
            if (read == 0)
            {
                break;
            }

            var newlineIndex = -1;
            for (var i = 0; i < read; i++)
            {
                if (buffer[i] == (byte)'\n')
                {
                    newlineIndex = i;
                    break;
                }
            }

            if (newlineIndex >= 0)
            {
                foundNewline = true;
                totalBytes += newlineIndex;
                if (totalBytes > maxBytes)
                {
                    oversized = true;
                }
                else
                {
                    ms.Write(buffer, 0, newlineIndex);
                }
                break;
            }
            else
            {
                totalBytes += read;
                if (totalBytes > maxBytes)
                {
                    oversized = true;
                    break;
                }
                ms.Write(buffer, 0, read);
            }
        }

        if (oversized)
        {
            return (null, true);
        }

        if (ms.Length == 0 && totalBytes == 0 && !foundNewline)
        {
            return (null, false);
        }

        var line = Encoding.UTF8.GetString(ms.ToArray()).TrimEnd('\r');
        return (line, false);
    }
}
