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
        ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf", ".txt", ".webp"
    };

    private static readonly SemaphoreSlim ConversionGate = new(1, 1);

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

        if (string.IsNullOrWhiteSpace(request.SourcePath))
        {
            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = false,
                DurationMs = 0,
                ErrorMessage = "Source path cannot be null or whitespace."
            };
        }

        if (!File.Exists(request.SourcePath))
        {
            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = false,
                DurationMs = 0,
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
                DurationMs = 0,
                ErrorMessage = $"Failed to create output directory: {ex.Message}"
            };
        }

        var expectedPdfPath = Path.Combine(
            outputDir,
            Path.GetFileNameWithoutExtension(request.SourcePath) + ".pdf");

        if (ext == ".pdf")
        {
            var swPdf = Stopwatch.StartNew();
            if (!string.Equals(Path.GetFullPath(request.SourcePath), Path.GetFullPath(expectedPdfPath), StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(request.SourcePath, expectedPdfPath, overwrite: true);
            }

            var pdfVerification = VerifyPdfOutput(expectedPdfPath);
            swPdf.Stop();
            if (!pdfVerification.Valid)
            {
                return new DocumentConversionResult
                {
                    RequestId = request.RequestId,
                    Success = false,
                    SourceFormat = sourceFormat,
                    DurationMs = swPdf.ElapsedMilliseconds,
                    ErrorMessage = pdfVerification.ErrorMessage
                };
            }

            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = true,
                OutputPath = expectedPdfPath,
                PageCount = pdfVerification.PageCount,
                SourceFormat = sourceFormat,
                DurationMs = swPdf.ElapsedMilliseconds
            };
        }

        if (!ImageExtensions.Contains(ext) && !OfficeExtensions.Contains(ext))
        {
            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = false,
                SourceFormat = sourceFormat,
                DurationMs = 0,
                ErrorMessage = $"Unsupported file extension '{ext}' for document conversion."
            };
        }

        await ConversionGate.WaitAsync(cancellationToken);
        try
        {
            var sw = Stopwatch.StartNew();

            // 1. Image formats -> Native C# ImageToPdfConverter
            if (ImageExtensions.Contains(ext))
            {
                return await ConvertImageAsync(request, sourceFormat, expectedPdfPath, sw, cancellationToken);
            }

            // 2. Office document formats -> Headless LibreOffice
            return await ConvertViaLibreOfficeAsync(request, sourceFormat, outputDir, expectedPdfPath, sw, cancellationToken);
        }
        finally
        {
            ConversionGate.Release();
        }
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
            await ImageToPdfConverter.ConvertAsync(
                request.SourcePath,
                expectedPdfPath,
                cancellationToken);

            var verification = VerifyPdfOutput(expectedPdfPath);
            sw.Stop();

            if (!verification.Valid)
            {
                _logger.LogError("Image conversion output verification failed for {SourcePath}: {Error}", request.SourcePath, verification.ErrorMessage);
                return new DocumentConversionResult
                {
                    RequestId = request.RequestId,
                    Success = false,
                    SourceFormat = sourceFormat,
                    DurationMs = sw.ElapsedMilliseconds,
                    ErrorMessage = verification.ErrorMessage
                };
            }

            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = true,
                OutputPath = expectedPdfPath,
                PageCount = verification.PageCount,
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

        string? jobProfileDir = null;
        try
        {
            var baseProfileDir = string.IsNullOrWhiteSpace(_settings.UserProfileDirectory)
                ? Path.Combine(Path.GetTempPath(), "printbit-lo-profiles")
                : _settings.UserProfileDirectory;

            PurgeStaleProfiles(baseProfileDir, _logger);

            jobProfileDir = Path.Combine(baseProfileDir, $"job-{Guid.NewGuid():N}");
            if (!Directory.Exists(jobProfileDir))
            {
                Directory.CreateDirectory(jobProfileDir);
            }

            var profileUri = new Uri(Path.GetFullPath(jobProfileDir)).AbsoluteUri;

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
            psi.ArgumentList.Add("--invisible");
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
                "Starting LibreOffice conversion: {Executable} {SourcePath} -> {OutputDir} (timeout: {Timeout}s, profile: {ProfileDir})",
                executableToRun,
                request.SourcePath,
                outputDir,
                timeoutSeconds,
                jobProfileDir);

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
                if (_settings.EnableZombieTermination)
                {
                    TerminateProcessTree(process, _logger);
                }
                else
                {
                    try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
                }
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
                if (_settings.EnableZombieTermination)
                {
                    TerminateProcessTree(process, _logger);
                }
                else
                {
                    try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
                }
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

            var actualPdfPath = expectedPdfPath;
            if (!File.Exists(actualPdfPath) || new FileInfo(actualPdfPath).Length == 0)
            {
                // Fallback: check if LibreOffice generated a PDF in outputDir with a case-insensitive match or matching prefix
                var sourceBaseName = Path.GetFileNameWithoutExtension(request.SourcePath);
                var fallbackCandidate = Directory.EnumerateFiles(outputDir, "*.pdf")
                    .Where(f => string.Equals(Path.GetFileNameWithoutExtension(f), sourceBaseName, StringComparison.OrdinalIgnoreCase))
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .FirstOrDefault();

                if (fallbackCandidate != null && new FileInfo(fallbackCandidate).Length > 0)
                {
                    actualPdfPath = fallbackCandidate;
                }
            }

            var verification = VerifyPdfOutput(actualPdfPath);
            sw.Stop();

            if (!verification.Valid)
            {
                _logger.LogError("LibreOffice conversion output verification failed for {SourcePath}: {Error}", request.SourcePath, verification.ErrorMessage);
                return new DocumentConversionResult
                {
                    RequestId = request.RequestId,
                    Success = false,
                    SourceFormat = sourceFormat,
                    DurationMs = sw.ElapsedMilliseconds,
                    ErrorMessage = verification.ErrorMessage
                };
            }

            _logger.LogInformation(
                "LibreOffice conversion succeeded for {SourcePath} -> {OutputPath} ({PageCount} pages, {DurationMs}ms)",
                request.SourcePath,
                actualPdfPath,
                verification.PageCount,
                sw.ElapsedMilliseconds);

            return new DocumentConversionResult
            {
                RequestId = request.RequestId,
                Success = true,
                OutputPath = actualPdfPath,
                PageCount = verification.PageCount,
                SourceFormat = sourceFormat,
                DurationMs = sw.ElapsedMilliseconds
            };
        }
        finally
        {
            TryCleanupProfileDirectory(jobProfileDir, _logger);
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

    private static void TerminateProcessTree(Process process, ILogger logger)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Initial process termination check threw exception");
        }

        if (OperatingSystem.IsWindows())
        {
            try
            {
                using var killer = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = $"/F /T /PID {process.Id}",
                    CreateNoWindow = true,
                    UseShellExecute = false
                });
                killer?.WaitForExit(2000);
            }
            catch
            {
                // Taskkill may fail if process already exited; ignore.
            }
        }
    }

    private static (bool Valid, int PageCount, string ErrorMessage) VerifyPdfOutput(string pdfPath)
    {
        if (string.IsNullOrWhiteSpace(pdfPath) || !File.Exists(pdfPath))
        {
            return (false, 0, $"Output PDF '{pdfPath}' was not created.");
        }

        var info = new FileInfo(pdfPath);
        if (info.Length == 0)
        {
            TryDeleteFile(pdfPath);
            return (false, 0, $"Output PDF '{pdfPath}' is empty (0 bytes).");
        }

        var pageCount = PdfPageCounter.Count(pdfPath);
        if (pageCount is null or <= 0)
        {
            TryDeleteFile(pdfPath);
            return (false, 0, $"Output PDF '{pdfPath}' is invalid or contains zero pages.");
        }

        return (true, pageCount.Value, string.Empty);
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // Ignore deletion errors for cleanup
        }
    }

    private static void TryCleanupProfileDirectory(string? profileDir, ILogger logger)
    {
        if (string.IsNullOrWhiteSpace(profileDir) || !Directory.Exists(profileDir)) return;

        for (int attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                Directory.Delete(profileDir, recursive: true);
                return;
            }
            catch (Exception ex)
            {
                if (attempt == 3)
                {
                    logger.LogDebug(ex, "Failed to delete temporary profile directory {ProfileDir} after 3 attempts", profileDir);
                }
                else
                {
                    Thread.Sleep(attempt * 100);
                }
            }
        }
    }

    private static void PurgeStaleProfiles(string baseProfileDir, ILogger logger)
    {
        try
        {
            if (!Directory.Exists(baseProfileDir)) return;

            var threshold = DateTime.UtcNow.AddMinutes(-30);
            foreach (var dir in Directory.EnumerateDirectories(baseProfileDir, "job-*"))
            {
                try
                {
                    if (Directory.GetCreationTimeUtc(dir) < threshold)
                    {
                        Directory.Delete(dir, recursive: true);
                    }
                }
                catch
                {
                    // Profile may be locked by another active job; skip.
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "PurgeStaleProfiles encountered an error while scanning {BaseDir}", baseProfileDir);
        }
    }
}
