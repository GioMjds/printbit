namespace PrintBit.Infrastructure.Services.PrintService;

public class PrintJobRequest
{
    public string FilePath { get; set; } = string.Empty;
    public string PrinterName { get; set; } = string.Empty;
    public PrintJobSettings Settings { get; set; } = new();

    // Optional. When set, the verification loop uses this as the
    // authoritative expected page count instead of falling back to
    // Win32_PrintJob.TotalPages. The queue watcher computes this by
    // parsing the PDF (see PdfPageCounter) and passes it through.
    public int? ExpectedPages { get; set; }
}
