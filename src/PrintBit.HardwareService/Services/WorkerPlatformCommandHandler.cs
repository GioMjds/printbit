using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Windows.Networking;
using PrintBit.Infrastructure.Windows.Security;
using PrintBit.Infrastructure.Windows.Storage;
using PrintBit.Infrastructure.Windows.Time;

namespace PrintBit.HardwareService.Services;

public sealed class WorkerPlatformCommandHandler
{
    private readonly IAntivirusScanner _antivirusScanner;
    private readonly IUsbStorageService _usbStorageService;
    private readonly ITrustedTimeProvider _trustedTimeProvider;
    private readonly IKioskNetworkPlatform _networkPlatform;
    private readonly ILogger<WorkerPlatformCommandHandler> _logger;

    public WorkerPlatformCommandHandler(
        IAntivirusScanner antivirusScanner,
        IUsbStorageService usbStorageService,
        ITrustedTimeProvider trustedTimeProvider,
        IKioskNetworkPlatform networkPlatform,
        ILogger<WorkerPlatformCommandHandler> logger)
    {
        _antivirusScanner = antivirusScanner ?? throw new ArgumentNullException(nameof(antivirusScanner));
        _usbStorageService = usbStorageService ?? throw new ArgumentNullException(nameof(usbStorageService));
        _trustedTimeProvider = trustedTimeProvider ?? throw new ArgumentNullException(nameof(trustedTimeProvider));
        _networkPlatform = networkPlatform ?? throw new ArgumentNullException(nameof(networkPlatform));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task<object> HandleAsync(WorkerHardwareCommand command, CancellationToken cancellationToken)
    {
        try
        {
            switch (command)
            {
                case GetDefenderHealthCommand defHealthCmd:
                    {
                        var health = await _antivirusScanner.GetHealthAsync(cancellationToken);
                        return new DefenderHealthResponse
                        {
                            RequestId = defHealthCmd.RequestId,
                            Type = "GetDefenderHealth",
                            Success = string.IsNullOrEmpty(health.ErrorCode),
                            Status = health.Status,
                            SignatureAgeHours = health.SignatureAgeHours,
                            Detail = health.Detail,
                            ErrorCode = health.ErrorCode
                        };
                    }

                case ScanFileSecurityCommand scanSecCmd:
                    {
                        var scan = await _antivirusScanner.ScanFileAsync(scanSecCmd.FilePath, cancellationToken);
                        return new FileSecurityScanResponse
                        {
                            RequestId = scanSecCmd.RequestId,
                            Type = "ScanFileSecurity",
                            Success = string.IsNullOrEmpty(scan.ErrorCode),
                            Status = scan.Status,
                            DetectionName = scan.DetectionName,
                            Detail = scan.Detail,
                            ErrorCode = scan.ErrorCode
                        };
                    }

                case ListUsbDrivesCommand listUsbCmd:
                    {
                        var drives = await _usbStorageService.ListRemovableAsync(cancellationToken);
                        var workerDrives = drives.Select(d => new WorkerUsbDrive(d.Drive, d.Label, d.FreeBytes, d.TotalBytes)).ToList();
                        return new ListUsbDrivesResponse
                        {
                            RequestId = listUsbCmd.RequestId,
                            Type = "ListUsbDrives",
                            Success = true,
                            Drives = workerDrives
                        };
                    }

                case ExportScanToUsbCommand exportUsbCmd:
                    {
                        var exportResult = await _usbStorageService.ExportAsync(exportUsbCmd.SourcePath, exportUsbCmd.Drive, cancellationToken);
                        return new ExportScanToUsbResponse
                        {
                            RequestId = exportUsbCmd.RequestId,
                            Type = "ExportScanToUsb",
                            Success = exportResult.Success,
                            ExportPath = exportResult.ExportPath,
                            Drive = exportResult.Drive,
                            ErrorCode = exportResult.ErrorCode,
                            Message = exportResult.Message
                        };
                    }

                case GetTrustedTimeStatusCommand timeCmd:
                    {
                        var timeResult = await _trustedTimeProvider.GetStatusAsync(timeCmd.NtpServer, timeCmd.MaxDriftMs, cancellationToken);
                        return new TrustedTimeStatusResponse
                        {
                            RequestId = timeCmd.RequestId,
                            Type = "GetTrustedTimeStatus",
                            Success = string.IsNullOrEmpty(timeResult.ErrorCode),
                            Source = timeResult.Source,
                            Synced = timeResult.Synced,
                            OffsetMs = timeResult.OffsetMs,
                            DriftExceeded = timeResult.DriftExceeded,
                            MaxDriftMs = timeResult.MaxDriftMs,
                            CheckedAt = timeResult.CheckedAt,
                            NtpSource = timeResult.NtpSource,
                            LastSuccessfulSyncAt = timeResult.LastSuccessfulSyncAt,
                            Detail = timeResult.Detail,
                            ErrorCode = timeResult.ErrorCode
                        };
                    }

                case PrepareHotspotPlatformCommand hotspotCmd:
                    {
                        var netResult = await _networkPlatform.PrepareAsync(hotspotCmd.PreferredSubnetPrefixes, hotspotCmd.Port, cancellationToken);
                        return new PrepareHotspotPlatformResponse
                        {
                            RequestId = hotspotCmd.RequestId,
                            Type = "PrepareHotspotPlatform",
                            Success = netResult.Success,
                            KioskIp = netResult.KioskIp,
                            FirewallReady = netResult.FirewallReady,
                            ErrorCode = netResult.ErrorCode,
                            Detail = netResult.Detail
                        };
                    }

                default:
                    throw new NotSupportedException($"Unsupported platform command: {command.GetType().Name}");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error executing platform command {CommandType} (RequestId={RequestId})", command.GetType().Name, command.RequestId);
            return new HardwareErrorResponse
            {
                RequestId = command.RequestId,
                Type = command.GetType().Name,
                Success = false,
                ErrorCode = "PLATFORM_COMMAND_FAILED",
                Message = ex.Message
            };
        }
    }
}