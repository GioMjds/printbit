namespace PrintBit.Infrastructure.Services.DocumentConversion;

public sealed class DocumentConversionRequest
{
    public string RequestId { get; set; } = string.Empty;
    public string SourcePath { get; set; } = string.Empty;
    public string? OutputDirectory { get; set; }
    public string TargetFormat { get; set; } = "pdf";
    public int TimeoutSeconds { get; set; } = 60;
}

public sealed class DocumentConversionResult
{
    public string RequestId { get; set; } = string.Empty;
    public bool Success { get; set; }
    public string? OutputPath { get; set; }
    public int? PageCount { get; set; }
    public string? SourceFormat { get; set; }
    public long DurationMs { get; set; }
    public string? ErrorMessage { get; set; }
}
