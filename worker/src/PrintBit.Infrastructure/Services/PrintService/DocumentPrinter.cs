using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Shared.Configurations;
using PrintBit.Shared.Printing;

namespace PrintBit.Infrastructure.Services.PrintService;

public sealed class DocumentPrinter : IDocumentPrinter
{
    internal static readonly TimeSpan SpoolerPollInterval =
        TimeSpan.FromMilliseconds(500);
    internal static readonly TimeSpan SpoolerProgressGracePeriod =
        TimeSpan.FromSeconds(45);

    private const uint JobErrorMask =
        0x00000002 | // Error
        0x00000020 | // Offline
        0x00000040 | // Paper out
        0x00000200 | // Blocked device queue
        0x00000400;  // User intervention required

    private static readonly SemaphoreSlim PrintLock = new(1, 1);
    private readonly ILogger<DocumentPrinter> _logger;
    private readonly HardwareSettings _settings;
    private readonly IPrinterHealthMonitor _healthMonitor;

    public DocumentPrinter(
        ILogger<DocumentPrinter> logger,
        IOptions<HardwareSettings> options,
        IPrinterHealthMonitor healthMonitor)
    {
        _logger = logger;
        _settings = options.Value;
        _healthMonitor = healthMonitor;
    }

    public async Task<DocumentPrintResult> PrintDocumentAsync(
        string filePath,
        string printerName,
        int copyNumber,
        IReadOnlyList<int> pages,
        PrintJobSettings settings,
        Func<int, int, Task> onProgress,
        Func<string, Task> onPaused,
        Func<Task> onResumed,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(pages);
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(onProgress);
        ArgumentNullException.ThrowIfNull(onPaused);
        ArgumentNullException.ThrowIfNull(onResumed);

        if (pages.Count == 0)
        {
            return Failed(PrintFailureStage.Validation, "No pages selected for printing", 0);
        }

        var expectedPages = pages.Count * Math.Max(1, settings.Copies);

        await PrintLock.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(filePath))
            {
                return Failed(PrintFailureStage.Validation, "PDF file not found", expectedPages);
            }

            if (!File.Exists(_settings.SumatraPath))
            {
                return Failed(PrintFailureStage.Validation, "SumatraPDF executable not found", expectedPages);
            }

            string dispatchPrinterName;
            try
            {
                dispatchPrinterName = PrinterProfileResolver.Resolve(
                    _settings,
                    settings.Quality,
                    settings.Orientation);
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
            {
                return Failed(PrintFailureStage.Validation, ex.Message, expectedPages);
            }

            _logger.LogInformation(
                "Dispatching PDF from {filePath} to profile queue {dispatchPrinterName} for physical printer {printerName} (Copies={copies}, Quality={quality}, Orientation={orientation}, PaperSize={paperSize}, Pages={pageCount})",
                filePath,
                dispatchPrinterName,
                printerName,
                Math.Max(1, settings.Copies),
                settings.Quality,
                settings.Orientation,
                settings.PaperSize,
                pages.Count);

            using var process = BuildPrintProcess(
                _settings.SumatraPath,
                filePath,
                dispatchPrinterName,
                pages,
                settings);

            _logger.LogInformation(
                "Executing SumatraPDF: {fileName} {arguments}",
                process.StartInfo.FileName,
                string.Join(" ", process.StartInfo.ArgumentList));

            try
            {
                process.Start();
            }
            catch (Exception ex)
            {
                return Failed(PrintFailureStage.ProcessStart, ex.Message, expectedPages);
            }

            using var timeoutCts = new CancellationTokenSource(
                TimeSpan.FromSeconds(_settings.PrintTimeoutSeconds));
            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                timeoutCts.Token);

            try
            {
                await process.WaitForExitAsync(linkedCts.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                try { process.Kill(true); } catch { }
                return Failed(PrintFailureStage.Timeout, "Sumatra process timeout", expectedPages);
            }

            _logger.LogInformation(
                "SumatraPDF exited with code {exitCode} for copy {copyNumber}",
                process.ExitCode,
                copyNumber);

            if (process.ExitCode != 0)
            {
                var error = await process.StandardError.ReadToEndAsync(cancellationToken);
                _logger.LogWarning("SumatraPDF error output: {error}", error);
                return Failed(PrintFailureStage.ProcessExit, error, expectedPages);
            }

            return await VerifySpoolerDocumentLifecycleAsync(
                dispatchPrinterName,
                printerName,
                Path.GetFileName(filePath),
                expectedPages,
                pages.Count,
                onProgress,
                onPaused,
                onResumed,
                cancellationToken);
        }
        finally
        {
            PrintLock.Release();
        }
    }

    internal static Process BuildPrintProcess(
        string sumatraPath,
        string filePath,
        string printerName,
        IReadOnlyList<int> pages,
        PrintJobSettings settings)
    {
        var printSettings = new List<string>
        {
            $"{Math.Max(1, settings.Copies)}x",
            settings.Color ? "color" : "monochrome",
            FormatPageSelection(pages)
        };

        printSettings.Add(NormalizePaperSetting(settings.PaperSize));

        if (string.Equals(settings.Orientation, "landscape", StringComparison.OrdinalIgnoreCase))
        {
            printSettings.Add("landscape");
        }
        else
        {
            printSettings.Add("portrait");
        }

        printSettings.Add(string.Equals(settings.Scaling, "actual", StringComparison.OrdinalIgnoreCase)
            ? "noscale" : "fit");
        printSettings.Add("ignore-pdf-print-settings");
        printSettings.Add("collate");

        var startInfo = new ProcessStartInfo
        {
            FileName = sumatraPath,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.ArgumentList.Add("-print-to");
        startInfo.ArgumentList.Add(printerName);
        startInfo.ArgumentList.Add("-print-settings");
        startInfo.ArgumentList.Add(string.Join(',', printSettings));
        startInfo.ArgumentList.Add("-silent");
        startInfo.ArgumentList.Add(filePath);

        return new Process { StartInfo = startInfo };
    }

    private static string NormalizePaperSetting(string? paperSize) =>
        paperSize?.Trim().ToLowerInvariant() switch
        {
            "letter" => "paper=letter",
            // In SumatraPDF, standard paper names do not include "8.5 x 13 in" or "folio".
            // "paperkind=14" explicitly sets Windows DMPAPER_FOLIO (14), which maps
            // directly to the Epson driver's "8.5 x 13 in" preset (RawKind 14).
            "legal" or "folio" => "paperkind=14",
            _ => "paper=A4"
        };

    private async Task<DocumentPrintResult> VerifySpoolerDocumentLifecycleAsync(
        string dispatchPrinterName,
        string physicalPrinterName,
        string documentName,
        int expectedPages,
        int minimumSpoolerPages,
        Func<int, int, Task> onProgress,
        Func<string, Task> onPaused,
        Func<Task> onResumed,
        CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow.Add(SpoolerProgressGracePeriod);
        var patienceDeadline = DateTime.UtcNow.AddMinutes(_settings.PauseTimeoutMinutes);
        var activePrintDeadline = DateTime.UtcNow.AddSeconds(
            Math.Max(_settings.PrintTimeoutSeconds, expectedPages * 90));
        var inPatienceMode = false;
        var observedActive = false;
        var maxPagesPrinted = 0;
        var lastTotalPages = 0;
        string? lastSpoolerJobId = null;
        string? activeErrorMessage = null;

        try
        {
            while (DateTime.UtcNow < deadline ||
                   (inPatienceMode && DateTime.UtcNow < patienceDeadline))
            {
                cancellationToken.ThrowIfCancellationRequested();

                var (exists, statusMask, jobStatus, printed, total, jobId) =
                    _healthMonitor.QueryJobStatus(dispatchPrinterName, documentName);

                if (exists)
                {
                    lastSpoolerJobId = jobId;
                    lastTotalPages = Math.Max(lastTotalPages, total);

                    if (printed > maxPagesPrinted)
                    {
                        maxPagesPrinted = Math.Min(printed, expectedPages);
                        deadline = RefreshVerificationDeadline(
                            deadline,
                            DateTime.UtcNow);
                        activePrintDeadline = DateTime.UtcNow.AddSeconds(
                            Math.Max(_settings.PrintTimeoutSeconds, (expectedPages - maxPagesPrinted + 1) * 90));
                        await onProgress(maxPagesPrinted, expectedPages);
                    }

                    var jobHasError = (statusMask & JobErrorMask) != 0;
                    var fatalMonitorError = _healthMonitor.HasFatalHardwareError(
                        physicalPrinterName,
                        out _,
                        out var fatalMessage);
                    var isDeleting = (statusMask & (0x4 | 0x100)) != 0 ||
                        jobStatus.Contains("Deleting", StringComparison.OrdinalIgnoreCase);

                    if (!jobHasError && !isDeleting)
                    {
                        observedActive = true;
                    }

                    if (jobHasError || fatalMonitorError)
                    {
                        activeErrorMessage = fatalMonitorError
                            ? fatalMessage
                            : $"Spooler error status: {jobStatus} (0x{statusMask:X})";
                        if (!inPatienceMode)
                        {
                            inPatienceMode = true;
                            await onPaused(activeErrorMessage);
                        }
                    }
                    else if (inPatienceMode)
                    {
                        inPatienceMode = false;
                        activeErrorMessage = null;
                        await onResumed();
                        deadline = RefreshVerificationDeadline(
                            deadline,
                            DateTime.UtcNow);
                        activePrintDeadline = DateTime.UtcNow.AddSeconds(
                            Math.Max(_settings.PrintTimeoutSeconds, expectedPages * 90));
                    }
                    else if (!isDeleting)
                    {
                        // Job is actively spooling or printing without error.
                        // Refresh deadline so actively printing jobs don't time out prematurely.
                        if (DateTime.UtcNow < activePrintDeadline)
                        {
                            deadline = RefreshVerificationDeadline(
                                deadline,
                                DateTime.UtcNow);
                        }
                    }
                }
                else
                {
                    if (inPatienceMode)
                    {
                        return Failed(
                            PrintFailureStage.HardwareError,
                            $"Spooler job disappeared while printer remained in error: {activeErrorMessage}",
                            expectedPages,
                            maxPagesPrinted,
                            lastSpoolerJobId);
                    }

                    if (observedActive)
                    {
                        if (lastTotalPages > 0 && lastTotalPages < minimumSpoolerPages)
                        {
                            return Failed(
                                PrintFailureStage.IncompleteOutput,
                                $"Spooler reported {lastTotalPages} of {minimumSpoolerPages} selected pages",
                                expectedPages,
                                maxPagesPrinted,
                                lastSpoolerJobId);
                        }

                        _logger.LogInformation(
                            "Whole-document job cleared; running post-clear hardware guard window");
                        await Task.Delay(
                            TimeSpan.FromSeconds(_settings.PostClearGuardDelaySeconds),
                            cancellationToken);

                        if (_healthMonitor.HasFatalHardwareError(
                            physicalPrinterName,
                            out var code,
                            out var message))
                        {
                            return Failed(
                                PrintFailureStage.HardwareError,
                                $"Post-clear hardware error code {code}: {message}",
                                expectedPages,
                                maxPagesPrinted,
                                lastSpoolerJobId);
                        }

                        return Completed(expectedPages, lastSpoolerJobId);
                    }

                    if (lastSpoolerJobId is not null)
                    {
                        return Cancelled(
                            "Spooler job vanished without printing; likely cancelled by user",
                            expectedPages,
                            maxPagesPrinted,
                            lastSpoolerJobId);
                    }

                    if (_healthMonitor.IsHealthy(physicalPrinterName, out _, out _))
                    {
                        return Completed(expectedPages, null);
                    }
                }

                await Task.Delay(SpoolerPollInterval, cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            if (lastSpoolerJobId is not null || observedActive)
            {
                _healthMonitor.CancelMatchingJobs(
                    dispatchPrinterName,
                    documentName,
                    lastSpoolerJobId);
            }
            throw;
        }

        if (inPatienceMode)
        {
            _healthMonitor.CancelMatchingJobs(
                dispatchPrinterName,
                documentName,
                lastSpoolerJobId);
            return Cancelled(
                "Patience timeout exceeded",
                expectedPages,
                maxPagesPrinted,
                lastSpoolerJobId,
                PrintFailureStage.Timeout);
        }

        if (observedActive && DateTime.UtcNow >= activePrintDeadline)
        {
            _healthMonitor.CancelMatchingJobs(
                dispatchPrinterName,
                documentName,
                lastSpoolerJobId);
            return Failed(
                PrintFailureStage.Timeout,
                "Print job exceeded active print timeout",
                expectedPages,
                maxPagesPrinted,
                lastSpoolerJobId);
        }

        return Failed(
            PrintFailureStage.SpoolerVerification,
            "Job did not appear in spooler or clear successfully",
            expectedPages,
            maxPagesPrinted,
            lastSpoolerJobId);
    }

    private static string FormatPageSelection(IReadOnlyList<int> pages)
    {
        if (pages.Count == 0)
        {
            throw new ArgumentException("At least one page is required", nameof(pages));
        }

        var ranges = new List<string>();
        var start = pages[0];
        var previous = pages[0];

        for (var index = 1; index < pages.Count; index++)
        {
            var current = pages[index];
            if (current == previous + 1)
            {
                previous = current;
                continue;
            }

            ranges.Add(start == previous ? start.ToString() : $"{start}-{previous}");
            start = previous = current;
        }

        ranges.Add(start == previous ? start.ToString() : $"{start}-{previous}");
        return string.Join(',', ranges);
    }

    internal static DateTime RefreshVerificationDeadline(
        DateTime currentDeadline,
        DateTime progressAt)
    {
        var refreshedDeadline = progressAt.Add(SpoolerProgressGracePeriod);
        return refreshedDeadline > currentDeadline
            ? refreshedDeadline
            : currentDeadline;
    }

    private static DocumentPrintResult Completed(int expectedPages, string? spoolerJobId) => new()
    {
        State = PagePrintState.Completed,
        FailureStage = PrintFailureStage.None,
        SpoolerJobId = spoolerJobId,
        PagesPrinted = expectedPages,
        TotalPages = expectedPages,
        PageCountConfidence = PrintPageCountConfidence.Confirmed
    };

    private static DocumentPrintResult Failed(
        PrintFailureStage stage,
        string message,
        int expectedPages,
        int pagesPrinted = 0,
        string? spoolerJobId = null) => new()
        {
            State = PagePrintState.Failed,
            FailureStage = stage,
            ErrorMessage = message,
            SpoolerJobId = spoolerJobId,
            PagesPrinted = pagesPrinted,
            TotalPages = expectedPages,
            PageCountConfidence = pagesPrinted > 0
            ? PrintPageCountConfidence.BestEffort
            : PrintPageCountConfidence.Unknown
        };

    private static DocumentPrintResult Cancelled(
        string message,
        int expectedPages,
        int pagesPrinted,
        string? spoolerJobId,
        PrintFailureStage stage = PrintFailureStage.SpoolerVerification) => new()
        {
            State = PagePrintState.Cancelled,
            FailureStage = stage,
            ErrorMessage = message,
            SpoolerJobId = spoolerJobId,
            PagesPrinted = pagesPrinted,
            TotalPages = expectedPages,
            PageCountConfidence = pagesPrinted > 0
            ? PrintPageCountConfidence.BestEffort
            : PrintPageCountConfidence.Unknown
        };
}
