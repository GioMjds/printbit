using System.Diagnostics;
using Microsoft.Extensions.Options;
using PdfSharp.Drawing;
using PdfSharp.Pdf;
using PdfSharp.Pdf.IO;
using PrintBit.Infrastructure.Services.DocumentConversion;
using PrintBit.Infrastructure.Services.PrintService;
using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.Services.DocumentProcessing;

public sealed class DocumentPreprocessor : IDocumentPreprocessor
{
    private readonly string? _qpdfPath;
    private readonly IDocumentConversionService? _conversionService;

    public DocumentPreprocessor(
        IOptions<HardwareSettings>? hardwareOptions = null,
        IDocumentConversionService? conversionService = null)
    {
        _qpdfPath = hardwareOptions?.Value?.QpdfPath;
        _conversionService = conversionService;
    }

    public async Task<PreparedDocument> PrepareAsync(
        string sourcePath,
        PrintJobSettings settings,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!File.Exists(sourcePath))
        {
            throw new FileNotFoundException("Print source was not found", sourcePath);
        }

        var outputPath = Path.Combine(
            Path.GetTempPath(),
            $"printbit-prepared-{Guid.NewGuid():N}.pdf");
        string? tempConvertedPdf = null;
        try
        {
            var extension = Path.GetExtension(sourcePath).ToLowerInvariant();
            string effectivePdfPath = sourcePath;

            if (extension != ".pdf" && (extension == ".docx" || extension == ".doc" || extension == ".odt" || extension == ".rtf" || extension == ".txt") && _conversionService != null)
            {
                var convResult = await _conversionService.ConvertAsync(new DocumentConversionRequest
                {
                    RequestId = Guid.NewGuid().ToString("N"),
                    SourcePath = sourcePath,
                    OutputDirectory = Path.GetTempPath(),
                    TargetFormat = "pdf"
                }, cancellationToken);

                if (convResult.Success && !string.IsNullOrEmpty(convResult.OutputPath) && File.Exists(convResult.OutputPath))
                {
                    tempConvertedPdf = convResult.OutputPath;
                    effectivePdfPath = tempConvertedPdf;
                    extension = ".pdf";
                }
            }

            var pageCount = extension == ".pdf"
                ? PreparePdf(effectivePdfPath, outputPath, settings, cancellationToken)
                : PrepareImage(sourcePath, outputPath, settings);

            var cleanupList = tempConvertedPdf != null
                ? new[] { outputPath, tempConvertedPdf }
                : new[] { outputPath };

            return new PreparedDocument(outputPath, pageCount, cleanupList);
        }
        catch
        {
            try { File.Delete(outputPath); } catch { }
            if (tempConvertedPdf != null) { try { File.Delete(tempConvertedPdf); } catch { } }
            throw;
        }
    }

    private int PreparePdf(
        string sourcePath,
        string outputPath,
        PrintJobSettings settings,
        CancellationToken cancellationToken)
    {
        string workingPath = sourcePath;
        string? tempDecompressed = null;
        XPdfForm? form = null;

        try
        {
            try
            {
                form = XPdfForm.FromFile(workingPath);
            }
            catch
            {
                var qpdf = PdfPageCounter.ResolveQpdfPath(_qpdfPath);
                if (qpdf != null)
                {
                    tempDecompressed = Path.Combine(
                        Path.GetTempPath(),
                        $"printbit-qpdf-decomp-{Guid.NewGuid():N}.pdf");

                    if (TryDecompressWithQpdf(qpdf, workingPath, tempDecompressed))
                    {
                        workingPath = tempDecompressed;
                        try
                        {
                            form = XPdfForm.FromFile(workingPath);
                        }
                        catch { }
                    }
                }

                if (form == null)
                {
                    // Fallback: pass-through original file if PDFsharp cannot parse it
                    File.Copy(sourcePath, outputPath, true);
                    return PdfPageCounter.Count(sourcePath, _qpdfPath) ?? 1;
                }
            }

            using (form)
            using (var output = new PdfDocument())
            {
                output.Info.Title = Path.GetFileName(outputPath);
                var plan = PrintPlanBuilder.Build(form.PageCount, settings);
                foreach (var pageNumber in plan.SelectedPages)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    form.PageNumber = pageNumber;

                    var page = output.AddPage();
                    SetPaperGeometry(page, settings.PaperSize, settings.Orientation);

                    var sourcePage = form.Page ?? throw new InvalidDataException("PDF page is missing");
                    var originalMediaBox = sourcePage.MediaBox;
                    var pageNativeRotation = sourcePage.Rotate;
                    var totalRotation = NormalizeRotation(pageNativeRotation + settings.RotationDeg);
                    try
                    {
                        // PDFsharp imports /Rotate and uses MediaBox as the form's clipping
                        // box. Normalize both so the visible page matches PDF.js and rotation
                        // is applied exactly once by our outer layout transform.
                        sourcePage.Rotate = 0;
                        sourcePage.MediaBox = VisibleBox(originalMediaBox, sourcePage.CropBox);
                        RenderFormToPage(XGraphics.FromPdfPage(page), form, page, totalRotation, settings);
                    }
                    finally
                    {
                        sourcePage.MediaBox = originalMediaBox;
                        sourcePage.Rotate = pageNativeRotation;
                    }
                }

                if (settings.Duplex && output.PageCount % 2 == 1)
                {
                    var blank = output.AddPage();
                    SetPaperGeometry(blank, settings.PaperSize, settings.Orientation);
                }

                var outputPageCount = output.PageCount;
                output.Save(outputPath);
                return outputPageCount;
            }
        }
        finally
        {
            if (tempDecompressed != null)
            {
                try { File.Delete(tempDecompressed); } catch { }
            }
        }
    }

    private static bool TryDecompressWithQpdf(string qpdfExe, string inputPdf, string outputPdf)
    {
        try
        {
            using var proc = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = qpdfExe,
                    Arguments = $"--object-streams=disable \"{inputPdf}\" \"{outputPdf}\"",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                }
            };
            proc.Start();
            return proc.WaitForExit(10000) && proc.ExitCode == 0 && File.Exists(outputPdf);
        }
        catch
        {
            return false;
        }
    }

    private static void RenderFormToPage(XGraphics graphics, XPdfForm form, PdfPage page, int rotation, PrintJobSettings settings)
    {
        using (graphics)
        {
            var rawW = form.PointWidth;
            var rawH = form.PointHeight;

            var scale = PrintLayout.Calculate(rawW, rawH, settings, rotation).Scale;

            var cx = page.Width.Point / 2;
            var cy = page.Height.Point / 2;
            graphics.TranslateTransform(cx, cy);
            graphics.RotateTransform(rotation);
            // Scale the coordinate system, not DrawImage dimensions: PDFsharp's
            // imported MediaBox origin offsets must scale with the content too.
            graphics.ScaleTransform(scale);
            graphics.DrawImage(form, -rawW / 2, -rawH / 2, rawW, rawH);
        }
    }

    private static PdfRectangle VisibleBox(PdfRectangle media, PdfRectangle crop)
    {
        var left = Math.Max(media.X1, crop.X1);
        var bottom = Math.Max(media.Y1, crop.Y1);
        var right = Math.Min(media.X2, crop.X2);
        var top = Math.Min(media.Y2, crop.Y2);
        return right > left && top > bottom
            ? new PdfRectangle(new XPoint(left, bottom), new XPoint(right, top))
            : media;
    }

    private static int PrepareImage(
        string sourcePath,
        string outputPath,
        PrintJobSettings settings)
    {
        var supported = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tif", ".tiff"
        };
        if (!supported.Contains(Path.GetExtension(sourcePath)))
        {
            throw new InvalidDataException("Document preprocessing requires a PDF or supported image");
        }

        using var image = XImage.FromFile(sourcePath);
        using var output = new PdfDocument();
        var page = output.AddPage();
        SetPaperGeometry(page, settings.PaperSize, settings.Orientation);

        var rotation = NormalizeRotation(settings.RotationDeg);
        RenderImageToPage(XGraphics.FromPdfPage(page), image, page, rotation, settings);

        output.Save(outputPath);
        return 1;
    }

    private static void RenderImageToPage(XGraphics graphics, XImage image, PdfPage page, int rotation, PrintJobSettings settings)
    {
        using (graphics)
        {
            // Browser image previews use pixel geometry. Separate X/Y DPI tags
            // must not distort that aspect ratio. Internal actual uses 1 px = 1 pt.
            var rawW = image.PixelWidth;
            var rawH = image.PixelHeight;
            var scale = PrintLayout.Calculate(rawW, rawH, settings, rotation).Scale;

            var destW = rawW * scale;
            var destH = rawH * scale;

            var cx = page.Width.Point / 2;
            var cy = page.Height.Point / 2;

            if (rotation != 0)
            {
                graphics.RotateAtTransform(rotation, new XPoint(cx, cy));
            }

            graphics.DrawImage(
                image,
                cx - (destW / 2),
                cy - (destH / 2),
                destW,
                destH);
        }
    }

    private static void SetPaperGeometry(PdfPage page, string? paperSize, string? orientation)
    {
        var (width, height) = PrintLayout.PaperGeometry(paperSize, orientation);
        page.Width = XUnit.FromPoint(width);
        page.Height = XUnit.FromPoint(height);
    }

    private static IReadOnlyList<int> SelectPages(int pageCount, string? pageRange)
    {
        if (string.IsNullOrWhiteSpace(pageRange))
        {
            return Enumerable.Range(1, pageCount).ToArray();
        }

        var selected = new SortedSet<int>();
        foreach (var chunk in pageRange.Split(',', StringSplitOptions.TrimEntries))
        {
            var endpoints = chunk.Split('-', StringSplitOptions.TrimEntries);
            if (!int.TryParse(endpoints[0], out var start) ||
                start < 1 || start > pageCount)
            {
                throw new InvalidDataException("Invalid page range");
            }
            var end = start;
            if (endpoints.Length == 2 &&
                (!int.TryParse(endpoints[1], out end) || end < start || end > pageCount))
            {
                throw new InvalidDataException("Invalid page range");
            }
            if (endpoints.Length > 2) throw new InvalidDataException("Invalid page range");
            for (var page = start; page <= end; page++) selected.Add(page);
        }
        if (selected.Count == 0) throw new InvalidDataException("Page range selected no pages");
        return selected.ToArray();
    }

    private static int NormalizeRotation(int value) => (((value % 360) + 360) % 360) switch
    {
        90 => 90,
        180 => 180,
        270 => 270,
        _ => 0
    };
}
