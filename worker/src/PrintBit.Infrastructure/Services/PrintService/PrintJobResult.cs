namespace PrintBit.Infrastructure.Services.PrintService;

public class PrintJobResult
{
    public bool Success { get; set; }

    public string Message { get; set; } = string.Empty;

    public bool SumatraProcessSucceeded { get; set; }

    public bool VerificationSucceeded { get; set; }

    public PrintFailureStage FailureStage { get; set; } = PrintFailureStage.None;

    public int? ExitCode { get; set; }

    public string? SpoolerJobId { get; set; }

    public string? SpoolerPrinterName { get; set; }

    // Last-seen page counts from Win32_PrintJob. Populated by the verification
    // loop and forwarded to Node so it can distinguish "1 of 2 printed
    // (paper out)" from "2 of 2 printed". Null when the spooler never
    // reported page counts (job never appeared in the queue, or
    // TotalPages was 0 the whole time).
    public int? PagesPrinted { get; set; }

    public int? TotalPages { get; set; }

    public string PageCountConfidence { get; set; } = PrintPageCountConfidence.Unknown;

    public static PrintJobResult Failed(
        PrintFailureStage stage,
        string message,
        int? exitCode = null,
        string? spoolerJobId = null,
        int? pagesPrinted = null,
        int? totalPages = null,
        string pageCountConfidence = PrintPageCountConfidence.Unknown)
    {
        return new PrintJobResult
        {
            Success = false,
            SumatraProcessSucceeded = stage is PrintFailureStage.SpoolerVerification
                                    or PrintFailureStage.HardwareError
                                    or PrintFailureStage.IncompleteOutput,
            VerificationSucceeded = false,
            FailureStage = stage,
            Message = message,
            ExitCode = exitCode,
            SpoolerJobId = spoolerJobId,
            PagesPrinted = pagesPrinted,
            TotalPages = totalPages,
            PageCountConfidence = pageCountConfidence
        };
    }
}
