namespace PrintBit.Infrastructure.Services.PrintService;

public sealed record HardwareErrorSignal(
    int ErrorCode,
    string Message,
    DateTime TimestampUtc);
