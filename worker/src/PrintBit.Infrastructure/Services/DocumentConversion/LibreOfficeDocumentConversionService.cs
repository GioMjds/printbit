using System.Diagnostics;
using System.IO;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.Services.DocumentConversion;

/// <summary>
/// Converts documents to PDF using native C# conversion for images and headless LibreOffice for office formats.
/// Enforces concurrency serialization and process tree isolation.
/// </summary>
public sealed class LibreOfficeDocumentConversionService : IDocumentConversionService
{
    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".png", ".bmp", ".gif"
    };

    private static readonly HashSet<string> OfficeExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf", ".txt"
    };

    private static readonly SemaphoreSlim LibreOfficeGate = new(1, 1);

    private readonly DocumentConversionSettings _settings;
    private readonly ILogger<LibreOfficeDocumentConversionService> _logger;

    public LibreOfficeDocumentConversionService(
        IOptions<DocumentConversionSettings> settings,
        ILogger<LibreOfficeDocumentConversionService> logger)
    {
        _settings = settings?.Value ?? throw new ArgumentNullException(nameof(settings));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task<DocumentConversionResult> ConvertAsync(
        DocumentConversionRequest request,
        CancellationToken cancellationToken = default)
    {
        if (request == null)
        {
            return new DocumentConversionResult
            {
                Success = false,
                ErrorMessage = "Conversion request cannot be null."
            };
        }

        var sw = Stopwatch.StartNew();

        if (string.IsNullOrWhiteSpace(request.SourcePath))
        {
            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = false,
                DurationMs = sw.ElapsedMilliseconds,
                ErrorMessage = "Source path cannot be null or whitespace."
            };
        }

        if (!File.Exists(request.SourcePath))
        {
            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = false,
                DurationMs = sw.ElapsedMilliseconds,
                ErrorMessage = $"Source file '{request.SourcePath}' does not exist."
            };
        }

        var ext = Path.GetExtension(request.SourcePath).ToLowerInvariant();
        var sourceFormat = ext.TrimStart('.');

        var outputDir = !string.IsNullOrWhiteSpace(request.OutputDirectory)
            ? request.OutputDirectory
            : _settings.DefaultOutputDirectory;

        try
        {
            if (!Directory.Exists(outputDir))
            {
                Directory.CreateDirectory(outputDir);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create output directory {OutputDirectory}", outputDir);
            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = false,
                SourceFormat = sourceFormat,
                DurationMs = sw.ElapsedMilliseconds,
                ErrorMessage = $"Failed to create output directory: {ex.Message}"
            };
        }

        var expectedPdfPath = Path.Combine(
            outputDir,
            Path.GetFileNameWithoutExtension(request.SourcePath) + ".pdf");

        if (ext == ".pdf")
        {
            if (!string.Equals(Path.GetFullPath(request.SourcePath), Path.GetFullPath(expectedPdfPath), StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(request.SourcePath, expectedPdfPath, overwrite: true);
            }

            var pageCount = PdfPageCounter.Count(expectedPdfPath);
            sw.Stop();
            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = true,
                OutputPath = expectedPdfPath,
                PageCount = pageCount,
                SourceFormat = sourceFormat,
                DurationMs = sw.ElapsedMilliseconds
            };
        }

        // 1. Image formats -> Native C# ImageToPdfConverter
        if (ImageExtensions.Contains(ext))
        {
            return await ConvertImageAsync(request, sourceFormat, expectedPdfPath, sw, cancellationToken);
        }

        // 2. Office document formats -> Headless LibreOffice
        if (OfficeExtensions.Contains(ext))
        {
            return await ConvertViaLibreOfficeAsync(request, sourceFormat, outputDir, expectedPdfPath, sw, cancellationToken);
        }

        // 3. Unsupported format
        return new DocumentConversionResult
        {
            RequestId = request.RequestId,
            Success = false,
            SourceFormat = sourceFormat,
            DurationMs = sw.ElapsedMilliseconds,
            ErrorMessage = $"Unsupported file extension '{ext}' for document conversion."
        };
    }

    private async Task<DocumentConversionResult> ConvertImageAsync(
        DocumentConversionRequest request,
        string sourceFormat,
        string expectedPdfPath,
        Stopwatch sw,
        CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogInformation("Converting image {SourcePath} to PDF", request.SourcePath);
            var pageCount = await ImageToPdfConverter.ConvertAsync(
                request.SourcePath,
                expectedPdfPath,
                cancellationToken);

            sw.Stop();
            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = true,
                OutputPath = expectedPdfPath,
                PageCount = pageCount,
                SourceFormat = sourceFormat,
                DurationMs = sw.ElapsedMilliseconds
            };
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            sw.Stop();
            _logger.LogError(ex, "Image conversion failed for {SourcePath}", request.SourcePath);
            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = false,
                SourceFormat = sourceFormat,
                DurationMs = sw.ElapsedMilliseconds,
                ErrorMessage = $"Image conversion failed: {ex.Message}"
            };
        }
    }

    private async Task<DocumentConversionResult> ConvertViaLibreOfficeAsync(
        DocumentConversionRequest request,
        string sourceFormat,
        string outputDir,
        string expectedPdfPath,
        Stopwatch sw,
        CancellationToken cancellationToken)
    {
        var resolvedExecutable = ResolveExecutablePath(_settings.SofficePath);

        if (!File.Exists(resolvedExecutable) && !File.Exists(_settings.SofficePath))
        {
            sw.Stop();
            var msg = $"LibreOffice executable not found at configured path: '{_settings.SofficePath}'.";
            _logger.LogWarning(msg);
            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = false,
                SourceFormat = sourceFormat,
                DurationMs = sw.ElapsedMilliseconds,
                ErrorMessage = msg
            };
        }

        var executableToRun = File.Exists(resolvedExecutable) ? resolvedExecutable : _settings.SofficePath;

        await LibreOfficeGate.WaitAsync(cancellationToken);
        string? profileDir = null;
        try
        {
            var baseProfileDir = string.IsNullOrWhiteSpace(_settings.UserProfileDirectory)
                ? Path.Combine(Path.GetTempPath(), "printbit-lo-profile")
                : _settings.UserProfileDirectory;

            profileDir = Path.Combine(baseProfileDir, $"inst-{Guid.NewGuid():N}");
            if (!Directory.Exists(profileDir))
            {
                Directory.CreateDirectory(profileDir);
            }

            var profileUri = new Uri(Path.GetFullPath(profileDir)).AbsoluteUri;

            // Delete stale expected output if present to prevent returning outdated artifacts
            try { if (File.Exists(expectedPdfPath)) File.Delete(expectedPdfPath); } catch { }

            var psi = new ProcessStartInfo
            {
                FileName = executableToRun,
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            psi.ArgumentList.Add("--headless");
            psi.ArgumentList.Add("--nologo");
            psi.ArgumentList.Add("--nodefault");
            psi.ArgumentList.Add("--norestore");
            psi.ArgumentList.Add("--nolockcheck");
            psi.ArgumentList.Add("--nofirststartwizard");
            psi.ArgumentList.Add($"-env:UserInstallation={profileUri}");
            psi.ArgumentList.Add("--convert-to");
            psi.ArgumentList.Add("pdf");
            psi.ArgumentList.Add("--outdir");
            psi.ArgumentList.Add(outputDir);
            psi.ArgumentList.Add(request.SourcePath);

            var timeoutSeconds = request.TimeoutSeconds > 0
                ? request.TimeoutSeconds
                : _settings.DefaultTimeoutSeconds;
            if (timeoutSeconds <= 0) timeoutSeconds = 60;

            using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);
            using var process = new Process { StartInfo = psi };

            _logger.LogInformation(
                "Starting LibreOffice conversion: {Executable} {SourcePath} -> {OutputDir} (timeout: {Timeout}s)",
                executableToRun,
                request.SourcePath,
                outputDir,
                timeoutSeconds);

            try
            {
                process.Start();
            }
            catch (Exception ex)
            {
                sw.Stop();
                _logger.LogError(ex, "Failed to start LibreOffice process {Executable}", executableToRun);
                return new DocumentConversionResult
                {
                    RequestId = request.RequestId,
                    Success = false,
                    SourceFormat = sourceFormat,
                    DurationMs = sw.ElapsedMilliseconds,
                    ErrorMessage = $"Failed to start LibreOffice: {ex.Message}"
                };
            }

            var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
            string stdout = string.Empty;
            string stderr = string.Empty;

            try
            {
                await Task.WhenAll(process.WaitForExitAsync(linkedCts.Token), stdoutTask, stderrTask);
                stdout = await stdoutTask;
                stderr = await stderrTask;
            }
            catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
                sw.Stop();
                _logger.LogWarning("LibreOffice conversion for {SourcePath} timed out after {Timeout}s", request.SourcePath, timeoutSeconds);
                return new DocumentConversionResult
                {
                    RequestId = request.RequestId,
                    Success = false,
                    SourceFormat = sourceFormat,
                    DurationMs = sw.ElapsedMilliseconds,
                    ErrorMessage = $"LibreOffice document conversion timed out after {timeoutSeconds} seconds."
                };
            }
            catch (OperationCanceledException)
            {
                try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
                throw;
            }

            if (process.ExitCode != 0)
            {
                var errDetail = !string.IsNullOrWhiteSpace(stderr) ? stderr.Trim() : (!string.IsNullOrWhiteSpace(stdout) ? stdout.Trim() : $"Exit code {process.ExitCode}");
                sw.Stop();
                _logger.LogError("LibreOffice conversion failed for {SourcePath}: {Error}", request.SourcePath, errDetail);
                return new DocumentConversionResult
                {
                    RequestId = request.RequestId,
                    Success = false,
                    SourceFormat = sourceFormat,
                    DurationMs = sw.ElapsedMilliseconds,
                    ErrorMessage = $"LibreOffice conversion failed (exit code {process.ExitCode}): {errDetail}"
                };
            }

            if (!File.Exists(expectedPdfPath) || new FileInfo(expectedPdfPath).Length == 0)
            {
                sw.Stop();
                _logger.LogError("LibreOffice conversion did not create valid PDF at {OutputPath}", expectedPdfPath);
                return new DocumentConversionResult
                {
                    RequestId = request.RequestId,
                    Success = false,
                    SourceFormat = sourceFormat,
                    DurationMs = sw.ElapsedMilliseconds,
                    ErrorMessage = "LibreOffice conversion completed but output PDF was not found or is empty."
                };
            }

            var pageCount = PdfPageCounter.Count(expectedPdfPath);
            sw.Stop();

            _logger.LogInformation(
                "LibreOffice conversion succeeded for {SourcePath} -> {OutputPath} ({PageCount} pages, {DurationMs}ms)",
                request.SourcePath,
                expectedPdfPath,
                pageCount,
                sw.ElapsedMilliseconds);

            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = true,
                OutputPath = expectedPdfPath,
                PageCount = pageCount,
                SourceFormat = sourceFormat,
                DurationMs = sw.ElapsedMilliseconds
            };
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(profileDir))
            {
                try
                {
                    if (Directory.Exists(profileDir))
                    {
                        Directory.Delete(profileDir, recursive: true);
                    }
                }
                catch { }
            }

            LibreOfficeGate.Release();
        }
    }

    private static string ResolveExecutablePath(string configuredPath)
    {
        if (string.IsNullOrWhiteSpace(configuredPath)) return configuredPath;

        if (File.Exists(configuredPath))
        {
            if (configuredPath.EndsWith("soffice.exe", StringComparison.OrdinalIgnoreCase))
            {
                var comPath = configuredPath.Substring(0, configuredPath.Length - 4) + ".com";
                if (File.Exists(comPath))
                {
                    return comPath;
                }
            }
            return configuredPath;
        }

        var isStandardOrBareName =
            string.Equals(configuredPath, @"C:\Program Files\LibreOffice\program\soffice.exe", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(configuredPath, "soffice.exe", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(configuredPath, "soffice", StringComparison.OrdinalIgnoreCase);

        if (isStandardOrBareName)
        {
            var commonCandidates = new[]
            {
                @"C:\Program Files\LibreOffice\program\soffice.com",
                @"C:\Program Files\LibreOffice\program\soffice.exe",
                @"C:\Program Files (x86)\LibreOffice\program\soffice.com",
                @"C:\Program Files (x86)\LibreOffice\program\soffice.exe"
            };

            foreach (var candidate in commonCandidates)
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return configuredPath;
    }
}
