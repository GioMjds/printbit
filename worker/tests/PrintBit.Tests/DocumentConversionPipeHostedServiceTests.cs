namespace PrintBit.Tests;

using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using PrintBit.HardwareService.Services;
using PrintBit.Infrastructure.Services.DocumentConversion;
using PrintBit.Shared.Configurations;
using Xunit;

public class DocumentConversionPipeHostedServiceTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    [Fact]
    public async Task ProcessRequestStreamAsync_ValidRequest_CallsConversionServiceAndSerializesResponse()
    {
        var mockService = new Mock<IDocumentConversionService>();
        mockService.Setup(s => s.ConvertAsync(It.IsAny<DocumentConversionRequest>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new DocumentConversionResult
            {
                RequestId = "req-123",
                Success = true,
                OutputPath = @"C:\converted\req-123.pdf",
                PageCount = 5,
                SourceFormat = "docx",
                DurationMs = 250
            });

        var service = new DocumentConversionPipeHostedService(
            NullLogger<DocumentConversionPipeHostedService>.Instance,
            mockService.Object,
            Options.Create(new DocumentConversionSettings()));

        var request = new DocumentConversionRequest
        {
            RequestId = "req-123",
            SourcePath = @"C:\uploads\sample.docx",
            OutputDirectory = @"C:\converted",
            TargetFormat = "pdf",
            TimeoutSeconds = 45
        };

        var requestJson = JsonSerializer.Serialize(request, JsonOptions) + "\n";
        using var inStream = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        using var outStream = new MemoryStream();

        var result = await service.ProcessRequestStreamAsync(inStream, outStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.True(result.Success);
        Assert.Equal("req-123", result.RequestId);
        Assert.Equal(@"C:\converted\req-123.pdf", result.OutputPath);
        Assert.Equal(5, result.PageCount);
        Assert.Equal("docx", result.SourceFormat);
        Assert.Equal(250, result.DurationMs);

        outStream.Position = 0;
        using var reader = new StreamReader(outStream, Encoding.UTF8);
        var responseLine = await reader.ReadLineAsync();
        Assert.NotNull(responseLine);

        var serializedResult = JsonSerializer.Deserialize<DocumentConversionResult>(responseLine, JsonOptions);
        Assert.NotNull(serializedResult);
        Assert.True(serializedResult.Success);
        Assert.Equal("req-123", serializedResult.RequestId);
        Assert.Equal(@"C:\converted\req-123.pdf", serializedResult.OutputPath);
        Assert.Equal(5, serializedResult.PageCount);

        mockService.Verify(s => s.ConvertAsync(
            It.Is<DocumentConversionRequest>(r => r.RequestId == "req-123" && r.SourcePath == @"C:\uploads\sample.docx"),
            It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task ProcessRequestStreamAsync_EmptyStream_ReturnsNullAndWritesNothing()
    {
        var mockService = new Mock<IDocumentConversionService>();
        var service = new DocumentConversionPipeHostedService(
            NullLogger<DocumentConversionPipeHostedService>.Instance,
            mockService.Object,
            Options.Create(new DocumentConversionSettings()));

        using var inStream = new MemoryStream();
        using var outStream = new MemoryStream();

        var result = await service.ProcessRequestStreamAsync(inStream, outStream, CancellationToken.None);

        Assert.Null(result);
        Assert.Equal(0, outStream.Length);
        mockService.Verify(s => s.ConvertAsync(It.IsAny<DocumentConversionRequest>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ProcessRequestStreamAsync_WhitespaceOrEmptyLine_ReturnsFailureAndWritesResponse()
    {
        var mockService = new Mock<IDocumentConversionService>();
        var service = new DocumentConversionPipeHostedService(
            NullLogger<DocumentConversionPipeHostedService>.Instance,
            mockService.Object,
            Options.Create(new DocumentConversionSettings()));

        using var inStream = new MemoryStream(Encoding.UTF8.GetBytes("   \n"));
        using var outStream = new MemoryStream();

        var result = await service.ProcessRequestStreamAsync(inStream, outStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.False(result.Success);
        Assert.Equal("Invalid or empty request", result.ErrorMessage);

        outStream.Position = 0;
        using var reader = new StreamReader(outStream, Encoding.UTF8);
        var responseLine = await reader.ReadLineAsync();
        Assert.NotNull(responseLine);

        var serializedResult = JsonSerializer.Deserialize<DocumentConversionResult>(responseLine, JsonOptions);
        Assert.NotNull(serializedResult);
        Assert.False(serializedResult.Success);
        Assert.Equal("Invalid or empty request", serializedResult.ErrorMessage);

        mockService.Verify(s => s.ConvertAsync(It.IsAny<DocumentConversionRequest>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ProcessRequestStreamAsync_MalformedJson_ReturnsFailureAndWritesResponse()
    {
        var mockService = new Mock<IDocumentConversionService>();
        var service = new DocumentConversionPipeHostedService(
            NullLogger<DocumentConversionPipeHostedService>.Instance,
            mockService.Object,
            Options.Create(new DocumentConversionSettings()));

        using var inStream = new MemoryStream(Encoding.UTF8.GetBytes("{\"requestId\": invalid json}\n"));
        using var outStream = new MemoryStream();

        var result = await service.ProcessRequestStreamAsync(inStream, outStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.False(result.Success);
        Assert.Equal("Invalid or empty request", result.ErrorMessage);

        outStream.Position = 0;
        using var reader = new StreamReader(outStream, Encoding.UTF8);
        var responseLine = await reader.ReadLineAsync();
        Assert.NotNull(responseLine);

        var serializedResult = JsonSerializer.Deserialize<DocumentConversionResult>(responseLine, JsonOptions);
        Assert.NotNull(serializedResult);
        Assert.False(serializedResult.Success);
        Assert.Equal("Invalid or empty request", serializedResult.ErrorMessage);

        mockService.Verify(s => s.ConvertAsync(It.IsAny<DocumentConversionRequest>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ProcessRequestStreamAsync_OversizedPayload_ReturnsFailureAndWritesResponse()
    {
        var mockService = new Mock<IDocumentConversionService>();
        var service = new DocumentConversionPipeHostedService(
            NullLogger<DocumentConversionPipeHostedService>.Instance,
            mockService.Object,
            Options.Create(new DocumentConversionSettings()));

        var largeString = new string('x', 9000);
        using var inStream = new MemoryStream(Encoding.UTF8.GetBytes(largeString + "\n"));
        using var outStream = new MemoryStream();

        var result = await service.ProcessRequestStreamAsync(inStream, outStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.False(result.Success);
        Assert.Equal("Invalid or empty request", result.ErrorMessage);

        outStream.Position = 0;
        using var reader = new StreamReader(outStream, Encoding.UTF8);
        var responseLine = await reader.ReadLineAsync();
        Assert.NotNull(responseLine);

        var serializedResult = JsonSerializer.Deserialize<DocumentConversionResult>(responseLine, JsonOptions);
        Assert.NotNull(serializedResult);
        Assert.False(serializedResult.Success);

        mockService.Verify(s => s.ConvertAsync(It.IsAny<DocumentConversionRequest>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ProcessRequestStreamAsync_ConversionServiceThrowsException_ReturnsGracefulFailureResult()
    {
        var mockService = new Mock<IDocumentConversionService>();
        mockService.Setup(s => s.ConvertAsync(It.IsAny<DocumentConversionRequest>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("LibreOffice process crashed"));

        var service = new DocumentConversionPipeHostedService(
            NullLogger<DocumentConversionPipeHostedService>.Instance,
            mockService.Object,
            Options.Create(new DocumentConversionSettings()));

        var request = new DocumentConversionRequest
        {
            RequestId = "req-crash",
            SourcePath = @"C:\uploads\crash.docx"
        };

        var requestJson = JsonSerializer.Serialize(request, JsonOptions) + "\n";
        using var inStream = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        using var outStream = new MemoryStream();

        var result = await service.ProcessRequestStreamAsync(inStream, outStream, CancellationToken.None);

        Assert.NotNull(result);
        Assert.False(result.Success);
        Assert.Equal("req-crash", result.RequestId);
        Assert.Contains("LibreOffice process crashed", result.ErrorMessage);

        outStream.Position = 0;
        using var reader = new StreamReader(outStream, Encoding.UTF8);
        var responseLine = await reader.ReadLineAsync();
        Assert.NotNull(responseLine);

        var serializedResult = JsonSerializer.Deserialize<DocumentConversionResult>(responseLine, JsonOptions);
        Assert.NotNull(serializedResult);
        Assert.False(serializedResult.Success);
        Assert.Equal("req-crash", serializedResult.RequestId);
        Assert.Contains("LibreOffice process crashed", serializedResult.ErrorMessage);
    }

    [Fact]
    public async Task ProcessRequestStreamAsync_Cancellation_ThrowsOperationCanceledException()
    {
        var mockService = new Mock<IDocumentConversionService>();
        var service = new DocumentConversionPipeHostedService(
            NullLogger<DocumentConversionPipeHostedService>.Instance,
            mockService.Object,
            Options.Create(new DocumentConversionSettings()));

        using var inStream = new MemoryStream(Encoding.UTF8.GetBytes("{\"requestId\":\"req-1\"}\n"));
        using var outStream = new MemoryStream();

        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            service.ProcessRequestStreamAsync(inStream, outStream, cts.Token));
    }
}
