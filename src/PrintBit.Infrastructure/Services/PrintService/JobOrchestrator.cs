using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.DocumentProcessing;
using PrintBit.Shared.Configurations;
using PrintBit.Shared.Printing;

namespace PrintBit.Infrastructure.Services.PrintService;

public sealed class JobOrchestrator : IJobOrchestrator
{
    private readonly ILogger<JobOrchestrator> _logger;
    private readonly HardwareSettings _settings;
    private readonly IDocumentPrinter _documentPrinter;
    private readonly IPrinterHealthMonitor _healthMonitor;
    private readonly IWorkerEventPipeClient _eventPipe;
    private readonly IPrinterOperationCoordinator _coordinator;
    private readonly IDocumentPreprocessor _documentPreprocessor;

    public JobOrchestrator(
        ILogger<JobOrchestrator> logger,
        IOptions<HardwareSettings> options,
        IDocumentPrinter documentPrinter,
        IPrinterHealthMonitor healthMonitor,
        IWorkerEventPipeClient eventPipe,
        IPrinterOperationCoordinator coordinator,
        IDocumentPreprocessor documentPreprocessor)
    {
        _logger = logger;
        _settings = options.Value;
        _documentPrinter = documentPrinter;
        _healthMonitor = healthMonitor;
        _eventPipe = eventPipe;
        _coordinator = coordinator;
        _documentPreprocessor = documentPreprocessor;
    }

    public async Task<PrintJobResult> ProcessJobAsync(
        PrintJobRequest request,
        string jsonFilePath,
        CancellationToken cancellationToken)
    {
        using var printLease = await _coordinator.AcquirePrintAsync(cancellationToken);

        _ = jsonFilePath;
        var fileName = Path.GetFileName(request.FilePath);
        var (transactionId, spoolerCorrelationKey) =
            PrintJobFileName.TryParseCorrelation(fileName);

        if (transactionId is null || spoolerCorrelationKey is null)
        {
            return PrintJobResult.Failed(
                PrintFailureStage.Validation,
                "Filename does not match the tx_spool layout");
        }

        PreparedDocument prepared;
        try
        {
            prepared = await _documentPreprocessor.PrepareAsync(
                request.FilePath,
                request.Settings,
                cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Document preprocessing failed for {file}", request.FilePath);
            var failedAt = DateTime.UtcNow;
            await SendEventAsync(new WorkerPrintEvent
            {
                Type = WorkerPrintEventType.PrintFailed,
                TransactionId = transactionId,
                SpoolerCorrelationKey = spoolerCorrelationKey,
                PrinterName = request.PrinterName,
                FileName = fileName,
                Outcome = "failed",
                TotalPages = 0,
                PagesPrinted = 0,
                PageCountConfidence = PrintPageCountConfidence.Unknown,
                TotalCopies = Math.Max(1, request.Settings.Copies),
                TotalExpected = 0,
                FailureStage = PrintFailureStage.Validation.ToString(),
                Message = $"Document preprocessing failed: {ex.Message}",
                StartedAt = failedAt,
                CompletedAt = DateTime.UtcNow
            }, cancellationToken);

            return PrintJobResult.Failed(
                PrintFailureStage.Validation,
                $"Document preprocessing failed: {ex.Message}");
        }

        using var preparedScope = prepared;
        var totalCopies = Math.Max(1, request.Settings.Copies);
        var dispatchSettings = new PrintJobSettings
        {
            Copies = totalCopies,
            Color = request.Settings.Color,
            Quality = request.Settings.Quality,
            Orientation = request.Settings.Orientation,
            RotationDeg = 0,
            PaperSize = request.Settings.PaperSize,
            // Pass the customer's scaling preference (defaults to "fit"), so SumatraPDF
            // fits the page to the printer's printable margins (matching driver "Fit to Page")
            // and avoids physical hardware border cutouts.
            Scaling = request.Settings.Scaling,
            PageRange = null,
            Duplex = false
        };

        var pdfPageCount = prepared.PageCount;
        if (pdfPageCount <= 0)
        {
            _logger.LogError(
                "Could not determine PDF page count for {file}",
                request.FilePath);
            return PrintJobResult.Failed(
                PrintFailureStage.Validation,
                "Could not determine PDF page count or PDF is corrupt");
        }

        var pagesToPrint = GetPagesInRange(
            pdfPageCount,
            null);
        if (pagesToPrint.Count == 0)
        {
            return PrintJobResult.Failed(
                PrintFailureStage.Validation,
                "Page range did not select any pages");
        }

        var manifest = BuildManifest(pagesToPrint, totalCopies);
        var startedAt = DateTime.UtcNow;

        await SendEventAsync(new WorkerPrintEvent
        {
            Type = WorkerPrintEventType.PrintStarted,
            TransactionId = transactionId,
            SpoolerCorrelationKey = spoolerCorrelationKey,
            PrinterName = request.PrinterName,
            FileName = fileName,
            TotalPages = manifest.Count,
            TotalExpected = manifest.Count,
            TotalCopies = totalCopies,
            TimestampUtc = startedAt
        }, cancellationToken);

        PrintFailureStage failureStage = PrintFailureStage.None;
        string? failureMessage = null;
        string? spoolerJobId = null;
        var failureConfidence = PrintPageCountConfidence.Unknown;
        var lastEmittedProgress = 0;

        cancellationToken.ThrowIfCancellationRequested();

        if (!_healthMonitor.IsHealthy(request.PrinterName, out _, out _) &&
            !await WaitForPreFlightHealthAsync(
                request,
                manifest[0],
                cancellationToken))
        {
            _healthMonitor.HasFatalHardwareError(request.PrinterName, out _, out var fatalDesc);
            manifest[0].State = PagePrintState.Failed;
            manifest[0].ErrorMessage = string.IsNullOrWhiteSpace(fatalDesc)
                ? "Pause timeout exceeded during pre-flight health wait"
                : $"Printer remained unhealthy during pre-flight health wait: {fatalDesc}";
            CancelRemaining(manifest, 1);
            failureStage = PrintFailureStage.HardwareError;
            failureMessage = manifest[0].ErrorMessage;
        }
        else
        {
            var dispatchStartedAt = DateTime.UtcNow;
            foreach (var entry in manifest)
            {
                entry.State = PagePrintState.Printing;
                entry.StartedAt = dispatchStartedAt;
            }

            var result = await _documentPrinter.PrintDocumentAsync(
                prepared.FilePath,
                request.PrinterName,
                1,
                pagesToPrint,
                dispatchSettings,
                async (printed, _) =>
                {
                    var cumulativePagesPrinted = Math.Clamp(printed, 0, manifest.Count);
                    MarkProgress(manifest, cumulativePagesPrinted);
                    if (cumulativePagesPrinted <= lastEmittedProgress)
                    {
                        return;
                    }

                    lastEmittedProgress = cumulativePagesPrinted;
                    await SendProgressEventAsync(
                        transactionId,
                        spoolerCorrelationKey,
                        request.PrinterName,
                        fileName,
                        cumulativePagesPrinted,
                        manifest.Count,
                        totalCopies,
                        cancellationToken);
                },
                error =>
                {
                    var activeEntry = GetActiveEntry(manifest);
                    _logger.LogWarning(
                        "Whole-document print paused at copy {copyNumber}, page {pageNumber}: {error}",
                        activeEntry.CopyNumber,
                        activeEntry.PageNumber,
                        error);
                    return Task.CompletedTask;
                },
                () =>
                {
                    var activeEntry = GetActiveEntry(manifest);
                    _logger.LogInformation(
                        "Whole-document print resumed at copy {copyNumber}, page {pageNumber}",
                        activeEntry.CopyNumber,
                        activeEntry.PageNumber);
                    return Task.CompletedTask;
                },
                cancellationToken);

            spoolerJobId = result.SpoolerJobId ?? spoolerJobId;
            var cumulativePrinted = Math.Clamp(result.PagesPrinted, 0, manifest.Count);
            MarkProgress(manifest, cumulativePrinted);

            if (result.State == PagePrintState.Completed)
            {
                MarkProgress(manifest, manifest.Count);
                if (lastEmittedProgress < manifest.Count)
                {
                    lastEmittedProgress = manifest.Count;
                    await SendProgressEventAsync(
                        transactionId,
                        spoolerCorrelationKey,
                        request.PrinterName,
                        fileName,
                        manifest.Count,
                        manifest.Count,
                        totalCopies,
                        cancellationToken);
                }
            }
            else
            {
                var failedEntry = manifest.FirstOrDefault(
                    entry => entry.State != PagePrintState.Completed);
                if (failedEntry is not null)
                {
                    failedEntry.State = PagePrintState.Failed;
                    failedEntry.ErrorMessage = result.ErrorMessage;
                    failedEntry.CompletedAt = DateTime.UtcNow;
                    CancelRemaining(manifest, failedEntry.SequenceIndex + 1);
                }

                failureStage = result.FailureStage == PrintFailureStage.None
                    ? PrintFailureStage.SpoolerVerification
                    : result.FailureStage;
                failureMessage = result.ErrorMessage ?? "Whole-document print failed";
                failureConfidence = result.PageCountConfidence;
            }
        }

        var completedAt = DateTime.UtcNow;
        var completedCount = manifest.Count(entry => entry.State == PagePrintState.Completed);
        var failedCount = manifest.Count(entry => entry.State == PagePrintState.Failed);
        var cancelledCount = manifest.Count(entry => entry.State == PagePrintState.Cancelled);
        var fullyCompleted = completedCount == manifest.Count && failedCount == 0;
        var outcome = fullyCompleted
            ? "completed"
            : completedCount > 0
                ? "partially_completed"
                : "failed";
        var pageCountConfidence = fullyCompleted
            ? PrintPageCountConfidence.Confirmed
            : failureConfidence;

        var terminalEvent = new WorkerPrintEvent
        {
            Type = fullyCompleted
                ? WorkerPrintEventType.PrintSucceeded
                : WorkerPrintEventType.PrintFailed,
            TransactionId = transactionId,
            SpoolerCorrelationKey = spoolerCorrelationKey,
            SpoolerJobId = spoolerJobId,
            PrinterName = request.PrinterName,
            FileName = fileName,
            Outcome = outcome,
            TotalPages = manifest.Count,
            PagesPrinted = completedCount,
            PageCountConfidence = pageCountConfidence,
            TotalCopies = totalCopies,
            TotalExpected = manifest.Count,
            CompletedCount = completedCount,
            CancelledCount = cancelledCount,
            FailedCount = failedCount,
            Pages = [.. manifest.Select(entry => new WorkerPrintPageResult
            {
                Page = entry.PageNumber,
                Copy = entry.CopyNumber,
                State = entry.State.ToString().ToLowerInvariant()
            })],
            StartedAt = startedAt,
            CompletedAt = completedAt,
            FailureStage = fullyCompleted ? null : failureStage.ToString(),
            Message = fullyCompleted
                ? "Print job completed successfully"
                : $"Print job finished with state: {outcome}. {failureMessage}",
            TimestampUtc = completedAt
        };
        await SendEventAsync(terminalEvent, cancellationToken);

        if (!fullyCompleted)
        {
            return PrintJobResult.Failed(
                failureStage,
                failureMessage ?? "Print job failed",
                spoolerJobId: spoolerJobId,
                pagesPrinted: completedCount,
                totalPages: manifest.Count,
                pageCountConfidence: pageCountConfidence);
        }

        return new PrintJobResult
        {
            Success = true,
            Message = "Print job completed",
            SumatraProcessSucceeded = true,
            VerificationSucceeded = true,
            FailureStage = PrintFailureStage.None,
            SpoolerJobId = spoolerJobId,
            SpoolerPrinterName = request.PrinterName,
            PagesPrinted = completedCount,
            TotalPages = manifest.Count,
            PageCountConfidence = PrintPageCountConfidence.Confirmed
        };
    }

    private static void MarkProgress(
        IReadOnlyList<PagePrintEntry> copyEntries,
        int printedWithinCopy)
    {
        var completedWithinCopy = Math.Clamp(
            printedWithinCopy,
            0,
            copyEntries.Count);

        for (var index = 0; index < completedWithinCopy; index++)
        {
            var entry = copyEntries[index];
            if (entry.State == PagePrintState.Completed) continue;

            entry.State = PagePrintState.Completed;
            entry.CompletedAt = DateTime.UtcNow;
        }
    }

    private async Task<bool> WaitForPreFlightHealthAsync(
        PrintJobRequest request,
        PagePrintEntry entry,
        CancellationToken cancellationToken)
    {
        _logger.LogWarning(
            "Whole-document copy {copyNumber} waiting for printer health before page {pageNumber}",
            entry.CopyNumber,
            entry.PageNumber);

        var deadline = DateTime.UtcNow.AddMinutes(_settings.PauseTimeoutMinutes);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(2000, cancellationToken);

            if (_healthMonitor.IsHealthy(request.PrinterName, out _, out _))
            {
                _logger.LogInformation(
                    "Printer recovered before whole-document copy {copyNumber}",
                    entry.CopyNumber);
                return true;
            }
        }

        return false;
    }

    private Task SendEventAsync(
        WorkerPrintEvent evt,
        CancellationToken cancellationToken) =>
        _eventPipe.SendAsync(evt, cancellationToken);

    private Task SendProgressEventAsync(
        string transactionId,
        string spoolerCorrelationKey,
        string printerName,
        string fileName,
        int pagesPrinted,
        int totalPages,
        int totalCopies,
        CancellationToken cancellationToken) =>
        SendEventAsync(new WorkerPrintEvent
        {
            Type = WorkerPrintEventType.PrintProgress,
            TransactionId = transactionId,
            SpoolerCorrelationKey = spoolerCorrelationKey,
            PrinterName = printerName,
            FileName = fileName,
            PagesPrinted = pagesPrinted,
            TotalPages = totalPages,
            TotalCopies = totalCopies,
            TotalExpected = totalPages,
            TimestampUtc = DateTime.UtcNow
        }, cancellationToken);

    private static PagePrintEntry GetActiveEntry(
        IReadOnlyList<PagePrintEntry> entries) =>
        entries.FirstOrDefault(entry => entry.State != PagePrintState.Completed) ??
        entries[^1];

    private static List<PagePrintEntry> BuildManifest(
        IReadOnlyList<int> pages,
        int totalCopies)
    {
        var manifest = new List<PagePrintEntry>(pages.Count * totalCopies);
        var sequenceIndex = 0;
        for (var copyNumber = 1; copyNumber <= totalCopies; copyNumber++)
        {
            foreach (var pageNumber in pages)
            {
                manifest.Add(new PagePrintEntry
                {
                    PageNumber = pageNumber,
                    CopyNumber = copyNumber,
                    SequenceIndex = sequenceIndex++,
                    State = PagePrintState.Pending
                });
            }
        }
        return manifest;
    }

    private static List<int> GetPagesInRange(int pdfPageCount, string? pageRange)
    {
        if (string.IsNullOrWhiteSpace(pageRange))
        {
            return Enumerable.Range(1, pdfPageCount).ToList();
        }

        var pages = new List<int>();
        var parts = pageRange.Split(
            ',',
            StringSplitOptions.RemoveEmptyEntries |
            StringSplitOptions.TrimEntries);

        foreach (var part in parts)
        {
            if (part.Contains('-'))
            {
                var endpoints = part.Split(
                    '-',
                    StringSplitOptions.RemoveEmptyEntries |
                    StringSplitOptions.TrimEntries);
                if (endpoints.Length != 2 ||
                    !int.TryParse(endpoints[0], out var start) ||
                    !int.TryParse(endpoints[1], out var end))
                {
                    continue;
                }

                var step = start <= end ? 1 : -1;
                for (var page = start;
                     start <= end ? page <= end : page >= end;
                     page += step)
                {
                    if (page >= 1 && page <= pdfPageCount)
                    {
                        pages.Add(page);
                    }
                }
            }
            else if (int.TryParse(part, out var page) &&
                     page >= 1 && page <= pdfPageCount)
            {
                pages.Add(page);
            }
        }

        return pages;
    }

    private static void CancelRemaining(
        IReadOnlyList<PagePrintEntry> manifest,
        int startIndex)
    {
        for (var index = startIndex; index < manifest.Count; index++)
        {
            if (manifest[index].State != PagePrintState.Completed)
            {
                manifest[index].State = PagePrintState.Cancelled;
            }
        }
    }
}
