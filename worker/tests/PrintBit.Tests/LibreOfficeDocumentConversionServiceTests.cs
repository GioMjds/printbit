namespace PrintBit.Tests;

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.Services.DocumentConversion;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;
using Xunit;

public class LibreOfficeDocumentConversionServiceTests
{
    [Fact]
    public async Task ConvertAsync_NullOrWhitespaceSourcePath_ReturnsFailure()
    {
        var settings = Options.Create(new DocumentConversionSettings());
        var service = new LibreOfficeDocumentConversionService(settings, NullLogger<LibreOfficeDocumentConversionService>.Instance);

        var result = await service.ConvertAsync(new DocumentConversionRequest
        {
            RequestId = "test-empty",
            SourcePath = "   "
        }, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("test-empty", result.RequestId);
        Assert.False(string.IsNullOrWhiteSpace(result.ErrorMessage));
    }

    [Fact]
    public async Task ConvertAsync_NullRequest_ReturnsFailure()
    {
        var settings = Options.Create(new DocumentConversionSettings());
        var service = new LibreOfficeDocumentConversionService(settings, NullLogger<LibreOfficeDocumentConversionService>.Instance);

        var result = await service.ConvertAsync(null!, CancellationToken.None);

        Assert.False(result.Success);
        Assert.False(string.IsNullOrWhiteSpace(result.ErrorMessage));
    }

    [Fact]
    public async Task ConvertAsync_NonExistentFile_ReturnsFailure()
    {
        var settings = Options.Create(new DocumentConversionSettings());
        var service = new LibreOfficeDocumentConversionService(settings, NullLogger<LibreOfficeDocumentConversionService>.Instance);

        var result = await service.ConvertAsync(new DocumentConversionRequest
        {
            RequestId = "test-missing",
            SourcePath = @"C:\nonexistent_path_12345\fake_doc.docx"
        }, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("test-missing", result.RequestId);
        Assert.Contains("does not exist", result.ErrorMessage, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(".xyz")]
    [InlineData(".exe")]
    [InlineData(".zip")]
    [InlineData(".unknown")]
    public async Task ConvertAsync_UnsupportedExtension_ReturnsFailure(string ext)
    {
        var tempFile = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}{ext}");
        try
        {
            await File.WriteAllTextAsync(tempFile, "sample unsupported data");

            var settings = Options.Create(new DocumentConversionSettings());
            var service = new LibreOfficeDocumentConversionService(settings, NullLogger<LibreOfficeDocumentConversionService>.Instance);

            var result = await service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = "test-unsupported",
                SourcePath = tempFile
            }, CancellationToken.None);

            Assert.False(result.Success);
            Assert.Equal("test-unsupported", result.RequestId);
            Assert.Contains("unsupported", result.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            try { if (File.Exists(tempFile)) File.Delete(tempFile); } catch { }
        }
    }

    [Fact]
    public async Task ConvertAsync_ImageFormat_Png_RoutesToImageToPdfConverter_ReturnsSuccess()
    {
        var tempPng = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.png");
        var tempOutDir = Path.Combine(Path.GetTempPath(), $"printbit_test_{Guid.NewGuid()}");

        try
        {
            var pngBytes = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
            await File.WriteAllBytesAsync(tempPng, pngBytes);

            var settings = Options.Create(new DocumentConversionSettings
            {
                DefaultOutputDirectory = tempOutDir
            });
            var service = new LibreOfficeDocumentConversionService(settings, NullLogger<LibreOfficeDocumentConversionService>.Instance);

            var result = await service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = "test-png",
                SourcePath = tempPng,
                OutputDirectory = tempOutDir
            }, CancellationToken.None);

            Assert.True(result.Success, $"Conversion failed: {result.ErrorMessage}");
            Assert.Equal("test-png", result.RequestId);
            Assert.Equal("png", result.SourceFormat);
            Assert.Equal(1, result.PageCount);
            Assert.NotNull(result.OutputPath);
            Assert.True(File.Exists(result.OutputPath));
            Assert.True(new FileInfo(result.OutputPath).Length > 0);

            var counted = PdfPageCounter.Count(result.OutputPath);
            Assert.Equal(1, counted);
        }
        finally
        {
            try { if (File.Exists(tempPng)) File.Delete(tempPng); } catch { }
            try { if (Directory.Exists(tempOutDir)) Directory.Delete(tempOutDir, true); } catch { }
        }
    }

    [Fact]
    public async Task ConvertAsync_MissingLibreOfficeExecutable_ReturnsFailure()
    {
        var tempDocx = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.docx");
        try
        {
            await File.WriteAllTextAsync(tempDocx, "dummy docx content");

            var settings = Options.Create(new DocumentConversionSettings
            {
                SofficePath = @"C:\nonexistent_path_98765\soffice.exe"
            });
            var service = new LibreOfficeDocumentConversionService(settings, NullLogger<LibreOfficeDocumentConversionService>.Instance);

            var result = await service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = "test-missing-soffice",
                SourcePath = tempDocx
            }, CancellationToken.None);

            Assert.False(result.Success);
            Assert.Equal("test-missing-soffice", result.RequestId);
            Assert.Contains("LibreOffice executable not found", result.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            try { if (File.Exists(tempDocx)) File.Delete(tempDocx); } catch { }
        }
    }

    [Fact]
    public async Task ConvertAsync_OfficeDocument_Txt_ConvertsSuccessfully_WhenLibreOfficeInstalled()
    {
        var defaultSettings = new DocumentConversionSettings();
        if (!File.Exists(defaultSettings.SofficePath))
        {
            return;
        }

        var tempTxt = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.txt");
        var tempOutDir = Path.Combine(Path.GetTempPath(), $"printbit_lo_out_{Guid.NewGuid()}");
        var tempProfileDir = Path.Combine(Path.GetTempPath(), $"printbit_lo_prof_{Guid.NewGuid()}");

        try
        {
            await File.WriteAllTextAsync(tempTxt, "Hello from PrintBit Offline Document Conversion Test!\nThis is a simple text file to convert to PDF.");

            var settings = Options.Create(new DocumentConversionSettings
            {
                SofficePath = defaultSettings.SofficePath,
                UserProfileDirectory = tempProfileDir,
                DefaultOutputDirectory = tempOutDir
            });
            var service = new LibreOfficeDocumentConversionService(settings, NullLogger<LibreOfficeDocumentConversionService>.Instance);

            var result = await service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = "test-txt-lo",
                SourcePath = tempTxt,
                OutputDirectory = tempOutDir,
                TimeoutSeconds = 60
            }, CancellationToken.None);

            Assert.True(result.Success, $"Conversion failed: {result.ErrorMessage}");
            Assert.Equal("test-txt-lo", result.RequestId);
            Assert.Equal("txt", result.SourceFormat);
            Assert.NotNull(result.OutputPath);
            Assert.True(File.Exists(result.OutputPath));
            Assert.True(new FileInfo(result.OutputPath).Length > 0);
            Assert.True(result.PageCount >= 1);
            Assert.True(result.DurationMs >= 0);
        }
        finally
        {
            try { if (File.Exists(tempTxt)) File.Delete(tempTxt); } catch { }
            try { if (Directory.Exists(tempOutDir)) Directory.Delete(tempOutDir, true); } catch { }
            try { if (Directory.Exists(tempProfileDir)) Directory.Delete(tempProfileDir, true); } catch { }
        }
    }

    [Fact]
    public async Task ConvertAsync_ConcurrentRequests_ExecuteSafelyViaGate()
    {
        var defaultSettings = new DocumentConversionSettings();
        if (!File.Exists(defaultSettings.SofficePath))
        {
            return;
        }

        var tempTxt1 = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}_1.txt");
        var tempTxt2 = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}_2.txt");
        var tempOutDir = Path.Combine(Path.GetTempPath(), $"printbit_lo_concurrent_{Guid.NewGuid()}");
        var tempProfileDir = Path.Combine(Path.GetTempPath(), $"printbit_lo_prof_{Guid.NewGuid()}");

        try
        {
            await File.WriteAllTextAsync(tempTxt1, "File 1 content for concurrent conversion.");
            await File.WriteAllTextAsync(tempTxt2, "File 2 content for concurrent conversion.");

            var settings = Options.Create(new DocumentConversionSettings
            {
                SofficePath = defaultSettings.SofficePath,
                UserProfileDirectory = tempProfileDir,
                DefaultOutputDirectory = tempOutDir
            });
            var service = new LibreOfficeDocumentConversionService(settings, NullLogger<LibreOfficeDocumentConversionService>.Instance);

            var task1 = service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = "req-1",
                SourcePath = tempTxt1,
                OutputDirectory = tempOutDir
            });

            var task2 = service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = "req-2",
                SourcePath = tempTxt2,
                OutputDirectory = tempOutDir
            });

            var results = await Task.WhenAll(task1, task2);

            Assert.All(results, r => Assert.True(r.Success, $"Failed with: {r.ErrorMessage}"));
            Assert.Equal("req-1", results[0].RequestId);
            Assert.Equal("req-2", results[1].RequestId);
        }
        finally
        {
            try { if (File.Exists(tempTxt1)) File.Delete(tempTxt1); } catch { }
            try { if (File.Exists(tempTxt2)) File.Delete(tempTxt2); } catch { }
            try { if (Directory.Exists(tempOutDir)) Directory.Delete(tempOutDir, true); } catch { }
            try { if (Directory.Exists(tempProfileDir)) Directory.Delete(tempProfileDir, true); } catch { }
        }
    }

    [Fact]
    public async Task ConvertAsync_Cancellation_ThrowsWhenCancelled()
    {
        var tempPng = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.png");
        try
        {
            var pngBytes = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
            await File.WriteAllBytesAsync(tempPng, pngBytes);

            var settings = Options.Create(new DocumentConversionSettings());
            var service = new LibreOfficeDocumentConversionService(settings, NullLogger<LibreOfficeDocumentConversionService>.Instance);

            using var cts = new CancellationTokenSource();
            cts.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                service.ConvertAsync(new DocumentConversionRequest
                {
                    RequestId = "test-cancel",
                    SourcePath = tempPng
                }, cts.Token));
        }
        finally
        {
            try { if (File.Exists(tempPng)) File.Delete(tempPng); } catch { }
        }
    }
}
