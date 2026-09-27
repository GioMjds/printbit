namespace PrintBit.Infrastructure.Windows.Scanning;

public sealed record ScanRequest
{
    public string RequestId { get; init; } = string.Empty;
    public string Source { get; init; } = "flatbed";
    public int Dpi { get; init; } = 300;
    public string ColorMode { get; init; } = "colored";
    public string Format { get; init; } = "pdf";
    public string? PaperSize { get; init; }
    public string? OutputDir { get; init; }
}
