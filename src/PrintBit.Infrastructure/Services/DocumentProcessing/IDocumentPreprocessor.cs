using PrintBit.Infrastructure.Services.PrintService;

namespace PrintBit.Infrastructure.Services.DocumentProcessing;

public interface IDocumentPreprocessor
{
    Task<PreparedDocument> PrepareAsync(
        string sourcePath,
        PrintJobSettings settings,
        CancellationToken cancellationToken);
}

public sealed class PreparedDocument(
    string filePath,
    int pageCount,
    IReadOnlyList<string> cleanupPaths) : IDisposable
{
    public string FilePath { get; } = filePath;
    public int PageCount { get; } = pageCount;

    public void Dispose()
    {
        foreach (var path in cleanupPaths)
        {
            try { File.Delete(path); } catch { }
        }
    }
}
