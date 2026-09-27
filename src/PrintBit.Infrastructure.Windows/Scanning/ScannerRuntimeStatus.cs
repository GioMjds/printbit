namespace PrintBit.Infrastructure.Windows.Scanning;

public sealed record ScannerRuntimeStatus
{
    public bool Connected { get; init; }
    public string Adapter { get; init; } = "naps2";
    public string Driver { get; init; } = "none";
    public string? DeviceName { get; init; }
    public string PreferredName { get; init; } = string.Empty;
    public ScannerCapabilities? Capabilities { get; init; }
    public bool UsingStub { get; init; }
    public DateTime LastCheckedAt { get; init; } = DateTime.UtcNow;
    public string? LastError { get; init; }
}