using PrintBit.Shared.Printing;

namespace PrintBit.Infrastructure.Services.PrintService;

public interface IDocumentPrinter
{
    Task<DocumentPrintResult> PrintDocumentAsync(
        string filePath,
        string printerName,
        int copyNumber,
        IReadOnlyList<int> pages,
        PrintJobSettings settings,
        Func<int, int, Task> onProgress,
        Func<string, Task> onPaused,
        Func<Task> onResumed,
        CancellationToken cancellationToken);
}
