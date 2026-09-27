namespace PrintBit.Infrastructure.Services.PrintService;

public enum PrintFailureStage
{
    None = 0,
    Validation,
    ProcessStart,
    ProcessExit,
    Timeout,
    SpoolerVerification,
    // PagesPrinted stalled below TotalPages (paper-out, jam, tray-empty,
    // partial print). Detected by reading Win32_PrintJob.PagesPrinted vs
    // TotalPages in the spooler verification loop.
    IncompleteOutput,
    Unexpected,
    HardwareError
}
