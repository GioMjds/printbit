using System.Collections.Concurrent;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.Windows.Scanning;

public sealed class StubScannerService : IScannerService
{
    private readonly ILogger<StubScannerService> _logger;
    private readonly ScannerSettings _settings;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _activeScans = new();

    public StubScannerService(ILogger<StubScannerService> logger, IOptions<ScannerSettings> settings)
    {
        _logger = logger;
        _settings = settings.Value;
    }

    public Task<ScannerRuntimeStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        return Task.FromResult(new ScannerRuntimeStatus
        {
            Connected = true,
            Adapter = "stub",
            Driver = "stub",
            DeviceName = "Stub Scanner (Dev Fallback)",
            PreferredName = _settings.PreferredScannerName,
            Capabilities = new ScannerCapabilities { Available = true },
            UsingStub = true,
            LastCheckedAt = DateTime.UtcNow,
            LastError = null
        });
    }

    public Task<ScannerCapabilities> ProbeCapabilitiesAsync(CancellationToken cancellationToken = default)
    {
        return Task.FromResult(new ScannerCapabilities
        {
            Available = true,
            Sources = ["flatbed", "adf"],
            ColorModes = ["colored", "grayscale"],
            DpiOptions = [150, 300, 600],
            Duplex = false
        });
    }

    public async Task<ScanResult> ExecuteScanAsync(ScanRequest request, CancellationToken cancellationToken = default)
    {
        var targetDir = string.IsNullOrWhiteSpace(request.OutputDir)
            ? Path.GetFullPath(_settings.ScanOutputDir)
            : Path.GetFullPath(request.OutputDir);

        Directory.CreateDirectory(targetDir);

        var ext = request.Format.ToLowerInvariant() switch
        {
            "jpg" => "jpg",
            "png" => "png",
            _ => "pdf"
        };

        var fileName = $"stub-scan-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.{ext}";
        var outputPath = Path.Combine(targetDir, fileName);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _activeScans[request.RequestId] = cts;

        try
        {
            _logger.LogInformation("[STUB-SCAN] Starting simulated scan job {requestId} -> {path}", request.RequestId, outputPath);
            await Task.Delay(2000, cts.Token);

            // Write mock image/pdf content
            await File.WriteAllTextAsync(outputPath, "Stub scan artifact content created by PrintBit.HardwareService", Encoding.UTF8, cts.Token);

            _logger.LogInformation("[STUB-SCAN] Completed simulated scan job {requestId}", request.RequestId);
            return new ScanResult
            {
                Success = true,
                OutputPath = outputPath,
                PageCount = 1,
                Format = ext
            };
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("[STUB-SCAN] Scan job {requestId} cancelled", request.RequestId);
            if (File.Exists(outputPath))
            {
                File.Delete(outputPath);
            }
            return new ScanResult
            {
                Success = false,
                ErrorCode = "CANCELLED",
                ErrorMessage = "Scan was cancelled by user or timeout"
            };
        }
        finally
        {
            _activeScans.TryRemove(request.RequestId, out _);
        }
    }

    public Task<bool> CancelScanAsync(string requestId)
    {
        if (_activeScans.TryGetValue(requestId, out var cts))
        {
            cts.Cancel();
            return Task.FromResult(true);
        }
        return Task.FromResult(false);
    }
}