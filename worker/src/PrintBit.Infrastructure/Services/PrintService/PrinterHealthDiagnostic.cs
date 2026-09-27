namespace PrintBit.Infrastructure.Services.PrintService;

public enum PrinterHealthState
{
    Healthy,
    Offline,
    Unavailable,
    Fault
}

public enum PrinterHealthIssueKind
{
    None,
    PhysicalFault,
    WindowsQueueFault,
    Unknown
}

public sealed class PrinterHealthDiagnostic
{
    public PrinterHealthState PrinterState { get; init; }
    public PrinterHealthIssueKind IssueKind { get; init; }
    public int WinSpoolStatus { get; init; }
    public string WinSpoolDescription { get; init; } = string.Empty;
    public int? WmiCode { get; init; }
    public string? WmiDescription { get; init; }
    public string? EpsonPopupText { get; init; }
    public string? PortName { get; init; }
    public bool IsHealthy =>
        PrinterState == PrinterHealthState.Healthy &&
        IssueKind == PrinterHealthIssueKind.None;
}
