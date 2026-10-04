using System.Drawing;
using System.Drawing.Printing;
using Windows.Data.Pdf;
using Windows.Storage;
using Windows.Storage.Streams;
using PrintBit.Shared.Printing;

namespace PrintBit.Infrastructure.Services.PrintService;

/// <summary>
/// In-process replacement for SumatraPDF: renders pages with the built-in Windows PDF
/// renderer and spools them through the stock Windows print path. No child process.
/// </summary>
internal static class NativePdfPrinter
{
    // ponytail: fixed 300 DPI raster; make configurable if the driver is slower/faster at other DPI.
    private const double RenderDpi = 300;

    public static Task PrintAsync(
        string filePath,
        string printerName,
        IReadOnlyList<int> pages,
        PrintJobSettings settings,
        CancellationToken ct) =>
        // PrintPage is synchronous; run on a pool thread so blocking on WinRT async is safe.
        Task.Run(async () =>
        {
            var file = await StorageFile.GetFileFromPathAsync(filePath);
            var pdf = await PdfDocument.LoadFromFileAsync(file);

            using var doc = new PrintDocument { DocumentName = Path.GetFileName(filePath) };
            doc.PrinterSettings.PrinterName = printerName;
            if (!doc.PrinterSettings.IsValid)
            {
                throw new InvalidOperationException($"Printer not found: {printerName}");
            }

            doc.PrinterSettings.Copies = (short)Math.Max(1, settings.Copies);
            doc.PrinterSettings.Collate = true;
            doc.DefaultPageSettings.Color = settings.Color;
            doc.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);
            var paper = FindPaper(doc.PrinterSettings, settings.PaperSize);
            if (paper is not null)
            {
                doc.DefaultPageSettings.PaperSize = paper;
            }

            var index = 0;
            Exception? failure = null;
            doc.PrintPage += (_, e) =>
            {
                try
                {
                    ct.ThrowIfCancellationRequested();
                    using var page = pdf.GetPage((uint)(pages[index] - 1));
                    using var stream = new InMemoryRandomAccessStream();
                    page.RenderToStreamAsync(stream, new PdfPageRenderOptions
                    {
                        DestinationWidth = (uint)(page.Size.Width / 96 * RenderDpi),
                        DestinationHeight = (uint)(page.Size.Height / 96 * RenderDpi)
                    }).AsTask(ct).GetAwaiter().GetResult();

                    using var image = Image.FromStream(stream.AsStreamForRead());
                    // Page is already paper-sized (DocumentPreprocessor); draw over the full sheet,
                    // not just the printable area, so output matches the preview.
                    var hm = e.PageSettings.HardMarginX;
                    var vm = e.PageSettings.HardMarginY;
                    e.Graphics!.DrawImage(image, -hm, -vm, e.PageBounds.Width, e.PageBounds.Height);
                    e.HasMorePages = ++index < pages.Count;
                }
                catch (Exception ex)
                {
                    failure = ex;
                    e.Cancel = true;
                }
            };

            doc.Print(); // blocks until all pages are spooled
            if (failure is not null)
            {
                throw failure;
            }
        }, ct);

    private static PaperSize? FindPaper(PrinterSettings printer, string? paperSize)
    {
        var kind = paperSize?.Trim().ToLowerInvariant() switch
        {
            "letter" => PaperKind.Letter,
            // Epson "8.5 x 13 in" = DMPAPER_FOLIO (14); same mapping as the Sumatra path.
            "legal" or "folio" => PaperKind.Folio,
            _ => PaperKind.A4
        };
        return printer.PaperSizes.Cast<PaperSize>().FirstOrDefault(p => p.Kind == kind);
    }
}
