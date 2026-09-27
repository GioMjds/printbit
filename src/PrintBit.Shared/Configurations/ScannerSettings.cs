namespace PrintBit.Shared.Configurations;

public sealed class ScannerSettings
{
    public string Naps2Path { get; set; } = @"C:\Program Files\NAPS2\NAPS2.Console.exe";
    public string PreferredScannerName { get; set; } = "EPSON L5290 Series";
    public string PreferredDriver { get; set; } = "wia";
    public string ScanOutputDir { get; set; } = @"uploads\scans";
    public int ScanTimeoutSeconds { get; set; } = 90;
    public int ProbeTimeoutSeconds { get; set; } = 8;
    public bool EnableStubFallback { get; set; } = true;
}
