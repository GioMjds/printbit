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
    private const uint MinRasterDimension = 1;
    private const uint MaxRasterDimension = 5000;

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

            if (pdf.PageCount == 0)
            {
                throw new InvalidOperationException("PDF document contains no pages.");
            }

            foreach (var pageNum in pages)
            {
                if (pageNum < 1 || pageNum > pdf.PageCount)
                {
                    throw new ArgumentOutOfRangeException(
                        nameof(pages),
                        $"Requested page {pageNum} is out of range. Document contains {pdf.PageCount} page(s).");
                }
            }

            using var doc = new PrintDocument { DocumentName = Path.GetFileName(filePath) };
            doc.PrinterSettings.PrinterName = printerName;
            if (!doc.PrinterSettings.IsValid)
            {
                throw new InvalidOperationException($"Printer not found: {printerName}");
            }

            if (printerName.Contains("PDF", StringComparison.OrdinalIgnoreCase))
            {
                var outPath = @"C:\Users\printbit\test_output.pdf";
                try { if (File.Exists(outPath)) File.Delete(outPath); } catch { }
                doc.PrinterSettings.PrintToFile = true;
                doc.PrinterSettings.PrintFileName = outPath;
            }

            var copies = Math.Max(1, settings.Copies);
            if (copies > doc.PrinterSettings.MaximumCopies)
            {
                throw new InvalidOperationException(
                    $"Printer supports at most {doc.PrinterSettings.MaximumCopies} copies per job.");
            }
            doc.PrinterSettings.Copies = (short)copies;
            doc.PrinterSettings.Collate = true;
            doc.DefaultPageSettings.Color = settings.Color;
            doc.DefaultPageSettings.Landscape = string.Equals(settings.Orientation?.Trim(), "landscape", StringComparison.OrdinalIgnoreCase);
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
                    var pageNumber = pages[index];
                    if (pageNumber < 1 || pageNumber > pdf.PageCount)
                    {
                        throw new ArgumentOutOfRangeException(
                            nameof(pages),
                            $"Requested page {pageNumber} is out of range. Document contains {pdf.PageCount} page(s).");
                    }

                    using var page = pdf.GetPage((uint)(pageNumber - 1));
                    using var stream = new InMemoryRandomAccessStream();

                    var targetWidth = page.Size.Width > 0 ? Math.Round(page.Size.Width / 72.0 * RenderDpi) : MinRasterDimension;
                    var destWidth = (uint)Math.Clamp(targetWidth, MinRasterDimension, MaxRasterDimension);

                    var targetHeight = page.Size.Height > 0 ? Math.Round(page.Size.Height / 72.0 * RenderDpi) : MinRasterDimension;
                    var destHeight = (uint)Math.Clamp(targetHeight, MinRasterDimension, MaxRasterDimension);

                    page.RenderToStreamAsync(stream, new PdfPageRenderOptions
                    {
                        DestinationWidth = destWidth,
                        DestinationHeight = destHeight
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

    internal static PaperKind MapPaperKind(string? paperSize) =>
        paperSize?.Trim().ToLowerInvariant() switch
        {
            "letter" or "short" => PaperKind.Letter,
            "legal" or "folio" or "long" => PaperKind.Folio,
            _ => PaperKind.A4
        };

    private static PaperSize? FindPaper(PrinterSettings printer, string? paperSize)
    {
        var kind = MapPaperKind(paperSize);
        return printer.PaperSizes.Cast<PaperSize>().FirstOrDefault(p =>
            p.Kind == kind || (kind == PaperKind.Folio && p.RawKind == 14));
    }
}
