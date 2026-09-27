using System;
using System.Text.Json;
using System.Text.Json.Serialization;
using PrintBit.Infrastructure.IPC;

namespace PrintBit.Infrastructure.Services.PrintService;

public enum SupervisorDecision
{
    None,
    StartSpooler,
    RestartSpooler
}

public enum PrinterSupervisorState
{
    Starting,
    Ready,
    Busy,
    Recovering,
    Maintenance,
    CircuitOpen
}

public enum PrinterSupervisorPublicStatus
{
    [JsonStringEnumMemberName("ready")]
    Ready,

    [JsonStringEnumMemberName("busy")]
    Busy,

    [JsonStringEnumMemberName("recovering")]
    Recovering,

    [JsonStringEnumMemberName("maintenance")]
    Maintenance
}

public sealed record SupervisorSpoolerSnapshot(string Status, bool Responsive);

public sealed record SupervisorQueueSnapshot(string Status, string? ActiveJobId);

public sealed record SupervisorPrinterSnapshot(
    string Name,
    string? PortName,
    bool Connected,
    string IssueKind,
    string? Message);

public sealed record SupervisorRecoverySnapshot(
    int AttemptsInWindow,
    bool CircuitOpen,
    string? LastAction);

public sealed record PrinterSupervisorSnapshot(
    WorkerPrintEventType Type,
    long Sequence,
    DateTime TimestampUtc,
    PrinterSupervisorPublicStatus Status,
    SupervisorSpoolerSnapshot Spooler,
    SupervisorQueueSnapshot Queue,
    SupervisorPrinterSnapshot Printer,
    SupervisorRecoverySnapshot Recovery)
{
    public static PrinterSupervisorSnapshot Ready(
        long sequence,
        DateTime timestampUtc,
        string printerName,
        string? portName) => new(
            WorkerPrintEventType.PrinterSupervisorSnapshot,
            sequence,
            timestampUtc.ToUniversalTime(),
            PrinterSupervisorPublicStatus.Ready,
            new SupervisorSpoolerSnapshot("Running", true),
            new SupervisorQueueSnapshot("idle", null),
            new SupervisorPrinterSnapshot(printerName, portName, true, "None", null),
            new SupervisorRecoverySnapshot(0, false, null));
}

public static class WorkerJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(allowIntegerValues: false) }
    };
}
