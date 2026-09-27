namespace PrintBit.Infrastructure.Windows.Security;

public sealed record DefenderScanResult(string Status, string? DetectionName, string? Detail, string? ErrorCode);
