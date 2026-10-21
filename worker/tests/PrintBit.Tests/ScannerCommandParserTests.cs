using System.Text.Json;
using PrintBit.Infrastructure.IPC;
using Xunit;

namespace PrintBit.Tests;

public class ScannerCommandParserTests
{
    [Fact]
    public void Parse_StartScanCommand_WithMaxPages_ParsesCorrectly()
    {
        var json = """
        {
            "type": "StartScan",
            "requestId": "scan-12345",
            "source": "adf",
            "dpi": 150,
            "colorMode": "colored",
            "format": "pdf",
            "paperSize": "Long",
            "maxPages": 1
        }
        """;

        var success = WorkerCommandParser.TryParseHardwareCommand(
            json,
            8192,
            out var command,
            out var error,
            out _,
            out _);

        Assert.True(success, error);
        var scanCmd = Assert.IsType<StartScanCommand>(command);
        Assert.Equal("scan-12345", scanCmd.RequestId);
        Assert.Equal("adf", scanCmd.Source);
        Assert.Equal(150, scanCmd.Dpi);
        Assert.Equal(1, scanCmd.MaxPages);
        Assert.Equal("Long", scanCmd.PaperSize);
    }

    [Fact]
    public void Serialize_StartScanResponse_IncludesDurationMs()
    {
        var resp = new StartScanResponse
        {
            RequestId = "scan-12345",
            Success = true,
            OutputPath = @"uploads\scans\test.pdf",
            PageCount = 1,
            Format = "pdf",
            DurationMs = 3450
        };

        var json = JsonSerializer.Serialize(resp, WorkerCommandParser.JsonOptions);

        Assert.Contains("\"durationMs\":3450", json);
    }
}
