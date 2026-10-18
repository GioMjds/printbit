using System.IO;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintBit.Infrastructure.Services.DocumentConversion;
using PrintBit.Shared.Configurations;
using Xunit;

namespace PrintBit.Tests;

public class LibreOfficeDocumentConversionServiceTests
{
    private readonly LibreOfficeDocumentConversionService _service;

    public LibreOfficeDocumentConversionServiceTests()
    {
        var settings = Options.Create(new DocumentConversionSettings
        {
            SofficePath = @"C:\NonExistent\soffice.exe",
            DefaultTimeoutSeconds = 5,
            UserProfileDirectory = Path.Combine(Path.GetTempPath(), "printbit-tests-lo-profile")
        });

        _service = new LibreOfficeDocumentConversionService(
            settings,
            NullLogger<LibreOfficeDocumentConversionService>.Instance);
    }

    [Fact]
    public async Task ConvertAsync_NullRequest_ReturnsFailure()
    {
        var result = await _service.ConvertAsync(null!);
        Assert.False(result.Success);
        Assert.Contains("cannot be null", result.ErrorMessage);
    }

    [Fact]
    public async Task ConvertAsync_EmptySourcePath_ReturnsFailure()
    {
        var result = await _service.ConvertAsync(new DocumentConversionRequest
        {
            RequestId = "test-1",
            SourcePath = ""
        });

        Assert.False(result.Success);
        Assert.Contains("whitespace", result.ErrorMessage);
    }

    [Fact]
    public async Task ConvertAsync_NonExistentFile_ReturnsFailure()
    {
        var result = await _service.ConvertAsync(new DocumentConversionRequest
        {
            RequestId = "test-2",
            SourcePath = @"C:\NonExistent\file.docx"
        });

        Assert.False(result.Success);
        Assert.Contains("does not exist", result.ErrorMessage);
    }

    [Fact]
    public async Task ConvertAsync_UnsupportedExtension_ReturnsFailure()
    {
        var tempFile = Path.GetTempFileName();
        var unsupportedFile = Path.ChangeExtension(tempFile, ".xyz");
        File.Move(tempFile, unsupportedFile);

        try
        {
            var result = await _service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = "test-3",
                SourcePath = unsupportedFile
            });

            Assert.False(result.Success);
            Assert.Contains("Unsupported file extension", result.ErrorMessage);
        }
        finally
        {
            if (File.Exists(unsupportedFile)) File.Delete(unsupportedFile);
        }
    }

    [Fact]
    public async Task ConvertAsync_MissingLibreOfficeExecutable_ReturnsExecutableNotFound()
    {
        var tempDocx = Path.Combine(Path.GetTempPath(), $"test-{Guid.NewGuid():N}.docx");
        File.WriteAllText(tempDocx, "dummy content");

        try
        {
            var result = await _service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = "test-4",
                SourcePath = tempDocx
            });

            Assert.False(result.Success);
            Assert.Contains("LibreOffice executable not found", result.ErrorMessage);
        }
        finally
        {
            if (File.Exists(tempDocx)) File.Delete(tempDocx);
        }
    }

    [Fact]
    public async Task ConvertAsync_ZeroBytePdf_ReturnsFailureAndCleansUp()
    {
        var tempPdf = Path.Combine(Path.GetTempPath(), $"empty-{Guid.NewGuid():N}.pdf");
        var outputDir = Path.Combine(Path.GetTempPath(), $"out-{Guid.NewGuid():N}");
        File.WriteAllBytes(tempPdf, Array.Empty<byte>());

        try
        {
            var result = await _service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = "test-zero-byte",
                SourcePath = tempPdf,
                OutputDirectory = outputDir
            });

            Assert.False(result.Success);
            Assert.Contains("empty (0 bytes)", result.ErrorMessage);
            var expectedOut = Path.Combine(outputDir, Path.GetFileName(tempPdf));
            Assert.False(File.Exists(expectedOut));
        }
        finally
        {
            if (File.Exists(tempPdf)) File.Delete(tempPdf);
            if (Directory.Exists(outputDir)) Directory.Delete(outputDir, true);
        }
    }

    [Fact]
    public async Task ConvertAsync_CorruptPdf_ReturnsFailureAndCleansUp()
    {
        var tempPdf = Path.Combine(Path.GetTempPath(), $"corrupt-{Guid.NewGuid():N}.pdf");
        var outputDir = Path.Combine(Path.GetTempPath(), $"out-{Guid.NewGuid():N}");
        File.WriteAllText(tempPdf, "This is not a real PDF file content.");

        try
        {
            var result = await _service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = "test-corrupt-pdf",
                SourcePath = tempPdf,
                OutputDirectory = outputDir
            });

            Assert.False(result.Success);
            Assert.Contains("invalid or contains zero pages", result.ErrorMessage);
            var expectedOut = Path.Combine(outputDir, Path.GetFileName(tempPdf));
            Assert.False(File.Exists(expectedOut));
        }
        finally
        {
            if (File.Exists(tempPdf)) File.Delete(tempPdf);
            if (Directory.Exists(outputDir)) Directory.Delete(outputDir, true);
        }
    }

    [Fact]
    public async Task ConvertAsync_ConcurrentRequests_ExecuteSequentiallyWithoutDeadlock()
    {
        var tempFiles = Enumerable.Range(0, 5).Select(_ =>
        {
            var path = Path.Combine(Path.GetTempPath(), $"concur-{Guid.NewGuid():N}.docx");
            File.WriteAllText(path, "dummy docx");
            return path;
        }).ToList();

        try
        {
            var tasks = tempFiles.Select(f => _service.ConvertAsync(new DocumentConversionRequest
            {
                RequestId = Guid.NewGuid().ToString("N"),
                SourcePath = f
            })).ToList();

            var results = await Task.WhenAll(tasks);
            Assert.Equal(5, results.Length);
            Assert.All(results, r =>
            {
                Assert.False(r.Success);
                Assert.Contains("LibreOffice executable not found", r.ErrorMessage);
            });
        }
        finally
        {
            foreach (var f in tempFiles)
            {
                if (File.Exists(f)) File.Delete(f);
            }
        }
    }
}
