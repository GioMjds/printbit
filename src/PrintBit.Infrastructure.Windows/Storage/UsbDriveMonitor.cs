using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrintBit.Infrastructure.IPC;

namespace PrintBit.Infrastructure.Windows.Storage;

public sealed class UsbDriveMonitor : BackgroundService, IUsbStorageService
{
    private readonly ILogger<UsbDriveMonitor> _logger;
    private readonly IWorkerEventPipeClient _eventPipe;

    public UsbDriveMonitor(ILogger<UsbDriveMonitor> logger, IWorkerEventPipeClient eventPipe)
    {
        _logger = logger;
        _eventPipe = eventPipe;
    }

    public Task<IReadOnlyList<RemovableDrive>> ListRemovableAsync(CancellationToken cancellationToken)
    {
        _logger.LogDebug("UsbDriveMonitor.ListRemovableAsync called (scaffold placeholder)");
        return Task.FromResult<IReadOnlyList<RemovableDrive>>([]);
    }

    public Task<UsbExportResult> ExportAsync(string sourcePath, string drive, CancellationToken cancellationToken)
    {
        _logger.LogDebug("UsbDriveMonitor.ExportAsync called for {Source} -> {Drive} (scaffold placeholder)", sourcePath, drive);
        return Task.FromResult(new UsbExportResult(
            Success: false,
            ExportPath: null,
            Drive: drive,
            ErrorCode: "NOT_IMPLEMENTED",
            Message: "USB storage service is scaffolded and not yet implemented."));
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogDebug("UsbDriveMonitor hosted service started in dormant scaffold mode (no polling).");
        return Task.CompletedTask;
    }
}