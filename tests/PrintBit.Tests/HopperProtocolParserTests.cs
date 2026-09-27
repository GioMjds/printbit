using Xunit;
using PrintBit.Hardware.Devices.Hopper.Protocol;

namespace PrintBit.Tests;

public class HopperProtocolParserTests
{
    [Fact]
    public void TryParse_StructuredAck_ReturnsAckResponse()
    {
        var success = HopperProtocolParser.TryParse("HOPPER ACK a1b2", out var response);

        Assert.True(success);
        var ack = Assert.IsType<HopperAckResponse>(response);
        Assert.Equal("a1b2", ack.RequestId);
        Assert.Equal(HopperResponseKind.Ack, ack.Kind);
    }

    [Fact]
    public void TryParse_StructuredProgress_ReturnsProgressResponse()
    {
        var success = HopperProtocolParser.TryParse("HOPPER PROGRESS a1b2 2 5", out var response);

        Assert.True(success);
        var progress = Assert.IsType<HopperProgressResponse>(response);
        Assert.Equal("a1b2", progress.RequestId);
        Assert.Equal(2, progress.Dispensed);
        Assert.Equal(5, progress.Total);
        Assert.Equal(HopperResponseKind.Progress, progress.Kind);
    }

    [Fact]
    public void TryParse_StructuredDoneWithCount_ReturnsDoneResponse()
    {
        var success = HopperProtocolParser.TryParse("HOPPER DONE a1b2 5", out var response);

        Assert.True(success);
        var done = Assert.IsType<HopperDoneResponse>(response);
        Assert.Equal("a1b2", done.RequestId);
        Assert.Equal(5, done.DispensedCount);
        Assert.Equal(HopperResponseKind.Done, done.Kind);
    }

    [Fact]
    public void TryParse_StructuredDoneWithoutCount_DefaultsToZero()
    {
        var success = HopperProtocolParser.TryParse("HOPPER DONE a1b2", out var response);

        Assert.True(success);
        var done = Assert.IsType<HopperDoneResponse>(response);
        Assert.Equal("a1b2", done.RequestId);
        Assert.Equal(0, done.DispensedCount);
        Assert.Equal(HopperResponseKind.Done, done.Kind);
    }

    [Fact]
    public void TryParse_StructuredErrWithDetail_ReturnsErrorResponse()
    {
        var success = HopperProtocolParser.TryParse("HOPPER ERR a1b2 JAM motor stalled", out var response);

        Assert.True(success);
        var error = Assert.IsType<HopperErrorResponse>(response);
        Assert.Equal("a1b2", error.RequestId);
        Assert.Equal("JAM", error.Code);
        Assert.Equal("motor stalled", error.Detail);
        Assert.Equal(HopperResponseKind.Error, error.Kind);
    }

    [Fact]
    public void TryParse_StructuredErrorKeywordWithDetail_ReturnsErrorResponse()
    {
        var success = HopperProtocolParser.TryParse("HOPPER ERROR a1b2 EMPTY bin is empty", out var response);

        Assert.True(success);
        var error = Assert.IsType<HopperErrorResponse>(response);
        Assert.Equal("a1b2", error.RequestId);
        Assert.Equal("EMPTY", error.Code);
        Assert.Equal("bin is empty", error.Detail);
        Assert.Equal(HopperResponseKind.Error, error.Kind);
    }

    [Fact]
    public void TryParse_StructuredErrWithoutDetail_DefaultsDetailToCode()
    {
        var success = HopperProtocolParser.TryParse("HOPPER ERR a1b2 JAM", out var response);

        Assert.True(success);
        var error = Assert.IsType<HopperErrorResponse>(response);
        Assert.Equal("a1b2", error.RequestId);
        Assert.Equal("JAM", error.Code);
        Assert.Equal("JAM", error.Detail);
    }

    [Fact]
    public void TryParse_StructuredErrWithoutCode_DefaultsToUnknown()
    {
        var success = HopperProtocolParser.TryParse("HOPPER ERR a1b2", out var response);

        Assert.True(success);
        var error = Assert.IsType<HopperErrorResponse>(response);
        Assert.Equal("a1b2", error.RequestId);
        Assert.Equal("UNKNOWN", error.Code);
        Assert.Equal("UNKNOWN", error.Detail);
    }

    [Theory]
    [InlineData("START 5")]
    [InlineData("START 0")]
    [InlineData("start 10")]
    public void TryParse_LegacyStart_ReturnsAckResponseWithLegacyId(string input)
    {
        var success = HopperProtocolParser.TryParse(input, out var response);

        Assert.True(success);
        var ack = Assert.IsType<HopperAckResponse>(response);
        Assert.Equal("legacy", ack.RequestId);
        Assert.Equal(HopperResponseKind.Ack, ack.Kind);
    }

    [Theory]
    [InlineData("DONE")]
    [InlineData("done")]
    [InlineData("HOPPER:DONE")]
    [InlineData("hopper:done")]
    [InlineData("HOPPER DONE")]
    [InlineData("hopper done")]
    public void TryParse_LegacyDone_ReturnsDoneResponseWithLegacyId(string input)
    {
        var success = HopperProtocolParser.TryParse(input, out var response);

        Assert.True(success);
        var done = Assert.IsType<HopperDoneResponse>(response);
        Assert.Equal("legacy", done.RequestId);
        Assert.Equal(0, done.DispensedCount);
        Assert.Equal(HopperResponseKind.Done, done.Kind);
    }

    [Theory]
    [InlineData("HOPPER OK")]
    [InlineData("hopper ok")]
    public void TryParse_LegacyHopperOk_ReturnsDoneResponseWithLegacyId(string input)
    {
        var success = HopperProtocolParser.TryParse(input, out var response);

        Assert.True(success);
        var done = Assert.IsType<HopperDoneResponse>(response);
        Assert.Equal("legacy", done.RequestId);
        Assert.Equal(0, done.DispensedCount);
        Assert.Equal(HopperResponseKind.Done, done.Kind);
    }

    [Theory]
    [InlineData("HOPPER ERROR")]
    [InlineData("hopper error")]
    [InlineData("HOPPER ERR")]
    [InlineData("hopper err")]
    public void TryParse_LegacyHopperError_ReturnsErrorResponseWithLegacyId(string input)
    {
        var success = HopperProtocolParser.TryParse(input, out var response);

        Assert.True(success);
        var error = Assert.IsType<HopperErrorResponse>(response);
        Assert.Equal("legacy", error.RequestId);
        Assert.Equal("ERROR", error.Code);
        Assert.Equal("Legacy hopper error", error.Detail);
        Assert.Equal(HopperResponseKind.Error, error.Kind);
    }

    [Fact]
    public void TryParse_CaseInsensitiveKeywords_ParsesSuccessfully()
    {
        var success = HopperProtocolParser.TryParse("hopper done A1B2 5", out var response);

        Assert.True(success);
        var done = Assert.IsType<HopperDoneResponse>(response);
        Assert.Equal("A1B2", done.RequestId);
        Assert.Equal(5, done.DispensedCount);
    }

    [Theory]
    [InlineData("  HOPPER ACK a1b2  \r\n")]
    [InlineData("\t\tHOPPER   PROGRESS   a1b2   2   5\r\n")]
    [InlineData("  HOPPER \t DONE \t a1b2 \t 5 \n")]
    [InlineData("   DONE \r\n")]
    [InlineData("  HOPPER:DONE  \r\n")]
    [InlineData("  START   5   \r\n")]
    public void TryParse_ExtraWhitespaceAndCrlf_ParsesSuccessfully(string input)
    {
        var success = HopperProtocolParser.TryParse(input, out var response);

        Assert.True(success);
        Assert.NotNull(response);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\r\n\t")]
    [InlineData("KIOSK_IP 192.168.4.1")]
    [InlineData("AP_IP:192.168.4.1")]
    [InlineData("COIN:5")]
    [InlineData("RANDOM_DATA")]
    [InlineData("HOPPER")]
    [InlineData("HOPPER UNKNOWN")]
    [InlineData("HOPPER ACK")]
    [InlineData("HOPPER ACK a1b2 extra")]
    [InlineData("HOPPER PROGRESS a1b2")]
    [InlineData("HOPPER PROGRESS a1b2 2")]
    [InlineData("HOPPER PROGRESS a1b2 2 5 extra")]
    [InlineData("HOPPER PROGRESS a1b2 two five")]
    [InlineData("HOPPER PROGRESS a1b2 -1 5")]
    [InlineData("HOPPER PROGRESS a1b2 2 -5")]
    [InlineData("HOPPER DONE a1b2 notanumber")]
    [InlineData("HOPPER DONE a1b2 -1")]
    [InlineData("HOPPER DONE a1b2 5 extra")]
    [InlineData("START")]
    [InlineData("START notanumber")]
    [InlineData("START -1")]
    [InlineData("START 5 extra")]
    [InlineData("DONE extra")]
    [InlineData("HOPPER:DONE extra")]
    [InlineData("HOPPER OK extra")]
    public void TryParse_InvalidOrUnrelatedLines_ReturnsFalse(string? input)
    {
        var success = HopperProtocolParser.TryParse(input, out var response);

        Assert.False(success);
        Assert.Null(response);
    }
}
