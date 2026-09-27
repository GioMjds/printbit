using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace PrintBit.Infrastructure.Windows.Time;

public sealed class WindowsTrustedTimeProvider : ITrustedTimeProvider
{
    private readonly ILogger<WindowsTrustedTimeProvider> _logger;

    public WindowsTrustedTimeProvider(ILogger<WindowsTrustedTimeProvider> logger)
    {
        _logger = logger;
    }

    public Task<TrustedTimeSnapshot> GetStatusAsync(string? ntpServer, int maxDriftMs, CancellationToken cancellationToken)
    {
        _logger.LogDebug("WindowsTrustedTimeProvider.GetStatusAsync called with NtpServer={NtpServer}, MaxDriftMs={MaxDriftMs} (scaffold placeholder)",
            ntpServer, maxDriftMs);

        return Task.FromResult(new TrustedTimeSnapshot(
            Source: "system",
            Synced: false,
            OffsetMs: null,
            DriftExceeded: false,
            MaxDriftMs: maxDriftMs,
            CheckedAt: DateTime.UtcNow,
            NtpSource: ntpServer,
            LastSuccessfulSyncAt: null,
            Detail: "Windows trusted time provider is scaffolded and not yet implemented.",
            ErrorCode: "NOT_IMPLEMENTED"));
    }
}