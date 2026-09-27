using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Moq;
using PrintBit.Infrastructure.IPC;
using PrintBit.Infrastructure.Windows.Storage;
using Xunit;

namespace PrintBit.Tests;

public class UsbStorageScaffoldTests
{
    [Fact]
    public async Task UsbDriveMonitor_Scaffold_ReturnsSafePlaceholdersWithoutEvents()
    {
        var pipeMock = new Mock<IWorkerEventPipeClient>();
        var loggerMock = new Mock<ILogger<UsbDriveMonitor>>();
        var monitor = new UsbDriveMonitor(loggerMock.Object, pipeMock.Object);

        var drives = await monitor.ListRemovableAsync(CancellationToken.None);
        Assert.Empty(drives);

        var export = await monitor.ExportAsync(@"C:\PrintBit\scans\test.pdf", "E:", CancellationToken.None);
        Assert.False(export.Success);
        Assert.Equal("NOT_IMPLEMENTED", export.ErrorCode);
        Assert.Null(export.ExportPath);

        // Ensure dormant monitor doesn't send events
        pipeMock.Verify(x => x.SendAsync(It.IsAny<WorkerPrintEvent>(), It.IsAny<CancellationToken>()), Times.Never);
    }
}
