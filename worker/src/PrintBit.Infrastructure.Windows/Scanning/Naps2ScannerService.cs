using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using NAPS2.Images;
using NAPS2.Images.Gdi;
using NAPS2.Pdf;
using NAPS2.Scan;
using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.Windows.Scanning;

public sealed class Naps2ScannerService : IScannerService, IDisposable
{
    private readonly ILogger<Naps2ScannerService> _logger;
    private readonly ScannerSettings _settings;
    private readonly StubScannerService _stubService;
    private readonly ScanningContext _scanningContext;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _activeScans = new();

    private ScannerRuntimeStatus _lastKnownStatus;
    private ScanDevice? _selectedDevice;

    public Naps2ScannerService(
        ILogger<Naps2ScannerService> logger,
        ILogger<StubScannerService> stubLogger,
        IOptions<ScannerSettings> settings)
    {
        _logger = logger;
        _settings = settings.Value;
        _stubService = new StubScannerService(stubLogger, settings);
        _scanningContext = new ScanningContext(new GdiImageContext());
        _scanningContext.SetUpWin32Worker();

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

        var caps = await ProbeCapabilitiesAsync(cancellationToken);
        if (caps.Available)
        {
            return _lastKnownStatus;
        }

        if (_settings.EnableStubFallback)
        {
            return await _stubService.GetStatusAsync(cancellationToken);
        }

        return _lastKnownStatus;
    }

    public async Task<ScannerCapabilities> ProbeCapabilitiesAsync(CancellationToken cancellationToken = default)
    {
        var drivers = GetProbeDrivers(_settings.PreferredDriver);

        foreach (var driver in drivers)
        {
            try
            {
                using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(_settings.ProbeTimeoutSeconds));
                using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);

                var controller = new ScanController(_scanningContext);
                var devices = await controller.GetDeviceList(driver);

                if (devices.Count > 0)
                {
                    var preferred = SelectPreferredDevice(devices, _settings.PreferredScannerName);
                    if (preferred != null)
                    {
                        _selectedDevice = preferred;
                        _lastKnownStatus = new ScannerRuntimeStatus
                        {
                            Connected = true,
                            Adapter = "naps2",
                            Driver = driver.ToString().ToLowerInvariant(),
                            DeviceName = preferred.Name,
                            PreferredName = _settings.PreferredScannerName,
                            Capabilities = new ScannerCapabilities { Available = true },
                            UsingStub = false,
                            LastCheckedAt = DateTime.UtcNow,
                            LastError = null
                        };

                        _logger.LogInformation("[SCANNER] NAPS2.Sdk connected to {driver} device '{device}'", driver, preferred.Name);
                        return _lastKnownStatus.Capabilities!;
                    }
                }
            }
            catch (OperationCanceledException)
            {
                _logger.LogDebug("[SCANNER] {driver} probe timed out or was cancelled", driver);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[SCANNER] Error probing devices for driver {driver}", driver);
            }
        }

        _selectedDevice = null;
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
            LastError = "No compatible TWAIN, WIA, or eSCL scanner found"
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
        // Reuse known connected status if fresh to avoid probing overhead
        var status = (_lastKnownStatus.Connected && !string.IsNullOrWhiteSpace(_lastKnownStatus.DeviceName) && _selectedDevice != null)
            ? _lastKnownStatus
            : await GetStatusAsync(cancellationToken);

        if (status.UsingStub || !status.Connected || _selectedDevice == null)
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

        var isFeeder = request.Source.Equals("adf", StringComparison.OrdinalIgnoreCase)
            || request.Source.Equals("feeder", StringComparison.OrdinalIgnoreCase);

        var options = new ScanOptions
        {
            Device = _selectedDevice,
            PaperSource = isFeeder ? PaperSource.Feeder : PaperSource.Flatbed,
            Dpi = request.Dpi > 0 ? request.Dpi : 300,
            BitDepth = request.ColorMode.Equals("grayscale", StringComparison.OrdinalIgnoreCase)
                ? BitDepth.Grayscale : BitDepth.Color,
            TwainOptions = new TwainOptions
            {
                Dsm = TwainDsm.New,
                TransferMode = TwainTransferMode.Memory,
                ShowProgress = false
            }
        };

        var normPaper = request.PaperSize?.Trim().ToLowerInvariant();
        options.PageSize = normPaper switch
        {
            "a4" => PageSize.A4,
            "letter" or "short" => isFeeder ? PageSize.Letter : new PageSize(216m, 279m, PageSizeUnit.Millimetre),
            "legal" or "folio" or "long" => new PageSize(216m, 330m, PageSizeUnit.Millimetre),
            _ => isFeeder ? null : new PageSize(216m, 297m, PageSizeUnit.Millimetre)
        };

        using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(_settings.ScanTimeoutSeconds));
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);
        _activeScans[request.RequestId] = linkedCts;

        var controller = new ScanController(_scanningContext);
        var images = new List<ProcessedImage>();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        long lastPageMs = 0;

        try
        {
            _logger.LogInformation(
                "[SCANNER] Starting NAPS2.Sdk scan for request {requestId} ({source}, {dpi} DPI, {color}, maxPages: {maxPages}, device: {device})",
                request.RequestId, request.Source, options.Dpi, request.ColorMode, request.MaxPages, _selectedDevice.Name);

            await foreach (var image in controller.Scan(options, linkedCts.Token))
            {
                var pageElapsed = sw.ElapsedMilliseconds - lastPageMs;
                lastPageMs = sw.ElapsedMilliseconds;
                images.Add(image);
                _logger.LogInformation(
                    "[SCANNER] Page {page} scanned in {pageMs}ms (total: {totalMs}ms) for request {requestId}",
                    images.Count, pageElapsed, sw.ElapsedMilliseconds, request.RequestId);

                if (request.MaxPages.HasValue && images.Count >= request.MaxPages.Value)
                {
                    _logger.LogInformation(
                        "[SCANNER] Reached maxPages limit ({maxPages}) for request {requestId}; ending feeder acquisition early.",
                        request.MaxPages.Value, request.RequestId);
                    break;
                }
            }

            if (images.Count == 0)
            {
                sw.Stop();
                _logger.LogWarning("[SCANNER] Scan completed with 0 pages for request {requestId} in {duration}ms", request.RequestId, sw.ElapsedMilliseconds);
                return new ScanResult
                {
                    Success = false,
                    ErrorCode = isFeeder ? "FEEDER_EMPTY" : "OUTPUT_FILE_MISSING",
                    ErrorMessage = isFeeder ? "ADF feeder is empty or paper feed not detected" : "No pages received from scanner",
                    DurationMs = sw.ElapsedMilliseconds
                };
            }

            if (ext == "pdf")
            {
                var pdfExporter = new PdfExporter(_scanningContext);
                await pdfExporter.Export(outputPath, images);
            }
            else
            {
                images[0].Save(outputPath);
            }

            sw.Stop();
            _logger.LogInformation("[SCANNER] Scan completed successfully ({count} pages in {duration}ms) -> {path}", images.Count, sw.ElapsedMilliseconds, outputPath);
            return new ScanResult
            {
                Success = true,
                OutputPath = outputPath,
                PageCount = images.Count,
                Format = ext,
                DurationMs = sw.ElapsedMilliseconds
            };
        }
        catch (OperationCanceledException)
        {
            sw.Stop();
            _logger.LogWarning("[SCANNER] Scan execution cancelled or timed out after {duration}ms for request {requestId}", sw.ElapsedMilliseconds, request.RequestId);
            if (File.Exists(outputPath)) File.Delete(outputPath);

            var code = timeoutCts.IsCancellationRequested ? "SCAN_TIMEOUT" : "CANCELLED";
            return new ScanResult
            {
                Success = false,
                ErrorCode = code,
                ErrorMessage = timeoutCts.IsCancellationRequested
                    ? $"Scan timed out after {_settings.ScanTimeoutSeconds} seconds"
                    : "Scan cancelled",
                DurationMs = sw.ElapsedMilliseconds
            };
        }
        catch (Exception ex)
        {
            sw.Stop();
            _logger.LogError(ex, "[SCANNER] NAPS2.Sdk scan error after {duration}ms for request {requestId}: {msg}", sw.ElapsedMilliseconds, request.RequestId, ex.Message);
            if (File.Exists(outputPath)) File.Delete(outputPath);

            var errorCode = "PROCESS_FAILED";
            var msg = ex.Message ?? "";
            if (msg.Contains("feeder", StringComparison.OrdinalIgnoreCase) || msg.Contains("empty", StringComparison.OrdinalIgnoreCase))
                errorCode = "FEEDER_EMPTY";
            else if (msg.Contains("jam", StringComparison.OrdinalIgnoreCase))
                errorCode = "PAPER_JAM";
            else if (msg.Contains("busy", StringComparison.OrdinalIgnoreCase))
                errorCode = "DEVICE_BUSY";

            return new ScanResult
            {
                Success = false,
                ErrorCode = errorCode,
                ErrorMessage = string.IsNullOrWhiteSpace(msg) ? "Scanning failed." : msg,
                DurationMs = sw.ElapsedMilliseconds
            };
        }
        finally
        {
            _activeScans.TryRemove(request.RequestId, out _);
            foreach (var img in images)
            {
                if (img is IDisposable d) d.Dispose();
            }
        }
    }

    public Task<bool> CancelScanAsync(string requestId)
    {
        if (_activeScans.TryGetValue(requestId, out var cts))
        {
            try
            {
                cts.Cancel();
                return Task.FromResult(true);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[SCANNER] Error cancelling scan {requestId}", requestId);
            }
        }
        return _stubService.CancelScanAsync(requestId);
    }

    private static Driver[] GetProbeDrivers(string preferredDriver)
    {
        var pref = preferredDriver?.Trim().ToLowerInvariant();
        return pref switch
        {
            "twain" => [Driver.Twain, Driver.Wia, Driver.Escl],
            "escl" => [Driver.Escl, Driver.Wia, Driver.Twain],
            _ => [Driver.Wia, Driver.Twain, Driver.Escl]
        };
    }

    public static ScanDevice? SelectPreferredDevice(IReadOnlyList<ScanDevice> devices, string preferredName)
    {
        if (devices.Count == 0) return null;
        var preferredLower = preferredName.ToLowerInvariant();

        var exact = devices.FirstOrDefault(d => d.Name.Equals(preferredName, StringComparison.OrdinalIgnoreCase));
        if (exact != null) return exact;

        var partial = devices.FirstOrDefault(d => d.Name.ToLowerInvariant().Contains(preferredLower));
        if (partial != null) return partial;

        var epson = devices.FirstOrDefault(d => d.Name.ToLowerInvariant().Contains("epson"));
        if (epson != null) return epson;

        return devices[0];
    }

    public void Dispose()
    {
        _scanningContext.Dispose();
    }
}
