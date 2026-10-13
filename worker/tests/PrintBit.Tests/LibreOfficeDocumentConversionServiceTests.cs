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
}
