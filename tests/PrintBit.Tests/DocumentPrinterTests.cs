using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;
using PrintBit.Shared.Printing;

namespace PrintBit.Tests;

public class DocumentPrinterTests
{
    [Fact]
    public void BuildPrintProcess_ExplicitActualSizeDoesNotFitAgain()
    {
        var settings = System.Text.Json.JsonSerializer.Deserialize<PrintJobSettings>(
            "{\"scaling\":\"actual\",\"paperSize\":\"Letter\"}",
            new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        using var process = DocumentPrinter.BuildPrintProcess(
            "SumatraPDF.exe", "prepared.pdf", "TestPrinter", [1], settings);
        Assert.Contains("noscale", process.StartInfo.ArgumentList[3].Split(','));
        Assert.DoesNotContain("fit", process.StartInfo.ArgumentList[3].Split(','));
    }

    [Fact]
    public void SpoolerPolling_IsFrequentEnoughForResponsiveProgress()
    {
        Assert.True(DocumentPrinter.SpoolerPollInterval <= TimeSpan.FromMilliseconds(500));
    }

    [Fact]
    public void RefreshVerificationDeadline_ProgressRestartsGraceWindow()
    {
        var startedAt = new DateTime(2026, 9, 11, 0, 0, 0, DateTimeKind.Utc);
        var originalDeadline = startedAt.AddSeconds(45);
        var progressAt = startedAt.AddSeconds(44);

        var refreshed = DocumentPrinter.RefreshVerificationDeadline(
            originalDeadline,
            progressAt);

        Assert.Equal(progressAt.AddSeconds(45), refreshed);
    }

    [Fact]
    public void BuildPrintProcess_UsesOriginalPdfWithNativeCopiesAndSelectedPages()
    {
        using var process = DocumentPrinter.BuildPrintProcess(
            "SumatraPDF.exe",
            @"C:\PrintBit\job.pdf",
            "EPSON L5290 Series",
            [1, 2, 3],
            new PrintJobSettings
            {
                Copies = 3,
                Color = true,
                Orientation = "landscape",
                RotationDeg = 90,
                PaperSize = "Legal"
            });

        var args = process.StartInfo.ArgumentList;
        Assert.Equal("-print-to", args[0]);
        Assert.Equal("EPSON L5290 Series", args[1]);
        Assert.Equal("-print-settings", args[2]);
        Assert.Equal(
            "3x,color,1-3,paperkind=14,landscape,fit,ignore-pdf-print-settings,collate",
            args[3]);
        Assert.Equal("-silent", args[4]);
        Assert.Equal(@"C:\PrintBit\job.pdf", args[5]);
    }

    [Fact]
    public async Task PrintDocumentAsync_ClearedHealthyJob_ConfirmsExpectedPages()
    {
        var dummyExe = GetDummyExecutablePath();
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllText(tempPdf, "%PDF");

        try
        {
            var healthMock = new Mock<IPrinterHealthMonitor>();
            var pollCount = 0;
            healthMock.Setup(h => h.QueryJobStatus(It.IsAny<string>(), It.IsAny<string>()))
                .Returns(() => ++pollCount == 1
                    ? (true, 0x10u, "Printing", 2, 3, "123")
                    : (false, 0u, string.Empty, 0, 0, null));

            var errorCode = 0;
            var errorMessage = string.Empty;
            healthMock.Setup(h => h.HasFatalHardwareError(It.IsAny<string>(), out errorCode, out errorMessage))
                .Returns(false);

            var progress = new List<int>();
            var sut = CreateSut(dummyExe, healthMock.Object);

            var result = await sut.PrintDocumentAsync(
                tempPdf,
                "TestPrinter",
                1,
                [1, 2, 3],
                new PrintJobSettings(),
                (printed, _) => { progress.Add(printed); return Task.CompletedTask; },
                _ => Task.CompletedTask,
                () => Task.CompletedTask,
                CancellationToken.None);

            Assert.Equal(PagePrintState.Completed, result.State);
            Assert.Equal(3, result.PagesPrinted);
            Assert.Equal(3, result.TotalPages);
            Assert.Equal("confirmed", result.PageCountConfidence);
            Assert.Equal([2], progress);
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task PrintDocumentAsync_ActivePrintingWithoutError_ContinuesWaitingAndSucceedsWhenJobClears()
    {
        var dummyExe = GetDummyExecutablePath();
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllText(tempPdf, "%PDF");

        try
        {
            var healthMock = new Mock<IPrinterHealthMonitor>();
            var pollCount = 0;
            healthMock.Setup(h => h.QueryJobStatus(It.IsAny<string>(), It.IsAny<string>()))
                .Returns(() => ++pollCount <= 3
                    ? (true, 0x10u, "Printing", 1, 1, "123")
                    : (false, 0u, string.Empty, 0, 0, null));

            var errorCode = 0;
            var errorMessage = string.Empty;
            healthMock.Setup(h => h.HasFatalHardwareError(It.IsAny<string>(), out errorCode, out errorMessage))
                .Returns(false);

            var sut = CreateSut(dummyExe, healthMock.Object);

            var result = await sut.PrintDocumentAsync(
                tempPdf,
                "TestPrinter",
                1,
                [1],
                new PrintJobSettings(),
                (_, _) => Task.CompletedTask,
                _ => Task.CompletedTask,
                () => Task.CompletedTask,
                CancellationToken.None);

            Assert.Equal(PagePrintState.Completed, result.State);
            Assert.Equal(1, result.PagesPrinted);
            Assert.Equal(1, result.TotalPages);
            Assert.Equal("confirmed", result.PageCountConfidence);
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task PrintDocumentAsync_ClearedTruncatedJob_ReturnsIncompleteOutput()
    {
        var dummyExe = GetDummyExecutablePath();
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllText(tempPdf, "%PDF");

        try
        {
            var healthMock = new Mock<IPrinterHealthMonitor>();
            var pollCount = 0;
            healthMock.Setup(h => h.QueryJobStatus(It.IsAny<string>(), It.IsAny<string>()))
                .Returns(() => ++pollCount == 1
                    ? (true, 0x10u, "Printing", 1, 2, "123")
                    : (false, 0u, string.Empty, 0, 0, null));

            var sut = CreateSut(dummyExe, healthMock.Object);
            var result = await sut.PrintDocumentAsync(
                tempPdf,
                "TestPrinter",
                1,
                [1, 2, 3],
                new PrintJobSettings(),
                (_, _) => Task.CompletedTask,
                _ => Task.CompletedTask,
                () => Task.CompletedTask,
                CancellationToken.None);

            Assert.Equal(PagePrintState.Failed, result.State);
            Assert.Equal(PrintFailureStage.IncompleteOutput, result.FailureStage);
            Assert.Equal(1, result.PagesPrinted);
            Assert.Equal(3, result.TotalPages);
            Assert.Equal("best_effort", result.PageCountConfidence);
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task PrintDocumentAsync_PaperOutPausesThenResumesSameJob()
    {
        var dummyExe = GetDummyExecutablePath();
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllText(tempPdf, "%PDF");

        try
        {
            var healthMock = new Mock<IPrinterHealthMonitor>();
            var pollCount = 0;
            healthMock.Setup(h => h.QueryJobStatus(It.IsAny<string>(), It.IsAny<string>()))
                .Returns(() => ++pollCount switch
                {
                    1 => (true, 0x40u, "Paper Out", 0, 3, "123"),
                    2 => (true, 0x10u, "Printing", 1, 3, "123"),
                    _ => (false, 0u, string.Empty, 0, 0, null)
                });

            var errorCode = 0;
            var errorMessage = string.Empty;
            healthMock.Setup(h => h.HasFatalHardwareError(It.IsAny<string>(), out errorCode, out errorMessage))
                .Returns(false);

            var paused = false;
            var resumed = false;
            var sut = CreateSut(dummyExe, healthMock.Object);
            var result = await sut.PrintDocumentAsync(
                tempPdf,
                "TestPrinter",
                1,
                [1, 2, 3],
                new PrintJobSettings(),
                (_, _) => Task.CompletedTask,
                _ => { paused = true; return Task.CompletedTask; },
                () => { resumed = true; return Task.CompletedTask; },
                CancellationToken.None);

            Assert.True(paused);
            Assert.True(resumed);
            Assert.Equal(PagePrintState.Completed, result.State);
            Assert.Equal("confirmed", result.PageCountConfidence);
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task PrintDocumentAsync_JobDisappearsWhilePaperOut_ReturnsHardwareFailure()
    {
        var dummyExe = GetDummyExecutablePath();
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllText(tempPdf, "%PDF");

        try
        {
            var healthMock = new Mock<IPrinterHealthMonitor>();
            var pollCount = 0;
            healthMock.Setup(h => h.QueryJobStatus(It.IsAny<string>(), It.IsAny<string>()))
                .Returns(() => ++pollCount switch
                {
                    1 => (true, 0x10u, "Printing", 1, 3, "123"),
                    2 => (true, 0x40u, "Paper Out", 1, 3, "123"),
                    _ => (false, 0u, string.Empty, 0, 0, null)
                });

            var errorCode = 0;
            var errorMessage = string.Empty;
            healthMock.Setup(h => h.HasFatalHardwareError(It.IsAny<string>(), out errorCode, out errorMessage))
                .Returns(false);

            var sut = CreateSut(dummyExe, healthMock.Object);
            var result = await sut.PrintDocumentAsync(
                tempPdf,
                "TestPrinter",
                1,
                [1, 2, 3],
                new PrintJobSettings(),
                (_, _) => Task.CompletedTask,
                _ => Task.CompletedTask,
                () => Task.CompletedTask,
                CancellationToken.None);

            Assert.Equal(PagePrintState.Failed, result.State);
            Assert.Equal(PrintFailureStage.HardwareError, result.FailureStage);
            Assert.Equal(1, result.PagesPrinted);
            Assert.Equal("best_effort", result.PageCountConfidence);
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task PrintDocumentAsync_SumatraTimeout_ReturnsTimeoutFailureWithoutRecovery()
    {
        var dummyExe = GetSleepingDummyExecutablePath();
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllText(tempPdf, "%PDF");

        try
        {
            var healthMock = new Mock<IPrinterHealthMonitor>(MockBehavior.Strict);
            var sut = new DocumentPrinter(
                NullLogger<DocumentPrinter>.Instance,
                Options.Create(new HardwareSettings
                {
                    SumatraPath = dummyExe,
                    PrintTimeoutSeconds = 1,
                    PostClearGuardDelaySeconds = 0
                }),
                healthMock.Object);

            var result = await sut.PrintDocumentAsync(
                tempPdf,
                "TestPrinter",
                1,
                [1, 2, 3],
                new PrintJobSettings(),
                (_, _) => Task.CompletedTask,
                _ => Task.CompletedTask,
                () => Task.CompletedTask,
                CancellationToken.None);

            Assert.Equal(PagePrintState.Failed, result.State);
            Assert.Equal(PrintFailureStage.Timeout, result.FailureStage);
            Assert.Equal("Sumatra process timeout", result.ErrorMessage);
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task PrintDocumentAsync_NativeCopies_AcceptsSpoolerDocumentPageCount()
    {
        var dummyExe = GetDummyExecutablePath();
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllText(tempPdf, "%PDF");

        try
        {
            var healthMock = new Mock<IPrinterHealthMonitor>();
            var pollCount = 0;
            healthMock.Setup(h => h.QueryJobStatus(It.IsAny<string>(), It.IsAny<string>()))
                .Returns(() => ++pollCount == 1
                    ? (true, 0x10u, "Printing", 3, 3, "123")
                    : (false, 0u, string.Empty, 0, 0, null));

            var errorCode = 0;
            var errorMessage = string.Empty;
            healthMock.Setup(h => h.HasFatalHardwareError(It.IsAny<string>(), out errorCode, out errorMessage))
                .Returns(false);

            var sut = CreateSut(dummyExe, healthMock.Object);
            var result = await sut.PrintDocumentAsync(
                tempPdf,
                "TestPrinter",
                1,
                [1, 2, 3],
                new PrintJobSettings { Copies = 2 },
                (_, _) => Task.CompletedTask,
                _ => Task.CompletedTask,
                () => Task.CompletedTask,
                CancellationToken.None);

            Assert.Equal(PagePrintState.Completed, result.State);
            Assert.Equal(6, result.PagesPrinted);
            Assert.Equal(6, result.TotalPages);
            Assert.Equal("confirmed", result.PageCountConfidence);
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task PrintDocumentAsync_HighQuality_UsesHighQueueForSpoolerTracking()
    {
        var dummyExe = GetDummyExecutablePath();
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllText(tempPdf, "%PDF");

        try
        {
            var queriedPrinters = new List<string>();
            var healthMock = new Mock<IPrinterHealthMonitor>();
            var pollCount = 0;
            healthMock.Setup(h => h.QueryJobStatus(It.IsAny<string>(), It.IsAny<string>()))
                .Callback<string, string>((name, _) => queriedPrinters.Add(name))
                .Returns(() => ++pollCount == 1
                    ? (true, 0x10u, "Printing", 1, 1, "123")
                    : (false, 0u, string.Empty, 0, 0, null));

            var errorCode = 0;
            var errorMessage = string.Empty;
            healthMock.Setup(h => h.HasFatalHardwareError(
                    "EPSON L5290 Series",
                    out errorCode,
                    out errorMessage))
                .Returns(false);

            var sut = CreateSut(
                new HardwareSettings
                {
                    SumatraPath = dummyExe,
                    PrintTimeoutSeconds = 5,
                    PostClearGuardDelaySeconds = 0,
                    PrinterName = "EPSON L5290 Series",
                    PrinterProfiles = new PrinterProfileSettings
                    {
                        High = "PrintBit - High"
                    }
                },
                healthMock.Object);

            var result = await sut.PrintDocumentAsync(
                tempPdf,
                "EPSON L5290 Series",
                1,
                [1],
                new PrintJobSettings { Quality = "high" },
                (_, _) => Task.CompletedTask,
                _ => Task.CompletedTask,
                () => Task.CompletedTask,
                CancellationToken.None);

            Assert.Equal(PagePrintState.Completed, result.State);
            Assert.NotEmpty(queriedPrinters);
            Assert.All(queriedPrinters, name => Assert.Equal("PrintBit - High", name));
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task PrintDocumentAsync_HighQualityWithoutProfile_ReturnsValidationFailure()
    {
        var dummyExe = GetDummyExecutablePath();
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllText(tempPdf, "%PDF");

        try
        {
            var sut = CreateSut(
                new HardwareSettings
                {
                    SumatraPath = dummyExe,
                    PrinterName = "EPSON L5290 Series"
                },
                Mock.Of<IPrinterHealthMonitor>());

            var result = await sut.PrintDocumentAsync(
                tempPdf,
                "EPSON L5290 Series",
                1,
                [1],
                new PrintJobSettings { Quality = "high" },
                (_, _) => Task.CompletedTask,
                _ => Task.CompletedTask,
                () => Task.CompletedTask,
                CancellationToken.None);

            Assert.Equal(PagePrintState.Failed, result.State);
            Assert.Equal(PrintFailureStage.Validation, result.FailureStage);
            Assert.Contains("High-quality printer profile", result.ErrorMessage);
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    private static DocumentPrinter CreateSut(string sumatraPath, IPrinterHealthMonitor healthMonitor)
    {
        return CreateSut(
            new HardwareSettings
            {
                SumatraPath = sumatraPath,
                PrintTimeoutSeconds = 5,
                PostClearGuardDelaySeconds = 0
            },
            healthMonitor);
    }

    private static DocumentPrinter CreateSut(
        HardwareSettings settings,
        IPrinterHealthMonitor healthMonitor) =>
        new(
            NullLogger<DocumentPrinter>.Instance,
            Options.Create(settings),
            healthMonitor);

    private static string GetDummyExecutablePath()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "PrintBitDocumentPrinterTests");
        Directory.CreateDirectory(tempDir);
        var exePath = Path.Combine(tempDir, "dummy_sumatra.exe");
        if (File.Exists(exePath)) return exePath;

        var sourcePath = Path.Combine(tempDir, "dummy_sumatra.cs");
        File.WriteAllText(sourcePath, "class Program { static void Main() {} }");

        var cscPath = @"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe";
        var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = cscPath,
            Arguments = $"/out:\"{exePath}\" \"{sourcePath}\"",
            CreateNoWindow = true,
            UseShellExecute = false
        });
        process?.WaitForExit();
        return exePath;
    }

    private static string GetSleepingDummyExecutablePath()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "PrintBitDocumentPrinterTests");
        Directory.CreateDirectory(tempDir);
        var exePath = Path.Combine(tempDir, "dummy_sumatra_sleep.exe");
        if (File.Exists(exePath)) return exePath;

        var sourcePath = Path.Combine(tempDir, "dummy_sumatra_sleep.cs");
        File.WriteAllText(sourcePath, "class Program { static void Main() { System.Threading.Thread.Sleep(10000); } }");

        var cscPath = @"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe";
        var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = cscPath,
            Arguments = $"/out:\"{exePath}\" \"{sourcePath}\"",
            CreateNoWindow = true,
            UseShellExecute = false
        });
        process?.WaitForExit();
        return exePath;
    }
}
