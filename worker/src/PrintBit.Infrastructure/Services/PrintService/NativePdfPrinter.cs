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

                    // WinRT PdfPage.Size is reported in 96 DPI DIPs (device-independent pixels, 1/96 in).
                    var widthInInches = page.Size.Width > 0 ? page.Size.Width / 96.0 : 8.5;
                    var heightInInches = page.Size.Height > 0 ? page.Size.Height / 96.0 : 11.0;

                    var targetWidth = Math.Round(widthInInches * RenderDpi);
                    var destWidth = (uint)Math.Clamp(targetWidth, MinRasterDimension, MaxRasterDimension);

                    var targetHeight = Math.Round(heightInInches * RenderDpi);
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
                    var drawW = (float)(widthInInches * 100.0);
                    var drawH = (float)(heightInInches * 100.0);
                    e.Graphics!.DrawImage(image, -hm, -vm, drawW, drawH);
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

    internal static PaperSize? FindPaper(PrinterSettings printer, string? paperSize)
    {
        var kind = MapPaperKind(paperSize);
        var paper = printer.PaperSizes.Cast<PaperSize>().FirstOrDefault(p =>
            p.Kind == kind || (kind == PaperKind.Folio && (p.RawKind == 14 || (p.Width == 850 && p.Height == 1300) || (p.Width == 1300 && p.Height == 850) || p.PaperName.Contains("8.5 x 13", StringComparison.OrdinalIgnoreCase) || p.PaperName.Contains("Folio", StringComparison.OrdinalIgnoreCase))));

        if (paper is null && kind == PaperKind.Folio)
        {
            // Drivers without explicit Folio/8.5x13 (e.g. Microsoft Print to PDF) fall back to Legal (8.5x14)
            // so the 13-inch height is not truncated or forced into an 11-inch Letter sheet.
            paper = printer.PaperSizes.Cast<PaperSize>().FirstOrDefault(p =>
                p.Kind == PaperKind.Legal || p.RawKind == 5);
        }

        return paper;
    }
}
