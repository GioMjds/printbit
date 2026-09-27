namespace PrintBit.Infrastructure.Windows.Security;

public sealed record DefenderHealth(string Status, double? SignatureAgeHours, string? Detail, string? ErrorCode);
