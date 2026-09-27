namespace PrintBit.Shared.Printing;

/// <summary>
/// Helpers for the on-disk naming convention shared by the queue-watcher
/// (PrintQueueWatcherService) and the WMI-based progress poller
/// (PrinterMonitorService). Both sides agree that a print sidecar file
/// is named
///   <c>{transactionId}_{spoolerCorrelationKey}_{timestamp}.{ext}</c>
/// and that the first two underscore-separated segments uniquely identify
/// the lifecycle record on the Node side. Keeping the parser here in
/// <see cref="PrintBit.Shared"/> means both the executable project
/// (HardwareService) and the Windows-only library (Infrastructure.Windows)
/// can parse the name without one having to take a project reference on
/// the other.
/// </summary>
public static class PrintJobFileName
{
    /// <summary>
    /// Extracts <c>(transactionId, spoolerCorrelationKey)</c> from a
    /// document filename produced by the Node-side handoff
    /// (see <c>worker-handoff.ts</c>). Returns <c>(null, null)</c> when
    /// the filename does not match the expected two-segment shape — for
    /// example, when the spooler reports a foreign job dispatched by
    /// some other process.
    /// </summary>
    public static (string? TransactionId, string? SpoolerCorrelationKey) TryParseCorrelation(
        string fileName)
    {
        var baseName = Path.GetFileNameWithoutExtension(fileName);
        var parts = baseName.Split('_', 3, StringSplitOptions.RemoveEmptyEntries);

        if (parts.Length < 2)
        {
            return (null, null);
        }

        return (parts[0], parts[1]);
    }
}
