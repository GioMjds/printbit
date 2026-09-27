namespace PrintBit.Infrastructure.IPC;

public sealed record NodeErrorMessage
{
    public string Message { get; init; } = string.Empty;

    public string? Code { get; init; }

    public string? Source { get; init; }

    public string? Stack { get; init; }

    public DateTime? TimestampUtc { get; init; }

    public string? TransactionId { get; init; }

    public string? SpoolerCorrelationKey { get; init; }
}
