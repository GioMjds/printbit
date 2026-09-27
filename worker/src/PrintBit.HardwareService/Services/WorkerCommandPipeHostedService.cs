using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using PrintBit.Application.Services;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Infrastructure.Windows.Scanning;
using PrintBit.Shared.Configurations;

namespace PrintBit.HardwareService.Services;

public sealed class WorkerCommandPipeHostedService : BackgroundService
{
    private readonly ILogger<WorkerCommandPipeHostedService> _logger;
    private readonly IPrinterRecoveryService _recoveryService;
    private readonly IpcSettings _settings;
    private readonly IHardwareOrchestrator? _hardwareOrchestrator;
    private readonly IWorkerEventPipeClient? _eventPipeClient;
    private readonly bool _enableCoinSimulation;
    private readonly IScannerService? _scannerService;
    private readonly WorkerPlatformCommandHandler? _platformCommandHandler;

    public WorkerCommandPipeHostedService(
        ILogger<WorkerCommandPipeHostedService> logger,
        IPrinterRecoveryService recoveryService,
        IOptions<IpcSettings> options,
        IHardwareOrchestrator? hardwareOrchestrator = null,
        IWorkerEventPipeClient? eventPipeClient = null,
        IOptions<HardwareSettings>? hardwareSettings = null,
        IScannerService? scannerService = null,
        WorkerPlatformCommandHandler? platformCommandHandler = null)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _recoveryService = recoveryService ?? throw new ArgumentNullException(nameof(recoveryService));
        _settings = options?.Value ?? new IpcSettings();
        _hardwareOrchestrator = hardwareOrchestrator;
        _eventPipeClient = eventPipeClient;
        _enableCoinSimulation = hardwareSettings?.Value.EnableCoinSimulation ?? false;
        _scannerService = scannerService;
        _platformCommandHandler = platformCommandHandler;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (_settings.WorkerCommandMaxConcurrency is < 1 or > 16)
        {
            throw new InvalidOperationException(
                $"WorkerCommandMaxConcurrency must be between 1 and 16; configured value was {_settings.WorkerCommandMaxConcurrency}.");
        }

        _logger.LogInformation(
            "Worker command pipe listener starting on {pipe} with concurrency {maxConcurrency}",
            _settings.WorkerCommandPipeName,
            _settings.WorkerCommandMaxConcurrency);

        using var handlerSlots = new SemaphoreSlim(
            _settings.WorkerCommandMaxConcurrency,
            _settings.WorkerCommandMaxConcurrency);
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
                    await handlerSlots.WaitAsync(stoppingToken);

                    var handler = HandleConnectedClientAsync(
                        connectedServer,
                        handlerSlots,
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
                        "Worker command pipe at {pipe} is already in use or access was denied. Retrying in 5 seconds...",
                        _settings.WorkerCommandPipeName);

                    listeningServer?.Dispose();
                    listeningServer = null;
                    await DelayAfterListenerFailureAsync(TimeSpan.FromSeconds(5), stoppingToken);
                }
                catch (Exception ex)
                {
                    _logger.LogError(
                        ex,
                        "Unexpected error in worker command pipe listener on {pipe}. Retrying in 1 second...",
                        _settings.WorkerCommandPipeName);

                    listeningServer?.Dispose();
                    listeningServer = null;
                    await DelayAfterListenerFailureAsync(TimeSpan.FromSeconds(1), stoppingToken);
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
            "Worker command pipe listener stopped on {pipe}",
            _settings.WorkerCommandPipeName);
    }

    private NamedPipeServerStream CreateListeningServer()
    {
        return WorkerCommandPipeSecurity.CreateServerStream(
            _settings.WorkerCommandPipeName,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            _settings.WorkerCommandAllowedClientIdentity);
    }

    private async Task HandleConnectedClientAsync(
        NamedPipeServerStream server,
        SemaphoreSlim handlerSlots,
        CancellationToken stoppingToken)
    {
        await using (server)
        {
            _logger.LogInformation("Worker command pipe client connected");

            try
            {
                await ProcessRequestAsync(server, server, stoppingToken);

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
                        // Drain timeout or client already disconnected; proceed to disconnect.
                    }
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Normal host shutdown.
            }
            catch (IOException ex)
            {
                _logger.LogInformation(
                    "Worker command pipe client disconnected on {pipe}: {message}",
                    _settings.WorkerCommandPipeName,
                    ex.Message);
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "Unexpected error handling worker command pipe client on {pipe}",
                    _settings.WorkerCommandPipeName);
            }
            finally
            {
                if (server.IsConnected)
                {
                    try
                    {
                        server.Disconnect();
                    }
                    catch (IOException)
                    {
                        // Client disconnected between the connected check and disconnect.
                    }
                }

                handlerSlots.Release();
            }
        }
    }

    private static void TrackHandler(
        Task handler,
        HashSet<Task> activeHandlers,
        object handlersLock)
    {
        lock (handlersLock)
        {
            activeHandlers.Add(handler);
        }

        _ = handler.ContinueWith(
            completedHandler =>
            {
                lock (handlersLock)
                {
                    activeHandlers.Remove(completedHandler);
                }
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private static async Task DelayAfterListenerFailureAsync(
        TimeSpan delay,
        CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(delay, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Normal host shutdown.
        }
    }

    public async Task<PrinterRecoveryResult?> ProcessRequestAsync(
        Stream inputStream,
        Stream outputStream,
        CancellationToken cancellationToken)
    {
        var startedAt = DateTime.UtcNow;
        var sw = Stopwatch.StartNew();

        var (line, oversized) = await WorkerCommandParser.ReadLineWithLimitAsync(
            inputStream,
            _settings.MaxMessageBytes,
            cancellationToken);

        PrinterRecoveryResult result;

        if (oversized)
        {
            sw.Stop();
            result = new PrinterRecoveryResult
            {
                RequestId = string.Empty,
                Type = PrinterRecoveryCommandType.GetPrinterRecoveryStatus,
                Outcome = PrinterRecoveryOutcome.InvalidRequest,
                Action = null,
                SpoolerState = null,
                PrinterState = null,
                IssueKind = null,
                Message = $"Request payload exceeded maximum allowed size of {_settings.MaxMessageBytes} bytes.",
                StartedAt = startedAt,
                CompletedAt = DateTime.UtcNow
            };

            _logger.LogWarning(
                "Rejected oversized worker command | Outcome={outcome} ElapsedMs={elapsedMs}",
                result.Outcome,
                sw.ElapsedMilliseconds);
        }
        else if (line is null)
        {
            // Empty stream / EOF without data
            return null;
        }
        else
        {
            string? peekType = null;
            try
            {
                using var peekDoc = JsonDocument.Parse(line);
                if (peekDoc.RootElement.ValueKind == JsonValueKind.Object)
                {
                    foreach (var prop in peekDoc.RootElement.EnumerateObject())
                    {
                        if (string.Equals(prop.Name, "type", StringComparison.OrdinalIgnoreCase) &&
                            prop.Value.ValueKind == JsonValueKind.String)
                        {
                            peekType = prop.Value.GetString();
                            break;
                        }
                    }
                }
            }
            catch
            {
                // Malformed JSON -> will be handled by WorkerCommandParser.TryParse below
            }

        if (WorkerCommandParser.IsHardwareCommandType(peekType))
        {
            if (!WorkerCommandParser.TryParseHardwareCommand(
                line,
                _settings.MaxMessageBytes,
                out var hwCommand,
                out var hwError,
                out var hwRequestId,
                out var hwCommandType))
            {
                sw.Stop();
                var errorResponse = new HardwareErrorResponse
                {
                    RequestId = hwRequestId,
                    Type = hwCommandType ?? peekType,
                    Success = false,
                    ErrorCode = "INVALID_REQUEST",
                    Message = hwError ?? "Invalid hardware command request."
                };

                _logger.LogWarning(
                    "Rejected invalid hardware worker command | RequestId={requestId} Type={type} Message={message} ElapsedMs={elapsedMs}",
                    errorResponse.RequestId,
                    errorResponse.Type,
                    errorResponse.Message,
                    sw.ElapsedMilliseconds);

                var errorJson = JsonSerializer.Serialize(errorResponse, WorkerCommandParser.JsonOptions) + "\n";
                await outputStream.WriteAsync(Encoding.UTF8.GetBytes(errorJson), cancellationToken);
                await outputStream.FlushAsync(cancellationToken);
                return null;
            }

                if (hwCommand is GetDefenderHealthCommand or
                        ScanFileSecurityCommand or
                        ListUsbDrivesCommand or
                        ExportScanToUsbCommand or
                        GetTrustedTimeStatusCommand or
                        PrepareHotspotPlatformCommand)
                {
                    if (_platformCommandHandler == null)
                    {
                        sw.Stop();
                        var unavailableResponse = new HardwareErrorResponse
                        {
                            RequestId = hwCommand.RequestId,
                            Type = peekType,
                            Success = false,
                            ErrorCode = "PLATFORM_HANDLER_UNAVAILABLE",
                            Message = "Platform command handler is not configured or available."
                        };

                        var unavailJson = JsonSerializer.Serialize(unavailableResponse, WorkerCommandParser.JsonOptions) + "\n";
                        await outputStream.WriteAsync(Encoding.UTF8.GetBytes(unavailJson), cancellationToken);
                        await outputStream.FlushAsync(cancellationToken);
                        return null;
                    }

                    var platformResponse = await _platformCommandHandler.HandleAsync(hwCommand, cancellationToken);
                    sw.Stop();

                    _logger.LogInformation(
                        "Executed platform worker command | Type={type} RequestId={requestId} ElapsedMs={elapsedMs}",
                        peekType,
                        hwCommand.RequestId,
                        sw.ElapsedMilliseconds);

                    var platformJson = JsonSerializer.Serialize(platformResponse, WorkerCommandParser.JsonOptions) + "\n";
                    await outputStream.WriteAsync(Encoding.UTF8.GetBytes(platformJson), cancellationToken);
                    await outputStream.FlushAsync(cancellationToken);
                    return null;
                }

                if (_hardwareOrchestrator == null)
            {
                sw.Stop();
                var unavailableResponse = new HardwareErrorResponse
                {
                    RequestId = hwCommand.RequestId,
                    Type = peekType,
                    Success = false,
                    ErrorCode = "HARDWARE_ORCHESTRATOR_UNAVAILABLE",
                    Message = "Hardware orchestrator is not configured or available."
                };

                _logger.LogWarning(
                    "Rejected hardware worker command (orchestrator unavailable) | RequestId={requestId} Type={type} ElapsedMs={elapsedMs}",
                    unavailableResponse.RequestId,
                    unavailableResponse.Type,
                    sw.ElapsedMilliseconds);

                var unavailJson = JsonSerializer.Serialize(unavailableResponse, WorkerCommandParser.JsonOptions) + "\n";
                await outputStream.WriteAsync(Encoding.UTF8.GetBytes(unavailJson), cancellationToken);
                await outputStream.FlushAsync(cancellationToken);
                return null;
            }

            string hwResponseJson;
            try
            {
                switch (hwCommand)
                {
                    case SimulateCoinCommand simulateCmd:
                        var simulationResponse = await SimulateCoinAsync(simulateCmd, cancellationToken);
                        hwResponseJson = JsonSerializer.Serialize(simulationResponse, WorkerCommandParser.JsonOptions) + "\n";
                        break;

                    case DispenseCoinsCommand dispenseCmd:
                        var dispenseResult = await _hardwareOrchestrator.DispenseCoinsAsync(
                            dispenseCmd.RequestId,
                            dispenseCmd.CoinCount,
                            dispenseCmd.TimeoutMs,
                            cancellationToken);

                        var dispenseResponse = new DispenseCoinsResponse
                        {
                            RequestId = dispenseCmd.RequestId,
                            Type = "DispenseCoins",
                            Success = dispenseResult.Success,
                            DispensedCoins = dispenseResult.DispensedCoins,
                            ErrorCode = dispenseResult.ErrorCode,
                            Message = dispenseResult.Message
                        };
                        hwResponseJson = JsonSerializer.Serialize(dispenseResponse, WorkerCommandParser.JsonOptions) + "\n";
                        break;

                    case LockCoinSlotCommand lockCmd:
                        _hardwareOrchestrator.LockCoinSlot(lockCmd.OwnerId, lockCmd.Reason);
                        var lockResponse = new LockCoinSlotResponse
                        {
                            RequestId = lockCmd.RequestId,
                            Type = "LockCoinSlot",
                            Success = true
                        };
                        hwResponseJson = JsonSerializer.Serialize(lockResponse, WorkerCommandParser.JsonOptions) + "\n";
                        break;

                    case UnlockCoinSlotCommand unlockCmd:
                        var unlocked = _hardwareOrchestrator.UnlockCoinSlot(unlockCmd.OwnerId);
                        var unlockResponse = new UnlockCoinSlotResponse
                        {
                            RequestId = unlockCmd.RequestId,
                            Type = "UnlockCoinSlot",
                            Success = true,
                            Unlocked = unlocked
                        };
                        hwResponseJson = JsonSerializer.Serialize(unlockResponse, WorkerCommandParser.JsonOptions) + "\n";
                        break;

                    case AnnounceKioskIpCommand announceCmd:
                        _hardwareOrchestrator?.AnnounceKioskIp(announceCmd.Ip, announceCmd.Port, announceCmd.Path);
                        var announceResponse = new AnnounceKioskIpResponse
                        {
                            RequestId = announceCmd.RequestId,
                            Type = "AnnounceKioskIp",
                            Success = true
                        };
                        hwResponseJson = JsonSerializer.Serialize(announceResponse, WorkerCommandParser.JsonOptions) + "\n";
                        break;
                    case GetScannerStatusCommand getStatusCmd:
                            if (_scannerService == null)
                            {
                                var unavail = new ScannerStatusResponse
                                {
                                    RequestId = getStatusCmd.RequestId,
                                    Connected = false,
                                    Error = "Scanner service not registered"
                                };
                                hwResponseJson = JsonSerializer.Serialize(unavail, WorkerCommandParser.JsonOptions) + "\n";
                            }
                            else
                            {
                                var status = await _scannerService.GetStatusAsync(cancellationToken);
                                var statusResponse = new ScannerStatusResponse
                                {
                                    RequestId = getStatusCmd.RequestId,
                                    Connected = status.Connected,
                                    Adapter = status.Adapter,
                                    Driver = status.Driver,
                                    DeviceName = status.DeviceName,
                                    Capabilities = status.Capabilities,
                                    Error = status.LastError
                                };
                                hwResponseJson = JsonSerializer.Serialize(statusResponse, WorkerCommandParser.JsonOptions) + "\n";
                            }
                            break;

                    case ProbeScannerCommand probeCmd:
                            if (_scannerService == null)
                            {
                                var unavail = new ScannerStatusResponse
                                {
                                    RequestId = probeCmd.RequestId,
                                    Connected = false,
                                    Error = "Scanner service not registered"
                                };
                                hwResponseJson = JsonSerializer.Serialize(unavail, WorkerCommandParser.JsonOptions) + "\n";
                            }
                            else
                            {
                                var probedCaps = await _scannerService.ProbeCapabilitiesAsync(cancellationToken);
                                var probeStatus = await _scannerService.GetStatusAsync(cancellationToken);
                                var probeResponse = new ScannerStatusResponse
                                {
                                    RequestId = probeCmd.RequestId,
                                    Connected = probeStatus.Connected,
                                    Adapter = probeStatus.Adapter,
                                    Driver = probeStatus.Driver,
                                    DeviceName = probeStatus.DeviceName,
                                    Capabilities = probedCaps,
                                    Error = probeStatus.LastError
                                };
                                hwResponseJson = JsonSerializer.Serialize(probeResponse, WorkerCommandParser.JsonOptions) + "\n";
                            }
                            break;

                    case StartScanCommand scanCmd:
                            if (_scannerService == null)
                            {
                                var unavail = new StartScanResponse
                                {
                                    RequestId = scanCmd.RequestId,
                                    Success = false,
                                    ErrorCode = "SCANNER_UNAVAILABLE",
                                    Message = "Scanner service not registered"
                                };
                                hwResponseJson = JsonSerializer.Serialize(unavail, WorkerCommandParser.JsonOptions) + "\n";
                            }
                            else
                            {
                                if (_eventPipeClient != null)
                                {
                                    await _eventPipeClient.SendAsync(new WorkerPrintEvent
                                    {
                                        Type = WorkerPrintEventType.ScanStarted,
                                        RequestId = scanCmd.RequestId,
                                        Message = $"Scan started ({scanCmd.Source}, {scanCmd.Dpi} DPI, {scanCmd.Format})"
                                    }, cancellationToken);
                                }

                                var scanResult = await _scannerService.ExecuteScanAsync(new ScanRequest
                                {
                                    RequestId = scanCmd.RequestId,
                                    Source = scanCmd.Source,
                                    Dpi = scanCmd.Dpi,
                                    ColorMode = scanCmd.ColorMode,
                                    Format = scanCmd.Format,
                                    PaperSize = scanCmd.PaperSize,
                                    OutputDir = scanCmd.OutputDir
                                }, cancellationToken);

                                if (_eventPipeClient != null)
                                {
                                    await _eventPipeClient.SendAsync(new WorkerPrintEvent
                                    {
                                        Type = scanResult.Success ? WorkerPrintEventType.ScanCompleted : WorkerPrintEventType.ScanFailed,
                                        RequestId = scanCmd.RequestId,
                                        FileName = scanResult.OutputPath,
                                        TotalPages = scanResult.PageCount,
                                        ErrorCode = scanResult.ErrorCode,
                                        Message = scanResult.ErrorMessage ?? (scanResult.Success ? "Scan completed successfully" : "Scan failed")
                                    }, cancellationToken);
                                }

                                var startScanResponse = new StartScanResponse
                                {
                                    RequestId = scanCmd.RequestId,
                                    Success = scanResult.Success,
                                    OutputPath = scanResult.OutputPath,
                                    PageCount = scanResult.PageCount,
                                    Format = scanResult.Format,
                                    ErrorCode = scanResult.ErrorCode,
                                    Message = scanResult.ErrorMessage
                                };
                                hwResponseJson = JsonSerializer.Serialize(startScanResponse, WorkerCommandParser.JsonOptions) + "\n";
                            }
                            break;

                    case CancelScanCommand cancelCmd:
                            if (_scannerService == null)
                            {
                                var cancelResponse = new CancelScanResponse
                                {
                                    RequestId = cancelCmd.RequestId,
                                    Success = false,
                                    Message = "Scanner service not registered"
                                };
                                hwResponseJson = JsonSerializer.Serialize(cancelResponse, WorkerCommandParser.JsonOptions) + "\n";
                            }
                            else
                            {
                                var cancelled = await _scannerService.CancelScanAsync(cancelCmd.TargetRequestId);
                                var cancelResponse = new CancelScanResponse
                                {
                                    RequestId = cancelCmd.RequestId,
                                    Success = cancelled,
                                    Message = cancelled ? "Scan cancellation requested" : "Scan not found or already completed"
                                };
                                hwResponseJson = JsonSerializer.Serialize(cancelResponse, WorkerCommandParser.JsonOptions) + "\n";
                            }
                            break;

                        default:
                        var fallbackResponse = new HardwareErrorResponse
                        {
                            RequestId = hwCommand.RequestId,
                            Type = peekType,
                            Success = false,
                            ErrorCode = "UNSUPPORTED_COMMAND",
                            Message = $"Unsupported hardware command: {peekType}"
                        };
                        hwResponseJson = JsonSerializer.Serialize(fallbackResponse, WorkerCommandParser.JsonOptions) + "\n";
                        break;
                }
            }
            catch (Exception ex)
            {
                sw.Stop();
                _logger.LogError(
                    ex,
                    "Unexpected error executing hardware worker command | RequestId={requestId} Type={type} ElapsedMs={elapsedMs}",
                    hwCommand.RequestId,
                    peekType,
                    sw.ElapsedMilliseconds);

                var errorResponse = new HardwareErrorResponse
                {
                    RequestId = hwCommand.RequestId,
                    Type = peekType,
                    Success = false,
                    ErrorCode = "COMMAND_EXECUTION_ERROR",
                    Message = ex.Message
                };

                var errorJson = JsonSerializer.Serialize(errorResponse, WorkerCommandParser.JsonOptions) + "\n";
                await outputStream.WriteAsync(Encoding.UTF8.GetBytes(errorJson), cancellationToken);
                await outputStream.FlushAsync(cancellationToken);
                return null;
            }

            sw.Stop();
            _logger.LogInformation(
                "Executed hardware worker command | Type={type} RequestId={requestId} ElapsedMs={elapsedMs}",
                peekType,
                hwCommand.RequestId,
                sw.ElapsedMilliseconds);

            try
            {
                var hwResponseBytes = Encoding.UTF8.GetBytes(hwResponseJson);
                await outputStream.WriteAsync(hwResponseBytes, cancellationToken);
                await outputStream.FlushAsync(cancellationToken);
            }
            catch (IOException ex)
            {
                _logger.LogDebug(
                    "Worker command pipe client disconnected before hardware response could be delivered | Type={type} RequestId={requestId}: {message}",
                    peekType,
                    hwCommand.RequestId,
                    ex.Message);
            }
            return null;
        }
        else if (!WorkerCommandParser.TryParse(
            line,
            _settings.MaxMessageBytes,
            out var command,
            out var errorDetail,
            out var requestId))
        {
            sw.Stop();
            result = new PrinterRecoveryResult
            {
                RequestId = requestId,
                Type = PrinterRecoveryCommandType.GetPrinterRecoveryStatus,
                Outcome = PrinterRecoveryOutcome.InvalidRequest,
                Action = null,
                SpoolerState = null,
                PrinterState = null,
                IssueKind = null,
                Message = errorDetail ?? "Invalid command request.",
                StartedAt = startedAt,
                CompletedAt = DateTime.UtcNow
            };

            _logger.LogWarning(
                "Rejected invalid worker command | RequestId={requestId} Outcome={outcome} Message={message} ElapsedMs={elapsedMs}",
                result.RequestId,
                result.Outcome,
                result.Message,
                sw.ElapsedMilliseconds);
        }
        else
        {
            // Valid command -> Dispatch to recovery service
            PrinterRecoveryResult serviceResult;

            if (command.Type == PrinterRecoveryCommandType.GetPrinterRecoveryStatus)
            {
                serviceResult = await _recoveryService.GetStatusAsync(cancellationToken);
            }
            else if (command.Type == PrinterRecoveryCommandType.AttemptPrinterRecovery)
            {
                serviceResult = await _recoveryService.AttemptRepairAsync(cancellationToken);
            }
            else if (command.Type == PrinterRecoveryCommandType.RestartPrintSpooler)
            {
                serviceResult = await _recoveryService.RestartSpoolerAsync(command.PrinterName, cancellationToken);
            }
            else
            {
                serviceResult = new PrinterRecoveryResult
                {
                    RequestId = command.RequestId,
                    Type = command.Type,
                    Outcome = PrinterRecoveryOutcome.InvalidRequest,
                    Action = null,
                    SpoolerState = null,
                    PrinterState = null,
                    IssueKind = null,
                    Message = $"Unsupported command type: {command.Type}",
                    StartedAt = startedAt,
                    CompletedAt = DateTime.UtcNow
                };
            }

            sw.Stop();

            // Ensure RequestId matches incoming command
            result = new PrinterRecoveryResult
            {
                RequestId = command.RequestId,
                Type = serviceResult.Type,
                Outcome = serviceResult.Outcome,
                Action = serviceResult.Action,
                SpoolerState = serviceResult.SpoolerState,
                PrinterState = serviceResult.PrinterState,
                IssueKind = serviceResult.IssueKind,
                Message = serviceResult.Message,
                StartedAt = serviceResult.StartedAt,
                CompletedAt = serviceResult.CompletedAt
            };

            _logger.LogInformation(
                "Executed worker command | Type={type} RequestId={requestId} Outcome={outcome} ElapsedMs={elapsedMs}",
                result.Type,
                result.RequestId,
                result.Outcome,
                sw.ElapsedMilliseconds);
        }
    }

    var responseJson = JsonSerializer.Serialize(result, WorkerCommandParser.JsonOptions) + "\n";
    var responseBytes = Encoding.UTF8.GetBytes(responseJson);

    try
    {
        await outputStream.WriteAsync(responseBytes, cancellationToken);
        await outputStream.FlushAsync(cancellationToken);
    }
    catch (IOException ex)
    {
        _logger.LogDebug(
            "Worker command pipe client disconnected before recovery response could be delivered: {message}",
            ex.Message);
    }

    return result;
}

    private async Task<HardwareCommandResponse> SimulateCoinAsync(
        SimulateCoinCommand command, CancellationToken cancellationToken)
    {
        var response = new HardwareCommandResponse { RequestId = command.RequestId, Type = "SimulateCoin" };
        if (!_enableCoinSimulation)
        {
            return response with { ErrorCode = "SIMULATION_DISABLED",
                Message = "Enable HardwareSettings:EnableCoinSimulation in the worker to use SCC." };
        }

        // Inject a denomination at the hardware-event boundary. No serial device is required,
        // so physical coin-slot session locks do not apply to an enabled admin simulation.
        _logger.LogInformation("[SIMULATED] Coin accepted: {Amount} | RequestId={RequestId}",
            command.CoinValue, command.RequestId);
        var evt = new WorkerPrintEvent
        {
            Type = WorkerPrintEventType.CoinInserted,
            RequestId = command.RequestId,
            CoinValue = command.CoinValue,
            Simulated = true,
            TimestampUtc = DateTime.UtcNow
        };
        var delivered = _eventPipeClient != null && await _eventPipeClient.SendAsync(evt, cancellationToken);
        if (!delivered)
        {
            return response with { ErrorCode = "WORKER_EVENT_UNAVAILABLE",
                Message = "Could not deliver the simulated coin event to Node. Check the return pipe." };
        }
        return response with { Success = true, Message = "Simulated coin event sent to Node." };
    }
}
