namespace PrintBit.Infrastructure.Windows.Storage;

public sealed record RemovableDrive(string Drive, string? Label, long FreeBytes, long TotalBytes);