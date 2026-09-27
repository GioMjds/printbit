using System.Threading;
using System.Threading.Tasks;
using PrintBit.Infrastructure.Services.PrintService;
using Xunit;

namespace PrintBit.Tests;

public class PrinterOperationCoordinatorTests
{
    [Fact]
    public async Task Coordinator_ReportsPrintOnlyWhileLeaseHeld()
    {
        using var value = new PrintOperationCoordinator();

        Assert.Equal(PrinterOperationKind.None, value.ActiveOperation);

        using (await value.AcquirePrintAsync(CancellationToken.None))
        {
            Assert.Equal(PrinterOperationKind.Print, value.ActiveOperation);
        }

        Assert.Equal(PrinterOperationKind.None, value.ActiveOperation);
    }

    [Fact]
    public void Coordinator_ReportsRecoveryOnlyWhileLeaseHeld()
    {
        using var value = new PrintOperationCoordinator();

        Assert.True(value.TryAcquireRecovery(out var lease));
        using (lease)
        {
            Assert.Equal(PrinterOperationKind.Recovery, value.ActiveOperation);
        }

        Assert.Equal(PrinterOperationKind.None, value.ActiveOperation);
    }
}
