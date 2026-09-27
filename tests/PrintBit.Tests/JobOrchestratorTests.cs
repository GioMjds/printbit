using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Services.DocumentProcessing;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;
using PrintBit.Shared.Printing;

namespace PrintBit.Tests;

public class JobOrchestratorTests
{
    [Fact]
    public async Task ProcessJobAsync_ThreePagesTwoCopies_DispatchesUnifiedPrintJob()
    {
        var tempPdf = CreatePdf(pageCount: 3);
        try
        {
            var healthMock = CreateHealthyMonitor();
            var dispatches = new List<(string FilePath, int CopyNumber, int[] Pages, int Copies)>();
            var printerMock = new Mock<IDocumentPrinter>();
            printerMock.Setup(p => p.PrintDocumentAsync(
                    It.IsAny<string>(),
                    It.IsAny<string>(),
                    It.IsAny<int>(),
                    It.IsAny<IReadOnlyList<int>>(),
                    It.IsAny<PrintJobSettings>(),
                    It.IsAny<Func<int, int, Task>>(),
                    It.IsAny<Func<string, Task>>(),
                    It.IsAny<Func<Task>>(),
                    It.IsAny<CancellationToken>()))
                .Callback((
                    string filePath,
                    string _,
                    int copyNumber,
                    IReadOnlyList<int> pages,
                    PrintJobSettings settings,
                    Func<int, int, Task> onProgress,
                    Func<string, Task> _,
                    Func<Task> _,
                    CancellationToken _) =>
                {
                    using var process = DocumentPrinter.BuildPrintProcess(
                        "SumatraPDF.exe", filePath, "TestPrinter", pages, settings);
                    Assert.Contains("fit", process.StartInfo.ArgumentList[3].Split(','));
                    dispatches.Add((filePath, copyNumber, pages.ToArray(), settings.Copies));
                    onProgress(1, 6).GetAwaiter().GetResult();
                    onProgress(3, 6).GetAwaiter().GetResult();
                    onProgress(4, 6).GetAwaiter().GetResult();
                    onProgress(6, 6).GetAwaiter().GetResult();
                })
                .ReturnsAsync((
                    string _,
                    string _,
                    int _,
                    IReadOnlyList<int> pages,
                    PrintJobSettings settings,
                    Func<int, int, Task> _,
                    Func<string, Task> _,
                    Func<Task> _,
                    CancellationToken _) => new DocumentPrintResult
                {
                    State = PagePrintState.Completed,
                    PagesPrinted = pages.Count * settings.Copies,
                    TotalPages = pages.Count * settings.Copies,
                    PageCountConfidence = "confirmed"
                });

            var events = new List<WorkerPrintEvent>();
            var eventPipeMock = CreateEventPipe(events);
            var sut = CreateSut(healthMock.Object, printerMock.Object, eventPipeMock.Object);

            var result = await sut.ProcessJobAsync(
                new PrintJobRequest
                {
                    FilePath = tempPdf,
                    PrinterName = "TestPrinter",
                    Settings = new PrintJobSettings { Copies = 2 }
                },
                Path.ChangeExtension(tempPdf, ".json"),
                CancellationToken.None);

            Assert.True(result.Success);
            Assert.Equal(6, result.PagesPrinted);
            Assert.Equal(6, result.TotalPages);
            Assert.Equal("confirmed", result.PageCountConfidence);
            Assert.Equal(
                [
                    WorkerPrintEventType.PrintStarted,
                    WorkerPrintEventType.PrintProgress,
                    WorkerPrintEventType.PrintProgress,
                    WorkerPrintEventType.PrintProgress,
                    WorkerPrintEventType.PrintProgress,
                    WorkerPrintEventType.PrintSucceeded
                ],
                events.Select(evt => evt.Type));
            Assert.Equal(
                [1, 3, 4, 6],
                events
                    .Where(evt => evt.Type == WorkerPrintEventType.PrintProgress)
                    .Select(evt => evt.PagesPrinted));
            Assert.All(
                events.Where(evt => evt.Type == WorkerPrintEventType.PrintProgress),
                evt => Assert.Equal(6, evt.TotalPages));
            Assert.Single(dispatches);
            Assert.Equal(tempPdf, dispatches[0].FilePath);
            Assert.Equal([1, 2, 3], dispatches[0].Pages);
            Assert.Equal(2, dispatches[0].Copies);

            var terminal = Assert.Single(events, evt =>
                evt.Type is WorkerPrintEventType.PrintSucceeded or WorkerPrintEventType.PrintFailed);
            Assert.Equal(WorkerPrintEventType.PrintSucceeded, terminal.Type);
            Assert.Equal(6, terminal.CompletedCount);
            Assert.Equal(6, terminal.TotalExpected);
            Assert.Equal("confirmed", terminal.PageCountConfidence);
            Assert.All(terminal.Pages!, page => Assert.Equal("completed", page.State));
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task ProcessJobAsync_SecondCopyPartiallyFails_EmitsFailedBestEffortResult()
    {
        var tempPdf = CreatePdf(pageCount: 3);
        try
        {
            var healthMock = CreateHealthyMonitor();
            var printerMock = new Mock<IDocumentPrinter>();
            printerMock.Setup(p => p.PrintDocumentAsync(
                    It.IsAny<string>(),
                    It.IsAny<string>(),
                    It.IsAny<int>(),
                    It.IsAny<IReadOnlyList<int>>(),
                    It.IsAny<PrintJobSettings>(),
                    It.IsAny<Func<int, int, Task>>(),
                    It.IsAny<Func<string, Task>>(),
                    It.IsAny<Func<Task>>(),
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync(new DocumentPrintResult
                {
                    State = PagePrintState.Failed,
                    FailureStage = PrintFailureStage.HardwareError,
                    ErrorMessage = "Out of paper",
                    PagesPrinted = 4,
                    TotalPages = 6,
                    PageCountConfidence = "best_effort"
                });

            var events = new List<WorkerPrintEvent>();
            var eventPipeMock = CreateEventPipe(events);
            var sut = CreateSut(healthMock.Object, printerMock.Object, eventPipeMock.Object);

            var result = await sut.ProcessJobAsync(
                new PrintJobRequest
                {
                    FilePath = tempPdf,
                    PrinterName = "TestPrinter",
                    Settings = new PrintJobSettings { Copies = 2 }
                },
                Path.ChangeExtension(tempPdf, ".json"),
                CancellationToken.None);

            Assert.False(result.Success);
            Assert.Equal(PrintFailureStage.HardwareError, result.FailureStage);
            Assert.Equal(4, result.PagesPrinted);
            Assert.Equal(6, result.TotalPages);
            Assert.Equal("best_effort", result.PageCountConfidence);

            var terminal = Assert.Single(events, evt =>
                evt.Type is WorkerPrintEventType.PrintSucceeded or WorkerPrintEventType.PrintFailed);
            Assert.Equal(WorkerPrintEventType.PrintFailed, terminal.Type);
            Assert.Equal("partially_completed", terminal.Outcome);
            Assert.Equal(4, terminal.CompletedCount);
            Assert.Equal(1, terminal.FailedCount);
            Assert.Equal(1, terminal.CancelledCount);
            Assert.Equal("best_effort", terminal.PageCountConfidence);
            Assert.Equal(
                ["completed", "failed", "cancelled"],
                terminal.Pages!.Where(page => page.Copy == 2).Select(page => page.State));
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task ProcessJobAsync_PreprocessesBeforeCountingAndDispatch()
    {
        var sourcePdf = CreatePdf(pageCount: 3);
        var preparedPdf = CreatePdf(pageCount: 1);
        try
        {
            var preprocessor = new Mock<IDocumentPreprocessor>();
            preprocessor.Setup(service => service.PrepareAsync(
                    sourcePdf,
                    It.Is<PrintJobSettings>(settings => settings.RotationDeg == 90),
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync(new PreparedDocument(preparedPdf, 1, [preparedPdf]));
            var printer = new Mock<IDocumentPrinter>();
            printer.Setup(service => service.PrintDocumentAsync(
                    preparedPdf,
                    "TestPrinter",
                    1,
                    It.Is<IReadOnlyList<int>>(pages => pages.SequenceEqual(new[] { 1 })),
                    It.Is<PrintJobSettings>(settings =>
                        settings.RotationDeg == 0 && settings.PageRange == null),
                    It.IsAny<Func<int, int, Task>>(),
                    It.IsAny<Func<string, Task>>(),
                    It.IsAny<Func<Task>>(),
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync(new DocumentPrintResult
                {
                    State = PagePrintState.Completed,
                    PagesPrinted = 1,
                    TotalPages = 1,
                    PageCountConfidence = "confirmed"
                });

            var sut = CreateSut(
                CreateHealthyMonitor().Object,
                printer.Object,
                CreateEventPipe([]).Object,
                preprocessor: preprocessor.Object);

            var result = await sut.ProcessJobAsync(
                new PrintJobRequest
                {
                    FilePath = sourcePdf,
                    PrinterName = "TestPrinter",
                    Settings = new PrintJobSettings
                    {
                        RotationDeg = 90,
                        PageRange = "2"
                    }
                },
                Path.ChangeExtension(sourcePdf, ".json"),
                CancellationToken.None);

            Assert.True(result.Success);
            printer.VerifyAll();
        }
        finally
        {
            File.Delete(sourcePdf);
            File.Delete(preparedPdf);
        }
    }

    [Fact]
    public async Task ProcessJobAsync_InvalidFilename_ReturnsValidationFailure()
    {
        var sut = CreateSut(
            Mock.Of<IPrinterHealthMonitor>(),
            Mock.Of<IDocumentPrinter>(),
            Mock.Of<IWorkerEventPipeClient>());

        var result = await sut.ProcessJobAsync(
            new PrintJobRequest
            {
                FilePath = "invalidfilename.pdf",
                PrinterName = "TestPrinter"
            },
            "invalidfilename.json",
            CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal(PrintFailureStage.Validation, result.FailureStage);
    }

    [Fact]
    public async Task ProcessJobAsync_WhenRecoveryLeaseIsHeld_WaitsForReleaseBeforeDispatch()
    {
        var tempPdf = CreatePdf(pageCount: 1);
        try
        {
            var coordinator = new PrintOperationCoordinator();
            var acquired = coordinator.TryAcquireRecovery(out var recoveryLease);
            Assert.True(acquired);
            Assert.NotNull(recoveryLease);

            var healthMock = CreateHealthyMonitor();
            var dispatched = new TaskCompletionSource<bool>();
            var printerMock = new Mock<IDocumentPrinter>();
            printerMock.Setup(p => p.PrintDocumentAsync(
                    It.IsAny<string>(),
                    It.IsAny<string>(),
                    It.IsAny<int>(),
                    It.IsAny<IReadOnlyList<int>>(),
                    It.IsAny<PrintJobSettings>(),
                    It.IsAny<Func<int, int, Task>>(),
                    It.IsAny<Func<string, Task>>(),
                    It.IsAny<Func<Task>>(),
                    It.IsAny<CancellationToken>()))
                .Callback(() => dispatched.TrySetResult(true))
                .ReturnsAsync(new DocumentPrintResult
                {
                    State = PagePrintState.Completed,
                    PagesPrinted = 1,
                    TotalPages = 1,
                    PageCountConfidence = "confirmed"
                });

            var events = new List<WorkerPrintEvent>();
            var eventPipeMock = CreateEventPipe(events);
            var sut = CreateSut(healthMock.Object, printerMock.Object, eventPipeMock.Object, coordinator);

            var processTask = sut.ProcessJobAsync(
                new PrintJobRequest
                {
                    FilePath = tempPdf,
                    PrinterName = "TestPrinter",
                    Settings = new PrintJobSettings { Copies = 1 }
                },
                Path.ChangeExtension(tempPdf, ".json"),
                CancellationToken.None);

            await Task.Delay(100);

            Assert.False(dispatched.Task.IsCompleted);
            Assert.Empty(events);
            printerMock.Verify(p => p.PrintDocumentAsync(
                It.IsAny<string>(),
                It.IsAny<string>(),
                It.IsAny<int>(),
                It.IsAny<IReadOnlyList<int>>(),
                It.IsAny<PrintJobSettings>(),
                It.IsAny<Func<int, int, Task>>(),
                It.IsAny<Func<string, Task>>(),
                It.IsAny<Func<Task>>(),
                It.IsAny<CancellationToken>()), Times.Never);

            recoveryLease.Dispose();

            var result = await processTask;
            Assert.True(result.Success);
            Assert.True(dispatched.Task.IsCompleted);
            printerMock.Verify(p => p.PrintDocumentAsync(
                It.IsAny<string>(),
                It.IsAny<string>(),
                It.IsAny<int>(),
                It.IsAny<IReadOnlyList<int>>(),
                It.IsAny<PrintJobSettings>(),
                It.IsAny<Func<int, int, Task>>(),
                It.IsAny<Func<string, Task>>(),
                It.IsAny<Func<Task>>(),
                It.IsAny<CancellationToken>()), Times.Once);
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task ProcessJobAsync_WhilePrintJobIsActive_TryAcquireRecoveryReturnsBusy()
    {
        var tempPdf = CreatePdf(pageCount: 1);
        try
        {
            var coordinator = new PrintOperationCoordinator();
            var healthMock = CreateHealthyMonitor();
            var printEntered = new TaskCompletionSource<bool>();
            var allowPrintToFinish = new TaskCompletionSource<bool>();

            bool? recoveryAcquisitionDuringPrint = null;
            IDisposable? recoveryLeaseDuringPrint = null;

            var printerMock = new Mock<IDocumentPrinter>();
            printerMock.Setup(p => p.PrintDocumentAsync(
                    It.IsAny<string>(),
                    It.IsAny<string>(),
                    It.IsAny<int>(),
                    It.IsAny<IReadOnlyList<int>>(),
                    It.IsAny<PrintJobSettings>(),
                    It.IsAny<Func<int, int, Task>>(),
                    It.IsAny<Func<string, Task>>(),
                    It.IsAny<Func<Task>>(),
                    It.IsAny<CancellationToken>()))
                .Returns(async () =>
                {
                    printEntered.TrySetResult(true);
                    recoveryAcquisitionDuringPrint = coordinator.TryAcquireRecovery(out recoveryLeaseDuringPrint);
                    await allowPrintToFinish.Task;
                    return new DocumentPrintResult
                    {
                        State = PagePrintState.Completed,
                        PagesPrinted = 1,
                        TotalPages = 1,
                        PageCountConfidence = "confirmed"
                    };
                });

            var events = new List<WorkerPrintEvent>();
            var eventPipeMock = CreateEventPipe(events);
            var sut = CreateSut(healthMock.Object, printerMock.Object, eventPipeMock.Object, coordinator);

            var processTask = sut.ProcessJobAsync(
                new PrintJobRequest
                {
                    FilePath = tempPdf,
                    PrinterName = "TestPrinter",
                    Settings = new PrintJobSettings { Copies = 1 }
                },
                Path.ChangeExtension(tempPdf, ".json"),
                CancellationToken.None);

            await printEntered.Task;
            Assert.False(recoveryAcquisitionDuringPrint);
            Assert.Null(recoveryLeaseDuringPrint);

            allowPrintToFinish.TrySetResult(true);
            var result = await processTask;
            Assert.True(result.Success);

            var acquiredAfterPrint = coordinator.TryAcquireRecovery(out var leaseAfterPrint);
            Assert.True(acquiredAfterPrint);
            Assert.NotNull(leaseAfterPrint);
            leaseAfterPrint.Dispose();
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    private static JobOrchestrator CreateSut(
        IPrinterHealthMonitor healthMonitor,
        IDocumentPrinter documentPrinter,
        IWorkerEventPipeClient eventPipe,
        IPrinterOperationCoordinator? coordinator = null,
        IDocumentPreprocessor? preprocessor = null)
    {
        return new JobOrchestrator(
            NullLogger<JobOrchestrator>.Instance,
            Options.Create(new HardwareSettings
            {
                QpdfPath = "qpdf.exe",
                PrinterName = "TestPrinter",
                PauseTimeoutMinutes = 1
            }),
            documentPrinter,
            healthMonitor,
            eventPipe,
            coordinator ?? new PrintOperationCoordinator(),
            preprocessor ?? CreatePassthroughPreprocessor());
    }

    private static IDocumentPreprocessor CreatePassthroughPreprocessor()
    {
        var preprocessor = new Mock<IDocumentPreprocessor>();
        preprocessor.Setup(service => service.PrepareAsync(
                It.IsAny<string>(),
                It.IsAny<PrintJobSettings>(),
                It.IsAny<CancellationToken>()))
            .Returns((string path, PrintJobSettings _, CancellationToken _) =>
                Task.FromResult(new PreparedDocument(
                    path,
                    PdfPageCounter.Count(path, "qpdf.exe") ?? 0,
                    [])));
        return preprocessor.Object;
    }

    private static Mock<IPrinterHealthMonitor> CreateHealthyMonitor()
    {
        var monitor = new Mock<IPrinterHealthMonitor>();
        var status = 0;
        var description = "OK";
        monitor.Setup(h => h.IsHealthy("TestPrinter", out status, out description))
            .Returns(true);
        return monitor;
    }

    private static Mock<IWorkerEventPipeClient> CreateEventPipe(List<WorkerPrintEvent> events)
    {
        var pipe = new Mock<IWorkerEventPipeClient>();
        pipe.Setup(p => p.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()))
            .Callback((WorkerPrintEvent evt, CancellationToken _) => events.Add(evt))
            .ReturnsAsync(true);
        return pipe;
    }

    private static string CreatePdf(int pageCount)
    {
        var path = Path.Combine(
            Path.GetTempPath(),
            $"tx-123_spool-456_{Guid.NewGuid():N}.pdf");
        File.WriteAllText(path, $"%PDF-1.7\n/Type /Pages /Count {pageCount}");
        return path;
    }
}
