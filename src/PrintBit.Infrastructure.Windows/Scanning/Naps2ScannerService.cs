using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.Windows.Scanning;

public sealed class Naps2ScannerService : IScannerService
{
    private readonly ILogger<Naps2ScannerService> _logger;
    private readonly ScannerSettings _settings;
    private readonly StubScannerService _stubService;
    private readonly ConcurrentDictionary<string, Process> _activeProcesses = new();

    private ScannerRuntimeStatus _lastKnownStatus;

    public Naps2ScannerService(
        ILogger<Naps2ScannerService> logger,
        ILogger<StubScannerService> stubLogger,
        IOptions<ScannerSettings> settings)
    {
        _logger = logger;
        _settings = settings.Value;
        _stubService = new StubScannerService(stubLogger, settings);
        _lastKnownStatus = new ScannerRuntimeStatus
        {
            Connected = false,
            PreferredName = _settings.PreferredScannerName,
            LastError = "Not probed yet"
        };
    }

    private static readonly TimeSpan StatusCacheDuration = TimeSpan.FromSeconds(60);

    public async Task<ScannerRuntimeStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        if (_lastKnownStatus.Connected &&
            !string.IsNullOrWhiteSpace(_lastKnownStatus.DeviceName) &&
            DateTime.UtcNow - _lastKnownStatus.LastCheckedAt < StatusCacheDuration)
        {
            return _lastKnownStatus;
        }

        if (File.Exists(_settings.Naps2Path))
        {
            var caps = await ProbeCapabilitiesAsync(cancellationToken);
            if (caps.Available)
            {
                return _lastKnownStatus;
            }
        }

        if (_settings.EnableStubFallback)
        {
            return await _stubService.GetStatusAsync(cancellationToken);
        }

        return _lastKnownStatus;
    }

    public async Task<ScannerCapabilities> ProbeCapabilitiesAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_settings.Naps2Path))
        {
            _logger.LogWarning("[SCANNER] NAPS2 executable not found at {path}", _settings.Naps2Path);
            _lastKnownStatus = _lastKnownStatus with
            {
                Connected = false,
                Adapter = "naps2",
                LastError = $"NAPS2 executable not found at {_settings.Naps2Path}"
            };

            if (_settings.EnableStubFallback)
            {
                return await _stubService.ProbeCapabilitiesAsync(cancellationToken);
            }

            return new ScannerCapabilities { Available = false };
        }

        foreach (var driver in GetProbeDrivers(_settings.PreferredDriver))
        {
            var devices = await ListDevicesAsync(driver, cancellationToken);
            if (devices.Count > 0)
            {
                var preferred = SelectPreferredDevice(devices, _settings.PreferredScannerName);
                if (!string.IsNullOrEmpty(preferred))
                {
                    _lastKnownStatus = new ScannerRuntimeStatus
                    {
                        Connected = true,
                        Adapter = "naps2",
                        Driver = driver,
                        DeviceName = preferred,
                        PreferredName = _settings.PreferredScannerName,
                        Capabilities = new ScannerCapabilities { Available = true },
                        UsingStub = false,
                        LastCheckedAt = DateTime.UtcNow,
                        LastError = null
                    };

                    _logger.LogInformation("[SCANNER] Connected to {driver} device '{device}'", driver.ToUpperInvariant(), preferred);
                    return _lastKnownStatus.Capabilities!;
                }
            }
        }

        _lastKnownStatus = new ScannerRuntimeStatus
        {
            Connected = false,
            Adapter = "naps2",
            Driver = "none",
            DeviceName = null,
            PreferredName = _settings.PreferredScannerName,
            Capabilities = new ScannerCapabilities { Available = false },
            UsingStub = false,
            LastCheckedAt = DateTime.UtcNow,
            LastError = "No compatible TWAIN or WIA scanner found"
        };

        if (_settings.EnableStubFallback)
        {
            _logger.LogInformation("[SCANNER] No hardware scanner detected; falling back to stub mode");
            return await _stubService.ProbeCapabilitiesAsync(cancellationToken);
        }

        return new ScannerCapabilities { Available = false };
    }

    public async Task<ScanResult> ExecuteScanAsync(ScanRequest request, CancellationToken cancellationToken = default)
    {
        // Reuse known connected status if fresh to avoid 4-5s NAPS2 --listdevices probing overhead
        var status = (_lastKnownStatus.Connected && !string.IsNullOrWhiteSpace(_lastKnownStatus.DeviceName))
            ? _lastKnownStatus
            : await GetStatusAsync(cancellationToken);

        if (status.UsingStub || !File.Exists(_settings.Naps2Path) || !status.Connected)
        {
            if (_settings.EnableStubFallback)
            {
                return await _stubService.ExecuteScanAsync(request, cancellationToken);
            }

            return new ScanResult
            {
                Success = false,
                ErrorCode = "SCANNER_UNAVAILABLE",
                ErrorMessage = status.LastError ?? "Scanner is unavailable"
            };
        }

        var outputDir = string.IsNullOrWhiteSpace(request.OutputDir)
            ? Path.GetFullPath(_settings.ScanOutputDir)
            : Path.GetFullPath(request.OutputDir);

        Directory.CreateDirectory(outputDir);

        var ext = request.Format.ToLowerInvariant() switch
        {
            "jpg" => "jpg",
            "png" => "png",
            _ => "pdf"
        };

        var fileName = $"scan-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.{ext}";
        var outputPath = Path.Combine(outputDir, fileName);

        var args = BuildNaps2Args(
            outputPath,
            status.Driver,
            status.DeviceName!,
            request.Source,
            request.Dpi,
            request.ColorMode,
            request.PaperSize);

        var psi = new ProcessStartInfo
        {
            FileName = _settings.Naps2Path,
            Arguments = args,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        var stdoutBuilder = new StringBuilder();
        var stderrBuilder = new StringBuilder();

        using var proc = new Process { StartInfo = psi };
        proc.OutputDataReceived += (_, e) => { if (e.Data != null) stdoutBuilder.AppendLine(e.Data); };
        proc.ErrorDataReceived += (_, e) => { if (e.Data != null) stderrBuilder.AppendLine(e.Data); };

        _activeProcesses[request.RequestId] = proc;

        using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(_settings.ScanTimeoutSeconds));
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);

        try
        {
            _logger.LogInformation("[SCANNER] Spawning NAPS2 for request {requestId}: {args}", request.RequestId, args);
            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            await proc.WaitForExitAsync(linkedCts.Token);

            if (proc.ExitCode != 0)
            {
                var stderr = stderrBuilder.ToString().Trim();
                _logger.LogError("[SCANNER] NAPS2 process exited with code {code}: {err}", proc.ExitCode, stderr);

                var errorCode = "PROCESS_FAILED";
                if (stderr.Contains("feeder", StringComparison.OrdinalIgnoreCase) || stderr.Contains("empty", StringComparison.OrdinalIgnoreCase))
                    errorCode = "FEEDER_EMPTY";
                else if (stderr.Contains("jam", StringComparison.OrdinalIgnoreCase))
                    errorCode = "PAPER_JAM";
                else if (stderr.Contains("busy", StringComparison.OrdinalIgnoreCase))
                    errorCode = "DEVICE_BUSY";

                if (File.Exists(outputPath)) File.Delete(outputPath);

                return new ScanResult
                {
                    Success = false,
                    ErrorCode = errorCode,
                    ErrorMessage = string.IsNullOrWhiteSpace(stderr) ? $"NAPS2 exit code {proc.ExitCode}" : stderr
                };
            }

            if (!File.Exists(outputPath) || new FileInfo(outputPath).Length == 0)
            {
                return new ScanResult
                {
                    Success = false,
                    ErrorCode = "OUTPUT_FILE_MISSING",
                    ErrorMessage = "Scan process finished successfully but output file is missing or zero bytes"
                };
            }

            _logger.LogInformation("[SCANNER] Scan completed successfully -> {path}", outputPath);
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
            _logger.LogWarning("[SCANNER] Scan execution cancelled or timed out for request {requestId}", request.RequestId);
            try
            {
                if (!proc.HasExited)
                {
                    proc.Kill(entireProcessTree: true);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[SCANNER] Failed killing process tree for request {requestId}", request.RequestId);
            }

            if (File.Exists(outputPath)) File.Delete(outputPath);

            var code = timeoutCts.IsCancellationRequested ? "SCAN_TIMEOUT" : "CANCELLED";
            return new ScanResult
            {
                Success = false,
                ErrorCode = code,
                ErrorMessage = timeoutCts.IsCancellationRequested
                    ? $"Scan timed out after {_settings.ScanTimeoutSeconds} seconds"
                    : "Scan cancelled"
            };
        }
        finally
        {
            _activeProcesses.TryRemove(request.RequestId, out _);
        }
    }

    public Task<bool> CancelScanAsync(string requestId)
    {
        if (_activeProcesses.TryGetValue(requestId, out var proc))
        {
            try
            {
                if (!proc.HasExited)
                {
                    proc.Kill(entireProcessTree: true);
                    return Task.FromResult(true);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[SCANNER] Error cancelling scan {requestId}", requestId);
            }
        }
        return _stubService.CancelScanAsync(requestId);
    }

    private async Task<List<string>> ListDevicesAsync(string driver, CancellationToken cancellationToken)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _settings.Naps2Path,
            Arguments = $"--listdevices --driver {driver}",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        using var proc = new Process { StartInfo = psi };
        using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(_settings.ProbeTimeoutSeconds));
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);

        var started = false;
        try
        {
            if (!proc.Start()) return [];
            started = true;

            var stdoutTask = proc.StandardOutput.ReadToEndAsync(linkedCts.Token);
            var stderrTask = proc.StandardError.ReadToEndAsync(linkedCts.Token);

            await proc.WaitForExitAsync(linkedCts.Token);

            var stdout = await stdoutTask;
            var stderr = await stderrTask;

            if (proc.ExitCode == 0)
            {
                return stdout
                    .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(line => line.Trim())
                    .Where(line => !string.IsNullOrWhiteSpace(line))
                    .ToList();
            }

            _logger.LogWarning(
                "[SCANNER] NAPS2 {driver} probe exited with code {code}: {error}",
                driver,
                proc.ExitCode,
                stderr.Trim());
        }
        catch (OperationCanceledException)
        {
            if (started)
            {
                await TerminateProbeProcessAsync(proc, driver);
            }

            if (timeoutCts.IsCancellationRequested)
            {
                _logger.LogDebug(
                    "[SCANNER] {driver} probe timed out after {seconds}s",
                    driver.ToUpperInvariant(),
                    _settings.ProbeTimeoutSeconds);
            }
            else
            {
                _logger.LogDebug("[SCANNER] {driver} probe was cancelled", driver.ToUpperInvariant());
            }

            return [];
        }
        catch (Exception ex)
        {
            if (started)
            {
                await TerminateProbeProcessAsync(proc, driver);
            }

            _logger.LogWarning(ex, "[SCANNER] Error probing devices for driver {driver}", driver);
        }
        return [];
    }

    private async Task TerminateProbeProcessAsync(Process proc, string driver)
    {
        try
        {
            if (!proc.HasExited)
            {
                proc.Kill(entireProcessTree: true);
                await proc.WaitForExitAsync(CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[SCANNER] Failed terminating {driver} probe", driver);
        }
    }

    private static string[] GetProbeDrivers(string preferredDriver) =>
        preferredDriver.Equals("wia", StringComparison.OrdinalIgnoreCase)
            ? ["wia", "twain"]
            : ["twain", "wia"];

    public static string? SelectPreferredDevice(IReadOnlyList<string> devices, string preferredName)
    {
        if (devices.Count == 0) return null;
        var preferredLower = preferredName.ToLowerInvariant();

        var exact = devices.FirstOrDefault(d => d.Equals(preferredName, StringComparison.OrdinalIgnoreCase));
        if (exact != null) return exact;

        var partial = devices.FirstOrDefault(d => d.ToLowerInvariant().Contains(preferredLower));
        if (partial != null) return partial;

        var epson = devices.FirstOrDefault(d => d.ToLowerInvariant().Contains("epson"));
        if (epson != null) return epson;

        return devices[0];
    }

    private static string BuildNaps2Args(
        string outputPath,
        string driver,
        string deviceName,
        string source,
        int dpi,
        string colorMode,
        string? paperSize)
    {
        var sb = new StringBuilder();
        sb.Append("--noprofile ");
        sb.Append($"-o \"{outputPath}\" ");
        sb.Append($"--driver {driver} ");
        sb.Append($"--device \"{deviceName}\" ");
        sb.Append(source.Equals("adf", StringComparison.OrdinalIgnoreCase) || source.Equals("feeder", StringComparison.OrdinalIgnoreCase)
            ? "--source feeder "
            : "--source glass ");
        sb.Append($"--dpi {dpi} ");
        sb.Append(colorMode.Equals("grayscale", StringComparison.OrdinalIgnoreCase)
            ? "--bitdepth gray "
            : "--bitdepth color ");
        sb.Append("--force --verbose ");

        var isFeeder = source.Equals("adf", StringComparison.OrdinalIgnoreCase)
            || source.Equals("feeder", StringComparison.OrdinalIgnoreCase);
        var normPaper = paperSize?.Trim().ToLowerInvariant();
        var pageSize = isFeeder ? normPaper switch
        {
            "a4" => "a4",
            "letter" => "letter",
            // Use explicit dimensions for Long Bond (8.5×13 in) — "legal" in NAPS2/scanner
            // context maps to US Legal (8.5×14 in), not the Philippine 13-inch size.
            "legal" or "folio" => "216x330mm",
            _ => null
        } : normPaper switch
        {
            "letter" => "216x279mm",
            "legal" or "folio" => "216x330mm",
            _ => "216x297mm"
        };
        if (pageSize is not null) sb.Append($"--pagesize {pageSize} ");

        return sb.ToString().Trim();
    }
}
