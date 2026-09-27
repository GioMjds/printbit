using System.Text.Json.Serialization;

namespace PrintBit.Infrastructure.IPC;

public sealed record GetDefenderHealthCommand : WorkerHardwareCommand;

public sealed record ScanFileSecurityCommand : WorkerHardwareCommand
{
    [JsonPropertyName("filePath")]
    public string FilePath { get; init; } = string.Empty;
}

public sealed record ListUsbDrivesCommand : WorkerHardwareCommand;

public sealed record ExportScanToUsbCommand : WorkerHardwareCommand
{
    [JsonPropertyName("sourcePath")]
    public string SourcePath { get; init; } = string.Empty;

    [JsonPropertyName("drive")]
    public string Drive { get; init; } = string.Empty;
}

public sealed record GetTrustedTimeStatusCommand : WorkerHardwareCommand
{
    [JsonPropertyName("ntpServer")]
    public string? NtpServer { get; init; }

    [JsonPropertyName("maxDriftMs")]
    public int MaxDriftMs { get; init; } = 60_000;
}

public sealed record PrepareHotspotPlatformCommand : WorkerHardwareCommand
{
    [JsonPropertyName("preferredSubnetPrefixes")]
    public IReadOnlyList<string> PreferredSubnetPrefixes { get; init; } = [];

    [JsonPropertyName("port")]
    public int Port { get; init; }
}

public sealed record WorkerUsbDrive(
    [property: JsonPropertyName("drive")] string Drive,
    [property: JsonPropertyName("label")] string? Label,
    [property: JsonPropertyName("freeBytes")] long FreeBytes,
    [property: JsonPropertyName("totalBytes")] long TotalBytes);

public sealed record WorkerNetworkStatus(
    [property: JsonPropertyName("kioskIp")] string? KioskIp,
    [property: JsonPropertyName("firewallReady")] bool FirewallReady,
    [property: JsonPropertyName("detail")] string? Detail);


public sealed record DefenderHealthResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "GetDefenderHealth";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("status")]
    public string Status { get; init; } = string.Empty;

    [JsonPropertyName("signatureAgeHours")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? SignatureAgeHours { get; init; }

    [JsonPropertyName("detail")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Detail { get; init; }

    [JsonPropertyName("errorCode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorCode { get; init; }
}

public sealed record FileSecurityScanResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "ScanFileSecurity";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("status")]
    public string Status { get; init; } = string.Empty;

    [JsonPropertyName("detectionName")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? DetectionName { get; init; }

    [JsonPropertyName("detail")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Detail { get; init; }

    [JsonPropertyName("errorCode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorCode { get; init; }
}

public sealed record ListUsbDrivesResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "ListUsbDrives";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("drives")]
    public IReadOnlyList<WorkerUsbDrive> Drives { get; init; } = [];

    [JsonPropertyName("errorCode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorCode { get; init; }

    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }
}

public sealed record ExportScanToUsbResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "ExportScanToUsb";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("exportPath")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ExportPath { get; init; }

    [JsonPropertyName("drive")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Drive { get; init; }

    [JsonPropertyName("errorCode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorCode { get; init; }

    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }
}

public sealed record TrustedTimeStatusResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "GetTrustedTimeStatus";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("source")]
    public string Source { get; init; } = string.Empty;

    [JsonPropertyName("synced")]
    public bool Synced { get; init; }

    [JsonPropertyName("offsetMs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? OffsetMs { get; init; }

    [JsonPropertyName("driftExceeded")]
    public bool DriftExceeded { get; init; }

    [JsonPropertyName("maxDriftMs")]
    public int MaxDriftMs { get; init; }

    [JsonPropertyName("checkedAt")]
    public DateTime CheckedAt { get; init; }

    [JsonPropertyName("ntpSource")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? NtpSource { get; init; }

    [JsonPropertyName("lastSuccessfulSyncAt")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTime? LastSuccessfulSyncAt { get; init; }

    [JsonPropertyName("detail")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Detail { get; init; }

    [JsonPropertyName("errorCode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorCode { get; init; }
}

public sealed record PrepareHotspotPlatformResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "PrepareHotspotPlatform";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("kioskIp")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? KioskIp { get; init; }

    [JsonPropertyName("firewallReady")]
    public bool FirewallReady { get; init; }

    [JsonPropertyName("errorCode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorCode { get; init; }

    [JsonPropertyName("detail")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Detail { get; init; }
}