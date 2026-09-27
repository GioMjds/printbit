using PrintBit.Infrastructure.IPC;

namespace PrintBit.Tests;

public class NodeErrorMessageParserTests
{
    [Fact]
    public void TryParse_WithValidJson_ReturnsMessage()
    {
        var json = "{\"message\":\"Printer error\",\"code\":\"SPOOLER\",\"source\":\"node\",\"timestampUtc\":\"2026-05-22T00:00:00Z\"}";

        var success = NodeErrorMessageParser.TryParse(
            json,
            NodeErrorMessageParser.DefaultMaxMessageBytes,
            out var message,
            out var errorCode);

        Assert.True(success);
        Assert.Null(errorCode);
        Assert.NotNull(message);
        Assert.Equal("Printer error", message!.Message);
        Assert.Equal("SPOOLER", message.Code);
        Assert.Equal("node", message.Source);
    }

    [Fact]
    public void TryParse_WithInvalidJson_ReturnsError()
    {
        var success = NodeErrorMessageParser.TryParse(
            "{not-json",
            NodeErrorMessageParser.DefaultMaxMessageBytes,
            out var message,
            out var errorCode);

        Assert.False(success);
        Assert.Null(message);
        Assert.Equal("InvalidJson", errorCode);
    }

    [Fact]
    public void TryParse_WithOversizePayload_ReturnsError()
    {
        var payload = new string('a', 20);

        var success = NodeErrorMessageParser.TryParse(
            payload,
            maxMessageBytes: 10,
            out var message,
            out var errorCode);

        Assert.False(success);
        Assert.Null(message);
        Assert.Equal("PayloadTooLarge", errorCode);
    }

    [Fact]
    public void TryParse_WithMissingMessage_ReturnsError()
    {
        var success = NodeErrorMessageParser.TryParse(
            "{}",
            NodeErrorMessageParser.DefaultMaxMessageBytes,
            out var message,
            out var errorCode);

        Assert.False(success);
        Assert.Null(message);
        Assert.Equal("MissingMessage", errorCode);
    }
}
