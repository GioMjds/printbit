using PdfSharp.Drawing;
using PdfSharp.Pdf;
using PdfSharp.Pdf.Advanced;
using PdfSharp.Pdf.IO;
using PrintBit.Infrastructure.Services.DocumentProcessing;
using PrintBit.Infrastructure.Services.PrintService;

namespace PrintBit.Tests;

public class PrintSourceGeometryTests
{
    [Fact]
    public async Task ImageWithUnequalDpi_PreservesPixelAspectRatio()
    {
        var sourcePath = Path.Combine(Path.GetTempPath(), $"print-dpi-{Guid.NewGuid():N}.png");
        try
        {
            using (var bitmap = new System.Drawing.Bitmap(120, 60))
            {
                bitmap.SetResolution(300, 150);
                using var graphics = System.Drawing.Graphics.FromImage(bitmap);
                graphics.Clear(System.Drawing.Color.Red);
                bitmap.Save(sourcePath, System.Drawing.Imaging.ImageFormat.Png);
            }
            using var prepared = await new DocumentPreprocessor().PrepareAsync(sourcePath,
                new PrintJobSettings { PaperSize = "Letter" }, CancellationToken.None);
            using var result = PdfReader.Open(prepared.FilePath, PdfDocumentOpenMode.Import);
            var content = System.Text.Encoding.ASCII.GetString(result.Pages[0].Contents.CreateSingleContent().Stream.UnfilteredValue);
            // Image painting maps the unit square to 583.2 x 291.6 pt, not a square.
            Assert.Matches(@"583\.2\d* 0 0 291\.6\d* ", content);
        }
        finally { File.Delete(sourcePath); }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(90)]
    [InlineData(180)]
    [InlineData(270)]
    public async Task CroppedNativeRotation_IsClippedAndRotatedOnlyByOuterLayout(int nativeRotation)
    {
        var sourcePath = Path.Combine(Path.GetTempPath(), $"print-geometry-{Guid.NewGuid():N}.pdf");
        try
        {
            using (var source = new PdfDocument())
            {
                var page = source.AddPage();
                page.Width = XUnit.FromPoint(612);
                page.Height = XUnit.FromPoint(792);
                using (var graphics = XGraphics.FromPdfPage(page))
                {
                    graphics.DrawRectangle(XBrushes.Red, 50, 70, 30, 60);
                    graphics.DrawRectangle(XBrushes.Blue, 350, 480, 80, 20);
                }
                page.CropBox = new PdfRectangle(new XPoint(40, 60), new XPoint(440, 660));
                page.Rotate = nativeRotation;
                source.Save(sourcePath);
            }
            using var prepared = await new DocumentPreprocessor().PrepareAsync(sourcePath,
                new PrintJobSettings { PaperSize = "Letter", RotationDeg = 90 }, CancellationToken.None);
            using var result = PdfReader.Open(prepared.FilePath, PdfDocumentOpenMode.Import);
            var resources = result.Pages[0].Elements.GetDictionary("/Resources")!;
            var objects = resources.Elements.GetDictionary("/XObject")!;
            var imported = Assert.Single(objects.Elements.Values.OfType<PdfReference>());
            var form = Assert.IsAssignableFrom<PdfDictionary>(imported.Value);
            var box = form.Elements.GetRectangle("/BBox");
            Assert.Equal(40, box.X1);
            Assert.Equal(60, box.Y1);
            Assert.Equal(400, box.Width);
            Assert.Equal(600, box.Height);
            Assert.False(form.Elements.ContainsKey("/Matrix"), "Native rotation must not also be applied inside the imported form.");
            Assert.Equal(0, result.Pages[0].Rotate);
            using var original = PdfReader.Open(sourcePath, PdfDocumentOpenMode.Import);
            Assert.Equal(nativeRotation, original.Pages[0].Rotate);
            Assert.Equal(612, original.Pages[0].MediaBox.Width);
        }
        finally { File.Delete(sourcePath); }
    }
}
