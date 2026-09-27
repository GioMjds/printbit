using System;
using System.Text.Json.Serialization;

namespace PrintBit.Infrastructure.Services.PrintService;

public enum PrinterRecoveryCommandType
{
    [JsonStringEnumMemberName("GetPrinterRecoveryStatus")]
    GetPrinterRecoveryStatus,

    [JsonStringEnumMemberName("AttemptPrinterRecovery")]
    AttemptPrinterRecovery,

    [JsonStringEnumMemberName("RestartPrintSpooler")]
    RestartPrintSpooler
}

public enum PrinterRecoveryOutcome
{
    [JsonStringEnumMemberName("healthy")]
    Healthy,

    [JsonStringEnumMemberName("recovered")]
    Recovered,

    [JsonStringEnumMemberName("manual_intervention_required")]
    ManualInterventionRequired,

    [JsonStringEnumMemberName("worker_busy")]
    WorkerBusy,

    [JsonStringEnumMemberName("restart_failed")]
    RestartFailed,

    [JsonStringEnumMemberName("invalid_request")]
    InvalidRequest
}

public sealed class SpoolerStateDto
{
    public bool IsRunning { get; init; }
    public string Status { get; init; } = string.Empty;
    public string? ErrorMessage { get; init; }
}

public sealed class PrinterRecoveryCommand
{
    public string RequestId { get; init; } = string.Empty;
    public PrinterRecoveryCommandType Type { get; init; }
    public string? PrinterName { get; init; }
    public DateTime TimestampUtc { get; init; }
}

public sealed class PrinterRecoveryResult
{
    public string RequestId { get; init; } = string.Empty;
    public PrinterRecoveryCommandType Type { get; init; }
    public PrinterRecoveryOutcome Outcome { get; init; }
    public string? Action { get; init; }
    public SpoolerStateDto? SpoolerState { get; init; }
    public string? PrinterState { get; init; }
    public string? IssueKind { get; init; }
    public string? Message { get; init; }
    public DateTime StartedAt { get; init; }
    public DateTime CompletedAt { get; init; }
}

