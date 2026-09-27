using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Moq;
using PrintBit.Infrastructure.Windows.Security;
using Xunit;

namespace PrintBit.Tests;

public class WindowsDefenderScannerScaffoldTests
{
    [Fact]
    public async Task WindowsDefenderScanner_Scaffold_ReturnsNotImplementedPlaceholder()
    {
        var scanner = new WindowsDefenderScanner(Mock.Of<ILogger<WindowsDefenderScanner>>());

        var health = await scanner.GetHealthAsync(CancellationToken.None);
        var scan = await scanner.ScanFileAsync(@"C:\PrintBit\uploads\x.upload", CancellationToken.None);

        Assert.Equal("NOT_IMPLEMENTED", health.ErrorCode);
        Assert.Equal("unavailable", health.Status);
        Assert.Null(health.SignatureAgeHours);

        Assert.Equal("NOT_IMPLEMENTED", scan.ErrorCode);
        Assert.Equal("unavailable", scan.Status);
        Assert.Null(scan.DetectionName);
    }
}
