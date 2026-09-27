namespace PrintBit.Infrastructure.Windows.Networking;

public sealed record KioskNetworkSnapshot(
    bool Success,
    string? KioskIp,
    bool FirewallReady,
    string? ErrorCode,
    string? Detail);
