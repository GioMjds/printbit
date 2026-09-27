using Microsoft.Extensions.Logging.Abstractions;
using PrintBit.HardwareService.Services;
using Xunit;

namespace PrintBit.Tests;

public sealed class WorkerInstanceLockTests
{
    [Fact]
    public async Task TryAcquire_AllowsOneOwnerAndRejectsSecondOwner()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var name = $"Global\\PrintBitTestWorker-{Guid.NewGuid():N}";
        var firstOwnerReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirstOwner = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstOwner = Task.Run(async () =>
        {
            using var first = WorkerInstanceLock.TryAcquire(name, NullLogger.Instance);
            firstOwnerReady.SetResult();
            await releaseFirstOwner.Task;
            Assert.NotNull(first);
        });

        await firstOwnerReady.Task;
        using var second = WorkerInstanceLock.TryAcquire(name, NullLogger.Instance);

        Assert.Null(second);
        releaseFirstOwner.SetResult();
        await firstOwner;
    }

    [Fact]
    public void Dispose_ReleasesOwnershipForLaterAcquisition()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var name = $"Global\\PrintBitTestWorker-{Guid.NewGuid():N}";
        using (var first = WorkerInstanceLock.TryAcquire(name, NullLogger.Instance))
        {
            Assert.NotNull(first);
        }

        using var second = WorkerInstanceLock.TryAcquire(name, NullLogger.Instance);
        Assert.NotNull(second);
    }

    [Fact]
    public void TryAcquire_RejectsInvalidLockName()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        Assert.Throws<ArgumentException>(
            () => WorkerInstanceLock.TryAcquire("PrintBitWorker", NullLogger.Instance));
    }
}
