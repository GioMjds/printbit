using System.Text.Json.Serialization;

namespace PrintBit.Shared.Power;

public enum AcLineStatus
{
    Online,
    Offline,
    Unknown
}

public sealed record PowerStatusSnapshot(
    [property: JsonPropertyName("acLineStatus")] AcLineStatus AcLineStatus,
    [property: JsonPropertyName("isCharging")] bool? IsCharging,
    [property: JsonPropertyName("batteryPercentage")] int? BatteryPercentage,
    [property: JsonPropertyName("isBatteryLow")] bool? IsBatteryLow,
    [property: JsonPropertyName("isBatteryCritical")] bool? IsBatteryCritical);
