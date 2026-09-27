using System;

namespace PrintBit.Infrastructure.Windows.Time;

public sealed record TrustedTimeSnapshot(
    string Source,
    bool Synced,
    long? OffsetMs,
    bool DriftExceeded,
    int MaxDriftMs,
    DateTime CheckedAt,
    string? NtpSource,
    DateTime? LastSuccessfulSyncAt,
    string Detail,
    string? ErrorCode);
