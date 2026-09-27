using System;
using System.Diagnostics;
using System.Runtime.Versioning;
using System.ServiceProcess;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.Windows.PrinterMonitoring;

[SupportedOSPlatform("windows")]
public class ServiceControllerSpoolerController : IPrintSpoolerController
{
    private readonly PrinterRecoverySettings _settings;
    private readonly ILogger<ServiceControllerSpoolerController>? _logger;

    public ServiceControllerSpoolerController(
        IOptions<PrinterRecoverySettings> settings,
        ILogger<ServiceControllerSpoolerController>? logger = null)
    {
        _settings = settings?.Value ?? new PrinterRecoverySettings();
        _logger = logger;
    }

    public Task<SpoolerStatusSnapshot> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        try
        {
            using var controller = new ServiceController(_settings.ServiceName);
            controller.Refresh();
            var status = controller.Status;
            return Task.FromResult(new SpoolerStatusSnapshot
            {
                IsRunning = status == ServiceControllerStatus.Running,
                Status = status.ToString(),
                ErrorMessage = null
            });
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Failed to query status for service '{ServiceName}'", _settings.ServiceName);
            return Task.FromResult(new SpoolerStatusSnapshot
            {
                IsRunning = false,
                Status = "Unknown",
                ErrorMessage = ex.Message
            });
        }
    }

    public async Task<SpoolerRestartResult> RestartAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var serviceName = _settings.ServiceName;
        var timeout = TimeSpan.FromSeconds(Math.Max(1, _settings.SpoolerTransitionTimeoutSeconds));

        try
        {
            using var controller = new ServiceController(serviceName);
            controller.Refresh();

            _logger?.LogInformation(
                "Initiating restart of service '{ServiceName}'. Current status: {Status}",
                serviceName,
                controller.Status);

            var stopwatch = Stopwatch.StartNew();

            // 1. If service is not stopped, request stop and wait for it
            if (controller.Status != ServiceControllerStatus.Stopped)
            {
                if (controller.Status != ServiceControllerStatus.StopPending && controller.CanStop)
                {
                    controller.Stop();
                }

                while (controller.Status != ServiceControllerStatus.Stopped)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    if (stopwatch.Elapsed > timeout)
                    {
                        var msg = $"Timed out after {timeout.TotalSeconds}s waiting for service '{serviceName}' to stop. Current status: {controller.Status}.";
                        _logger?.LogError("{Message}", msg);
                        return new SpoolerRestartResult
                        {
                            Success = false,
                            Error = msg,
                            FinalStatus = controller.Status.ToString()
                        };
                    }

                    await Task.Delay(200, cancellationToken);
                    controller.Refresh();
                }
            }

            _logger?.LogInformation("Service '{ServiceName}' stopped. Starting service...", serviceName);

            // Reset timer for start transition
            stopwatch.Restart();

            // 2. Start the service and wait for Running
            if (controller.Status != ServiceControllerStatus.Running)
            {
                if (controller.Status != ServiceControllerStatus.StartPending)
                {
                    controller.Start();
                }

                while (controller.Status != ServiceControllerStatus.Running)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    if (stopwatch.Elapsed > timeout)
                    {
                        var msg = $"Timed out after {timeout.TotalSeconds}s waiting for service '{serviceName}' to start. Current status: {controller.Status}.";
                        _logger?.LogError("{Message}", msg);
                        return new SpoolerRestartResult
                        {
                            Success = false,
                            Error = msg,
                            FinalStatus = controller.Status.ToString()
                        };
                    }

                    await Task.Delay(200, cancellationToken);
                    controller.Refresh();
                }
            }

            _logger?.LogInformation("Service '{ServiceName}' restarted successfully and is Running.", serviceName);

            return new SpoolerRestartResult
            {
                Success = true,
                Error = null,
                FinalStatus = controller.Status.ToString()
            };
        }
        catch (OperationCanceledException)
        {
            _logger?.LogWarning("Restart of service '{ServiceName}' was cancelled.", serviceName);
            return new SpoolerRestartResult
            {
                Success = false,
                Error = $"Restart of service '{serviceName}' was cancelled.",
                FinalStatus = "Cancelled"
            };
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Exception encountered while restarting service '{ServiceName}'", serviceName);
            return new SpoolerRestartResult
            {
                Success = false,
                Error = ex.Message,
                FinalStatus = "Error"
            };
        }
    }

    public async Task<SpoolerRestartResult> StartAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var serviceName = _settings.ServiceName;
        var timeout = TimeSpan.FromSeconds(Math.Max(1, _settings.SpoolerTransitionTimeoutSeconds));

        try
        {
            using var controller = new ServiceController(serviceName);
            controller.Refresh();
            if (controller.Status == ServiceControllerStatus.Running)
            {
                return new SpoolerRestartResult { Success = true, FinalStatus = controller.Status.ToString() };
            }

            if (controller.Status != ServiceControllerStatus.StartPending)
            {
                controller.Start();
            }

            var stopwatch = Stopwatch.StartNew();
            while (controller.Status != ServiceControllerStatus.Running)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (stopwatch.Elapsed > timeout)
                {
                    var message = $"Timed out after {timeout.TotalSeconds}s waiting for service '{serviceName}' to start. Current status: {controller.Status}.";
                    return new SpoolerRestartResult { Success = false, Error = message, FinalStatus = controller.Status.ToString() };
                }

                await Task.Delay(200, cancellationToken);
                controller.Refresh();
            }

            return new SpoolerRestartResult { Success = true, FinalStatus = controller.Status.ToString() };
        }
        catch (OperationCanceledException)
        {
            return new SpoolerRestartResult { Success = false, Error = $"Start of service '{serviceName}' was cancelled.", FinalStatus = "Cancelled" };
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Exception encountered while starting service '{ServiceName}'", serviceName);
            return new SpoolerRestartResult { Success = false, Error = ex.Message, FinalStatus = "Error" };
        }
    }
}
