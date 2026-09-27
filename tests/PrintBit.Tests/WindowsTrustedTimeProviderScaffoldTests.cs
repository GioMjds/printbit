using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Moq;
using PrintBit.Infrastructure.Windows.Time;
using Xunit;

namespace PrintBit.Tests;

public class WindowsTrustedTimeProviderScaffoldTests
{
    [Fact]
    public async Task WindowsTrustedTimeProvider_Scaffold_ReturnsNotImplementedSnapshot()
    {
        var loggerMock = new Mock<ILogger<WindowsTrustedTimeProvider>>();
        var provider = new WindowsTrustedTimeProvider(loggerMock.Object);

        var snapshot = await provider.GetStatusAsync("time.windows.com", 60_000, CancellationToken.None);

        Assert.False(snapshot.Synced);
        Assert.Equal("system", snapshot.Source);
        Assert.Equal("NOT_IMPLEMENTED", snapshot.ErrorCode);
        Assert.Equal(60_000, snapshot.MaxDriftMs);
        Assert.Equal("time.windows.com", snapshot.NtpSource);
        Assert.Null(snapshot.OffsetMs);
        Assert.False(snapshot.DriftExceeded);
    }
}
