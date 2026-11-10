using PrintBit.Infrastructure.Windows.Scanning;
using Xunit;

namespace PrintBit.Tests;

public class ScanDeadlineTests
{
    [Fact]
    public async Task PageTimeout_FiresWhenNoPageArrives()
    {
        using var deadline = new ScanDeadline(TimeSpan.FromSeconds(30), TimeSpan.FromMilliseconds(80), CancellationToken.None);

        await Task.Delay(600);

        Assert.True(deadline.Token.IsCancellationRequested);
        Assert.True(deadline.PageExpired);
        Assert.False(deadline.OverallExpired);
    }

    [Fact]
    public async Task PageCompleted_ResetsThePageTimer()
    {
        using var deadline = new ScanDeadline(TimeSpan.FromSeconds(30), TimeSpan.FromMilliseconds(400), CancellationToken.None);

        for (var i = 0; i < 5; i++)
        {
            await Task.Delay(150);
            deadline.PageCompleted();
        }

        // 750 ms elapsed, longer than one page window, yet no timeout.
        Assert.False(deadline.Token.IsCancellationRequested);
    }

    [Fact]
    public async Task OverallTimeout_StillCapsAScanThatKeepsProducingPages()
    {
        using var deadline = new ScanDeadline(TimeSpan.FromMilliseconds(300), TimeSpan.FromSeconds(30), CancellationToken.None);

        for (var i = 0; i < 20 && !deadline.Token.IsCancellationRequested; i++)
        {
            await Task.Delay(60);
            deadline.PageCompleted();
        }

        Assert.True(deadline.Token.IsCancellationRequested);
        Assert.True(deadline.OverallExpired);
    }

    [Fact]
    public void ExternalCancellation_IsNotReportedAsATimeout()
    {
        using var cts = new CancellationTokenSource();
        using var deadline = new ScanDeadline(TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30), cts.Token);

        cts.Cancel();

        Assert.True(deadline.Token.IsCancellationRequested);
        Assert.False(deadline.OverallExpired);
        Assert.False(deadline.PageExpired);
    }
}

public class ScanGateTests
{
    [Fact]
    public void SecondEntry_IsRejectedWhileFirstIsHeld()
    {
        var gate = new ScanGate();

        using var first = gate.TryEnter();
        var second = gate.TryEnter();

        Assert.NotNull(first);
        Assert.Null(second);
    }

    [Fact]
    public void Entry_SucceedsAgainAfterRelease()
    {
        var gate = new ScanGate();

        gate.TryEnter()!.Dispose();
        using var again = gate.TryEnter();

        Assert.NotNull(again);
    }
}

public class ScanFailurePolicyTests
{
    [Theory]
    [InlineData("SCAN_TIMEOUT")]
    [InlineData("SCAN_PAGE_TIMEOUT")]
    [InlineData("PROCESS_FAILED")]
    [InlineData("SCANNER_UNAVAILABLE")]
    public void DeviceFailures_InvalidateTheCachedDevice(string code)
    {
        Assert.True(ScanFailurePolicy.ShouldInvalidateDevice(code));
    }

    [Theory]
    [InlineData("FEEDER_EMPTY")]
    [InlineData("PAPER_JAM")]
    [InlineData("DEVICE_BUSY")]
    [InlineData("SCANNER_BUSY")]
    [InlineData("CANCELLED")]
    [InlineData(null)]
    public void UserOrBusyFailures_KeepTheCachedDevice(string? code)
    {
        Assert.False(ScanFailurePolicy.ShouldInvalidateDevice(code));
    }
}
