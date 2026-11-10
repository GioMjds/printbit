namespace PrintBit.Infrastructure.Windows.Scanning;

/// <summary>
/// Two-level scan deadline: a per-page window that restarts every time a page
/// arrives (catches a stalled feeder or TWAIN hang early) and an overall cap
/// for the whole scan (must stay below the Node-side IPC timeout).
/// </summary>
public sealed class ScanDeadline : IDisposable
{
    private readonly CancellationTokenSource _overall;
    private readonly CancellationTokenSource _page;
    private readonly CancellationTokenSource _linked;
    private readonly TimeSpan _perPage;

    public ScanDeadline(TimeSpan overall, TimeSpan perPage, CancellationToken external)
    {
        _perPage = perPage;
        _overall = new CancellationTokenSource(overall);
        _page = new CancellationTokenSource(perPage);
        _linked = CancellationTokenSource.CreateLinkedTokenSource(external, _overall.Token, _page.Token);
    }

    public CancellationToken Token => _linked.Token;

    public bool OverallExpired => _overall.IsCancellationRequested;

    public bool PageExpired => _page.IsCancellationRequested && !OverallExpired;

    /// <summary>Call after each page arrives to restart the per-page window.</summary>
    public void PageCompleted()
    {
        if (!_page.IsCancellationRequested)
        {
            _page.CancelAfter(_perPage);
        }
    }

    public void Dispose()
    {
        _linked.Dispose();
        _page.Dispose();
        _overall.Dispose();
    }
}

/// <summary>Allows one scan at a time; a second caller is rejected, not queued.</summary>
public sealed class ScanGate
{
    private readonly SemaphoreSlim _semaphore = new(1, 1);

    public IDisposable? TryEnter()
    {
        return _semaphore.Wait(0) ? new Releaser(_semaphore) : null;
    }

    private sealed class Releaser : IDisposable
    {
        private SemaphoreSlim? _semaphore;

        public Releaser(SemaphoreSlim semaphore) => _semaphore = semaphore;

        public void Dispose() => Interlocked.Exchange(ref _semaphore, null)?.Release();
    }
}

public static class ScanFailurePolicy
{
    /// <summary>
    /// True when the failure suggests the cached device handle may be stale and the
    /// next scan should re-probe. User-fixable or transient-busy outcomes keep it.
    /// </summary>
    public static bool ShouldInvalidateDevice(string? errorCode) => errorCode switch
    {
        "SCAN_TIMEOUT" or "SCAN_PAGE_TIMEOUT" or "PROCESS_FAILED" or "SCANNER_UNAVAILABLE" => true,
        _ => false
    };
}
