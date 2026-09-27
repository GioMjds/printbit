using System.Text.Json.Serialization;

namespace PrintBit.Infrastructure.IPC;

public abstract record WorkerHardwareCommand
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;
}

public sealed record SimulateCoinCommand : WorkerHardwareCommand
{
    [JsonPropertyName("coinValue")]
    public int CoinValue { get; init; }
}

public sealed record DispenseCoinsCommand : WorkerHardwareCommand
{
    [JsonPropertyName("coinCount")]
    public int CoinCount { get; init; }

    [JsonPropertyName("timeoutMs")]
    public int? TimeoutMs { get; init; }
}

public sealed record LockCoinSlotCommand : WorkerHardwareCommand
{
    [JsonPropertyName("ownerId")]
    public string OwnerId { get; init; } = string.Empty;

    [JsonPropertyName("reason")]
    public string? Reason { get; init; }
}

public sealed record UnlockCoinSlotCommand : WorkerHardwareCommand
{
    [JsonPropertyName("ownerId")]
    public string OwnerId { get; init; } = string.Empty;
}

public sealed record AnnounceKioskIpCommand : WorkerHardwareCommand
{
    [JsonPropertyName("ip")]
    public string Ip { get; init; } = string.Empty;

    [JsonPropertyName("port")]
    public int Port { get; init; }

    [JsonPropertyName("path")]
    public string Path { get; init; } = string.Empty;
}

public sealed record DispenseCoinsResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "DispenseCoins";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("dispensedCoins")]
    public int DispensedCoins { get; init; }

    [JsonPropertyName("errorCode")]
    public string? ErrorCode { get; init; }

    [JsonPropertyName("message")]
    public string? Message { get; init; }
}

public sealed record LockCoinSlotResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "LockCoinSlot";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }
}

public sealed record UnlockCoinSlotResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "UnlockCoinSlot";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("unlocked")]
    public bool Unlocked { get; init; }

    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }
}

public sealed record AnnounceKioskIpResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "AnnounceKioskIp";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }
}

public sealed record HardwareErrorResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Type { get; init; }

    [JsonPropertyName("success")]
    public bool Success { get; init; } = false;

    [JsonPropertyName("errorCode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorCode { get; init; }

    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }
}

public sealed record HardwareCommandResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = string.Empty;

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("dispensedCoins")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? DispensedCoins { get; init; }

    [JsonPropertyName("unlocked")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Unlocked { get; init; }

    [JsonPropertyName("errorCode")]
    public string? ErrorCode { get; init; }

    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }
}

public sealed record GetScannerStatusCommand : WorkerHardwareCommand;

public sealed record ProbeScannerCommand : WorkerHardwareCommand;

public sealed record StartScanCommand : WorkerHardwareCommand
{
    [JsonPropertyName("source")]
    public string Source { get; init; } = "flatbed";

    [JsonPropertyName("dpi")]
    public int Dpi { get; init; } = 300;

    [JsonPropertyName("colorMode")]
    public string ColorMode { get; init; } = "colored";

    [JsonPropertyName("format")]
    public string Format { get; init; } = "pdf";

    [JsonPropertyName("paperSize")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PaperSize { get; init; }

    [JsonPropertyName("outputDir")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OutputDir { get; init; }
}

public sealed record CancelScanCommand : WorkerHardwareCommand
{
    [JsonPropertyName("targetRequestId")]
    public string TargetRequestId { get; init; } = string.Empty;
}

public sealed record ScannerStatusResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "ScannerStatus";

    [JsonPropertyName("connected")]
    public bool Connected { get; init; }

    [JsonPropertyName("adapter")]
    public string Adapter { get; init; } = "naps2";

    [JsonPropertyName("driver")]
    public string Driver { get; init; } = "none";

    [JsonPropertyName("deviceName")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? DeviceName { get; init; }

    [JsonPropertyName("capabilities")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? Capabilities { get; init; }

    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; init; }
}

public sealed record StartScanResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "StartScan";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("outputPath")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OutputPath { get; init; }

    [JsonPropertyName("pageCount")]
    public int PageCount { get; init; }

    [JsonPropertyName("format")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Format { get; init; }

    [JsonPropertyName("errorCode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorCode { get; init; }

    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }
}

public sealed record CancelScanResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "CancelScan";

    [JsonPropertyName("success")]
    public bool Success { get; init; }

    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }
}