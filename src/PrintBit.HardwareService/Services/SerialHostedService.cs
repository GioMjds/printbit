using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.Services.SerialService;
using PrintBit.Shared.Configurations;

namespace PrintBit.HardwareService.Services;

public class SerialHostedService : BackgroundService
{
    public const int SERIAL_RECONNECT_BASE_MS = 2000;
    public const int SERIAL_RECONNECT_MAX_MS = 30000;
    public const int SERIAL_MONITOR_INTERVAL_MS = 1000;

    private readonly ISerialConnection _serialConnection;
    private readonly HardwareSettings _settings;
    private readonly ILogger<SerialHostedService> _logger;
    private readonly Func<int, CancellationToken, Task> _delayFunc;

    public SerialHostedService(
        ISerialConnection serialConnection,
        IOptions<HardwareSettings> settings,
        ILogger<SerialHostedService> logger)
        : this(serialConnection, settings, logger, Task.Delay)
    {
    }

    public SerialHostedService(
        ISerialConnection serialConnection,
        IOptions<HardwareSettings> settings,
        ILogger<SerialHostedService> logger,
        Func<int, CancellationToken, Task> delayFunc)
    {
        _serialConnection = serialConnection;
        _settings = settings.Value;
        _logger = logger;
        _delayFunc = delayFunc;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        int currentDelay = SERIAL_RECONNECT_BASE_MS;

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!_serialConnection.IsConnected)
                {
                    _logger.LogInformation(
                        "Attempting to connect to serial port {Port} at {BaudRate} baud",
                        _settings.Esp32Port,
                        _settings.Esp32BaudRate);

                    try
                    {
                        _serialConnection.Connect(_settings.Esp32Port, _settings.Esp32BaudRate);
                        if (_serialConnection.IsConnected)
                        {
                            _logger.LogInformation("Successfully connected to serial port {Port}", _settings.Esp32Port);
                            currentDelay = SERIAL_RECONNECT_BASE_MS;
                        }
                        else
                        {
                            _logger.LogWarning(
                                "Serial port connection attempt did not establish connection on {Port}. Retrying in {Delay}ms",
                                _settings.Esp32Port,
                                currentDelay);

                            await _delayFunc(currentDelay, stoppingToken);
                            currentDelay = Math.Min(currentDelay * 2, SERIAL_RECONNECT_MAX_MS);
                            continue;
                        }
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.LogWarning(
                            ex,
                            "Failed to connect to serial port {Port}. Retrying in {Delay}ms",
                            _settings.Esp32Port,
                            currentDelay);

                        await _delayFunc(currentDelay, stoppingToken);
                        currentDelay = Math.Min(currentDelay * 2, SERIAL_RECONNECT_MAX_MS);
                        continue;
                    }
                }

                // If connected, periodically monitor until disconnected or cancelled
                while (!stoppingToken.IsCancellationRequested && _serialConnection.IsConnected)
                {
                    await _delayFunc(SERIAL_MONITOR_INTERVAL_MS, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Unexpected error in SerialHostedService loop");
                try
                {
                    await _delayFunc(currentDelay, stoppingToken);
                    currentDelay = Math.Min(currentDelay * 2, SERIAL_RECONNECT_MAX_MS);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
            }
        }

        DisconnectSafely();
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        DisconnectSafely();
        await base.StopAsync(cancellationToken);
    }

    private void DisconnectSafely()
    {
        try
        {
            if (_serialConnection.IsConnected)
            {
                _serialConnection.Disconnect();
                _logger.LogInformation("Serial connection disconnected cleanly.");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error disconnecting serial connection during shutdown");
        }
    }
}
