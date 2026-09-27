namespace PrintBit.Tests;

using PrintBit.Shared.Configurations;
using PrintBit.Infrastructure.Services.DocumentConversion;
using Xunit;

public class DocumentConversionSettingsTests
{
    [Fact]
    public void DocumentConversionSettings_HasSensibleDefaults()
    {
        var settings = new DocumentConversionSettings();
        Assert.Equal(@"C:\Program Files\LibreOffice\program\soffice.exe", settings.SofficePath);
        Assert.Equal(60, settings.DefaultTimeoutSeconds);
        Assert.Equal("printbit-document-conversion", settings.PipeName);
        Assert.False(string.IsNullOrWhiteSpace(settings.UserProfileDirectory));
        Assert.False(string.IsNullOrWhiteSpace(settings.DefaultOutputDirectory));
    }

    [Fact]
    public void DocumentConversionContracts_SerializeAndDeserializeCleanly()
    {
        var request = new DocumentConversionRequest
        {
            RequestId = "req-1",
            SourcePath = @"C:\test\sample.docx",
            OutputDirectory = @"C:\test\out",
            TargetFormat = "pdf",
            TimeoutSeconds = 45
        };

        var json = System.Text.Json.JsonSerializer.Serialize(request);
        var deserialized = System.Text.Json.JsonSerializer.Deserialize<DocumentConversionRequest>(json);

        Assert.NotNull(deserialized);
        Assert.Equal("req-1", deserialized.RequestId);
        Assert.Equal(@"C:\test\sample.docx", deserialized.SourcePath);
        Assert.Equal(@"C:\test\out", deserialized.OutputDirectory);
        Assert.Equal("pdf", deserialized.TargetFormat);
        Assert.Equal(45, deserialized.TimeoutSeconds);

        var result = new DocumentConversionResult
        {
            RequestId = "req-1",
            Success = true,
            OutputPath = @"C:\test\out\sample.pdf",
            PageCount = 3,
            SourceFormat = ".docx",
            DurationMs = 120,
            ErrorMessage = null
        };

        var resultJson = System.Text.Json.JsonSerializer.Serialize(result);
        var deserializedResult = System.Text.Json.JsonSerializer.Deserialize<DocumentConversionResult>(resultJson);
        Assert.NotNull(deserializedResult);
        Assert.True(deserializedResult.Success);
        Assert.Equal(3, deserializedResult.PageCount);
    }
}
