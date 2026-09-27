using System.IO.Pipes;
using System.Text;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.IPC;
using PrintBit.Shared.Configurations;

namespace PrintBit.HardwareService.Services;

public sealed class ErrorPipeHostedService : BackgroundService
{
    private const int PreviewLength = 200;

    private readonly ILogger<ErrorPipeHostedService> _logger;

    private readonly IpcSettings _settings;

    public ErrorPipeHostedService(
        ILogger<ErrorPipeHostedService> logger,
        IOptions<IpcSettings> options)
    {
        _logger = logger;
        _settings = options.Value;
    }

    protected override async Task ExecuteAsync(
        CancellationToken stoppingToken)
    {
        _logger.LogInformation(
            "Node error pipe listener started on {pipe}",
            _settings.PipeName);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var server = NamedPipeServerFactory.Create(
                    _settings.PipeName,
                    PipeDirection.In,
                    maxNumberOfServerInstances: 1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                try
                {
                    await server.WaitForConnectionAsync(stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }

                _logger.LogInformation("Node error pipe client connected");

                try
                {
                    using var reader = new StreamReader(
                        server,
                        Encoding.UTF8,
                        detectEncodingFromByteOrderMarks: true,
                        bufferSize: 1024,
                        leaveOpen: true);

                    while (!stoppingToken.IsCancellationRequested && server.IsConnected)
                    {
                        var line = await reader.ReadLineAsync(stoppingToken);

                        if (line is null)
                        {
                            break;
                        }

                        if (string.IsNullOrWhiteSpace(line))
                        {
                            continue;
                        }

                        if (!NodeErrorMessageParser.TryParse(
                                line,
                                _settings.MaxMessageBytes,
                                out var message,
                                out var errorCode))
                        {
                            LogParseWarning(errorCode, line, _settings.MaxMessageBytes);
                            continue;
                        }

                        // NodeErrorMessageParser.TryParse guarantees `message` is
                        // non-null when it returns true (the MissingMessage path
                        // nulls it and returns false). The `!` here is a hint to
                        // the nullable-flow analyzer, which can't see across the
                        // `continue` short-circuit above.
                        _logger.LogError(
                            "Node error | Source={source} Code={code} Message={message} TransactionId={transactionId} SpoolerCorrelationKey={spoolerKey} TimestampUtc={timestampUtc} Stack={stack}",
                            message!.Source ?? "unknown",
                            message.Code ?? "unknown",
                            message.Message,
                            message.TransactionId,
                            message.SpoolerCorrelationKey,
                            message.TimestampUtc,
                            message.Stack);
                    }
                }
                catch (IOException ex)
                {
                    _logger.LogInformation(
                        ex,
                        "Node error pipe client disconnected");
                }
            }
            catch (UnauthorizedAccessException)
            {
                _logger.LogWarning(
                    "Node error pipe at {pipe} is already in use. Retrying in 5 seconds...",
                    _settings.PipeName);
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
    }

    private void LogParseWarning(
        string? errorCode,
        string payload,
        int maxBytes)
    {
        var preview = Truncate(payload, PreviewLength);

        switch (errorCode)
        {
            case "PayloadTooLarge":
                _logger.LogWarning(
                    "Node error payload exceeded {limit} bytes; preview={preview}",
                    maxBytes,
                    preview);
                break;
            case "InvalidJson":
                _logger.LogWarning(
                    "Node error payload was invalid JSON; preview={preview}",
                    preview);
                break;
            case "MissingMessage":
                _logger.LogWarning(
                    "Node error payload missing message field; preview={preview}",
                    preview);
                break;
            case "EmptyPayload":
                _logger.LogWarning("Node error payload was empty");
                break;
            default:
                _logger.LogWarning(
                    "Node error payload could not be parsed; preview={preview}",
                    preview);
                break;
        }
    }

    private static string Truncate(
        string value,
        int maxChars)
    {
        if (value.Length <= maxChars)
        {
            return value;
        }

        return value[..maxChars] + "...";
    }
}
