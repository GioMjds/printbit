using System.Text.Json.Serialization;

namespace PrintBit.Infrastructure.IPC;

public sealed class WorkerPrintPageResult
{
    [JsonPropertyName("page")]
    public int Page { get; set; }

    [JsonPropertyName("copy")]
    public int Copy { get; set; }

    [JsonPropertyName("state")]
    public string State { get; set; } = string.Empty; // "completed", "cancelled", "failed"
}
