namespace PrintBit.Infrastructure.Windows.Storage;

public sealed record UsbExportResult(bool Success, string? ExportPath, string? Drive, string? ErrorCode, string? Message);