using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Moq;
using PrintBit.Infrastructure.Windows.Networking;
using Xunit;

namespace PrintBit.Tests;

public class WindowsKioskNetworkPlatformScaffoldTests
{
    [Fact]
    public async Task WindowsKioskNetworkPlatform_Scaffold_ReturnsNotImplementedSnapshot()
    {
        var loggerMock = new Mock<ILogger<WindowsKioskNetworkPlatform>>();
        var platform = new WindowsKioskNetworkPlatform(loggerMock.Object);

        var snapshot = await platform.PrepareAsync(["192.168.4."], 3000, CancellationToken.None);

        Assert.False(snapshot.Success);
        Assert.Null(snapshot.KioskIp);
        Assert.False(snapshot.FirewallReady);
        Assert.Equal("NOT_IMPLEMENTED", snapshot.ErrorCode);
        Assert.Contains("scaffolded", snapshot.Detail);
    }
}
