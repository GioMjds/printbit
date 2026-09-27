using Microsoft.Extensions.Logging;

namespace PrintBit.HardwareService.Services;

public sealed class WorkerInstanceLock : IDisposable
{
    private readonly Mutex _mutex;
    private bool _ownsMutex = true;

    private WorkerInstanceLock(Mutex mutex)
    {
        _mutex = mutex;
    }

    public static WorkerInstanceLock? TryAcquire(
        string mutexName,
        ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(logger);
        if (string.IsNullOrWhiteSpace(mutexName))
        {
            throw new ArgumentException("Worker instance lock name must not be empty.", nameof(mutexName));
        }

        if (OperatingSystem.IsWindows() &&
            !mutexName.StartsWith("Global\\", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException(
                "Worker instance lock name must use the Global\\ namespace on Windows.",
                nameof(mutexName));
        }

        Mutex mutex;
        try
        {
            mutex = new Mutex(false, mutexName);
        }
        catch (UnauthorizedAccessException ex)
        {
            logger.LogWarning(ex, "Worker instance lock {mutexName} is inaccessible", mutexName);
            return null;
        }

        bool acquired;
        try
        {
            acquired = mutex.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            acquired = true;
        }
        catch (UnauthorizedAccessException ex)
        {
            mutex.Dispose();
            logger.LogWarning(ex, "Worker instance lock {mutexName} is already owned", mutexName);
            return null;
        }

        if (!acquired)
        {
            mutex.Dispose();
            return null;
        }

        return new WorkerInstanceLock(mutex);
    }

    public void Dispose()
    {
        if (!_ownsMutex)
        {
            return;
        }

        _ownsMutex = false;
        try
        {
            _mutex.ReleaseMutex();
        }
        finally
        {
            _mutex.Dispose();
        }
    }
}
