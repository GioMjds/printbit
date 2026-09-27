using PrintBit.Shared.Printing;

namespace PrintBit.Infrastructure.Services.PrintService;

public sealed class DocumentPrintResult
{
    public PagePrintState State { get; set; }
    public string? ErrorMessage { get; set; }
    public string? SpoolerJobId { get; set; }
    public PrintFailureStage FailureStage { get; set; }
    public int PagesPrinted { get; set; }
    public int TotalPages { get; set; }
    public string PageCountConfidence { get; set; } = PrintPageCountConfidence.Unknown;
}
