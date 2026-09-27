using System;
using System.Threading;
using System.Threading.Tasks;

namespace PrintBit.Infrastructure.Services.PrintService;

public sealed class PrintOperationCoordinator : IPrinterOperationCoordinator, IDisposable
{
    private readonly SemaphoreSlim _operationLease = new(1, 1);
    private int _disposed;
    private int _activeOperation;

    public PrinterOperationKind ActiveOperation => (PrinterOperationKind)Volatile.Read(ref _activeOperation);

    public async Task<IDisposable> AcquirePrintAsync(CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        await _operationLease.WaitAsync(cancellationToken).ConfigureAwait(false);
        return CreateLease(PrinterOperationKind.Print);
    }

    public bool TryAcquireRecovery(out IDisposable? lease)
    {
        ThrowIfDisposed();

        if (!_operationLease.Wait(0))
        {
            lease = null;
            return false;
        }

        lease = CreateLease(PrinterOperationKind.Recovery);
        return true;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _operationLease.Dispose();
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
    }

    private IDisposable CreateLease(PrinterOperationKind operation)
    {
        Volatile.Write(ref _activeOperation, (int)operation);
        return new OperationLease(_operationLease, () => Volatile.Write(ref _activeOperation, (int)PrinterOperationKind.None));
    }

    private sealed class OperationLease : IDisposable
    {
        private SemaphoreSlim? _semaphore;
        private Action? _release;

        public OperationLease(SemaphoreSlim semaphore, Action release)
        {
            _semaphore = semaphore;
            _release = release;
        }

        public void Dispose()
        {
            var semaphore = Interlocked.Exchange(ref _semaphore, null);
            if (semaphore is not null)
            {
                Interlocked.Exchange(ref _release, null)?.Invoke();
                semaphore.Release();
            }
        }
    }
}
