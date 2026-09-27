namespace PrintBit.Infrastructure.Windows.Scanning;

public sealed record ScannerCapabilities
{
    public bool Available { get; init; }
    public IReadOnlyList<string> Sources { get; init; } = ["flatbed", "adf"];
    public IReadOnlyList<string> ColorModes { get; init; } = ["colored", "grayscale"];
    public IReadOnlyList<int> DpiOptions { get; init; } = [150, 300, 600];
    public bool Duplex { get; init; } = false;
}
