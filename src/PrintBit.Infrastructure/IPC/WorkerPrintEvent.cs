using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;
using PrintBit.Shared.Power;

namespace PrintBit.Infrastructure.IPC;

public sealed record WorkerPrintEvent
{
    [JsonPropertyName("type")]
    public WorkerPrintEventType Type { get; init; }

    [JsonPropertyName("transactionId")]
    public string? TransactionId { get; init; }

    [JsonPropertyName("spoolerCorrelationKey")]
    public string? SpoolerCorrelationKey { get; init; }

    [JsonPropertyName("spoolerJobId")]
    public string? SpoolerJobId { get; init; }

    [JsonPropertyName("fileName")]
    public string? FileName { get; init; }

    [JsonPropertyName("printerName")]
    public string? PrinterName { get; init; }

    [JsonPropertyName("failureStage")]
    public string? FailureStage { get; init; }

    [JsonPropertyName("message")]
    public string? Message { get; init; }

    [JsonPropertyName("timestampUtc")]
    public DateTime TimestampUtc { get; init; } = DateTime.UtcNow;

    [JsonPropertyName("pagesPrinted")]
    public int? PagesPrinted { get; init; }

    [JsonPropertyName("totalPages")]
    public int? TotalPages { get; init; }

    [JsonPropertyName("pageCountConfidence")]
    public string? PageCountConfidence { get; init; }

    [JsonPropertyName("completedCount")]
    public int? CompletedCount { get; init; }

    [JsonPropertyName("outcome")]
    public string? Outcome { get; init; }

    [JsonPropertyName("totalCopies")]
    public int? TotalCopies { get; init; }

    [JsonPropertyName("totalExpected")]
    public int? TotalExpected { get; init; }

    [JsonPropertyName("cancelledCount")]
    public int? CancelledCount { get; init; }

    [JsonPropertyName("failedCount")]
    public int? FailedCount { get; init; }

    [JsonPropertyName("pages")]
    public List<WorkerPrintPageResult>? Pages { get; init; }

    [JsonPropertyName("startedAt")]
    public DateTime? StartedAt { get; init; }

    [JsonPropertyName("completedAt")]
    public DateTime? CompletedAt { get; init; }

    [JsonPropertyName("powerStatus")]
    public PowerStatusSnapshot? PowerStatus { get; init; }

    [JsonPropertyName("operationalState")]
    public PowerOperationalState? OperationalState { get; init; }

    [JsonPropertyName("acceptingTransactions")]
    public bool? AcceptingTransactions { get; init; }

    [JsonPropertyName("powerSourceInstanceId")]
    public string? PowerSourceInstanceId { get; init; }

    [JsonPropertyName("powerSequence")]
    public long? PowerSequence { get; init; }

    [JsonPropertyName("coinValue")]
    public int? CoinValue { get; init; }

    [JsonPropertyName("simulated")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Simulated { get; init; }

    [JsonPropertyName("rejectReason")]
    public string? RejectReason { get; init; }

    [JsonPropertyName("dispensedCoins")]
    public int? DispensedCoins { get; init; }

    [JsonPropertyName("totalCoins")]
    public int? TotalCoins { get; init; }

    [JsonPropertyName("errorCode")]
    public string? ErrorCode { get; init; }

    [JsonPropertyName("hardwareRequestId")]
    public string? HardwareRequestId { get; init; }

    [JsonPropertyName("requestId")]
    public string? RequestId { get; init; }

    [JsonPropertyName("usbDrive")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public WorkerUsbDrive? UsbDrive { get; init; }

    [JsonPropertyName("networkStatus")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public WorkerNetworkStatus? NetworkStatus { get; init; }
}
