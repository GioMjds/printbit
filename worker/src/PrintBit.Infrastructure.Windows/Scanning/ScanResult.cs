namespace PrintBit.Infrastructure.Windows.Scanning;

public sealed record ScanResult
{
    public bool Success { get; init; }
    public string OutputPath { get; init; } = string.Empty;
    public int PageCount { get; init; }
    public string Format { get; init; } = string.Empty;
    public string? ErrorCode { get; init; }
    public string? ErrorMessage { get; init; }
}
