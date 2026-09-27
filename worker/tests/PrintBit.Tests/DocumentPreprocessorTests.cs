using PdfSharp.Pdf;
using PdfSharp.Pdf.IO;
using PrintBit.Infrastructure.Services.DocumentProcessing;
using PrintBit.Infrastructure.Services.PrintService;

namespace PrintBit.Tests;

public sealed class DocumentPreprocessorTests
{
    [Fact]
    public async Task PrepareAsync_SelectsRotatesOrientsAndPadsPdf()
    {
        var sourcePath = Path.Combine(Path.GetTempPath(), $"source-{Guid.NewGuid():N}.pdf");
        using (var source = new PdfDocument())
        {
            source.AddPage();
            source.AddPage();
            source.AddPage();
            source.Save(sourcePath);
        }

        string? preparedPath = null;
        try
        {
            var sut = new DocumentPreprocessor();
            using (var prepared = await sut.PrepareAsync(
                sourcePath,
                new PrintJobSettings
                {
                    PageRange = "2-3",
                    RotationDeg = 90,
                    Orientation = "landscape",
                    Duplex = true
                },
                CancellationToken.None))
            {
                preparedPath = prepared.FilePath;
                Assert.Equal(2, prepared.PageCount);
                using var result = PdfReader.Open(prepared.FilePath, PdfDocumentOpenMode.Import);
                Assert.Equal(2, result.PageCount);
                Assert.All(result.Pages.Cast<PdfPage>(), page =>
                {
                    var rotatedWidth = page.Rotate % 180 == 0
                        ? page.Width.Point
                        : page.Height.Point;
                    var rotatedHeight = page.Rotate % 180 == 0
                        ? page.Height.Point
                        : page.Width.Point;
                    Assert.True(rotatedWidth > rotatedHeight);
                });
            }

            Assert.False(File.Exists(preparedPath));
        }
        finally
        {
            File.Delete(sourcePath);
            if (preparedPath is not null) File.Delete(preparedPath);
        }
    }

    [Fact]
    public async Task PrepareAsync_LandscapeLegalPdf_ProducesExactDimensions()
    {
        var sourcePath = Path.Combine(Path.GetTempPath(), $"source-{Guid.NewGuid():N}.pdf");
        using (var source = new PdfDocument())
        {
            var p = source.AddPage();
            p.Width = PdfSharp.Drawing.XUnit.FromPoint(288);
            p.Height = PdfSharp.Drawing.XUnit.FromPoint(432);
            source.Save(sourcePath);
        }

        string? preparedPath = null;
        try
        {
            var sut = new DocumentPreprocessor();
            using var prepared = await sut.PrepareAsync(
                sourcePath,
                new PrintJobSettings
                {
                    Orientation = "landscape",
                    PaperSize = "Legal",
                    RotationDeg = 0
                },
                CancellationToken.None);

            preparedPath = prepared.FilePath;
            Assert.Equal(1, prepared.PageCount);
            using var result = PdfReader.Open(prepared.FilePath, PdfDocumentOpenMode.Import);
            Assert.Equal(1, result.PageCount);
            Assert.Equal(936, result.Pages[0].Width.Point);
            Assert.Equal(612, result.Pages[0].Height.Point);
            Assert.Equal(0, result.Pages[0].Rotate);
        }
        finally
        {
            File.Delete(sourcePath);
            if (preparedPath is not null && File.Exists(preparedPath)) File.Delete(preparedPath);
        }
    }

    [Fact]
    public async Task PrepareAsync_PortraitLegalPdf_ProducesExactDimensions()
    {
        var sourcePath = Path.Combine(Path.GetTempPath(), $"source-{Guid.NewGuid():N}.pdf");
        using (var source = new PdfDocument())
        {
            var p = source.AddPage();
            p.Width = PdfSharp.Drawing.XUnit.FromPoint(288);
            p.Height = PdfSharp.Drawing.XUnit.FromPoint(432);
            source.Save(sourcePath);
        }

        string? preparedPath = null;
        try
        {
            var sut = new DocumentPreprocessor();
            using var prepared = await sut.PrepareAsync(
                sourcePath,
                new PrintJobSettings
                {
                    Orientation = "portrait",
                    PaperSize = "Legal",
                    RotationDeg = 0
                },
                CancellationToken.None);

            preparedPath = prepared.FilePath;
            Assert.Equal(1, prepared.PageCount);
            using var result = PdfReader.Open(prepared.FilePath, PdfDocumentOpenMode.Import);
            Assert.Equal(1, result.PageCount);
            Assert.Equal(612, result.Pages[0].Width.Point);
            Assert.Equal(936, result.Pages[0].Height.Point);
            Assert.Equal(0, result.Pages[0].Rotate);
        }
        finally
        {
            File.Delete(sourcePath);
            if (preparedPath is not null && File.Exists(preparedPath)) File.Delete(preparedPath);
        }
    }

    [Fact]
    public async Task PrepareAsync_OddDuplexSelection_AppendsMatchingBlankPage()
    {
        var sourcePath = Path.Combine(Path.GetTempPath(), $"source-{Guid.NewGuid():N}.pdf");
        using (var source = new PdfDocument())
        {
            source.AddPage();
            source.Save(sourcePath);
        }

        try
        {
            var sut = new DocumentPreprocessor();
            using var prepared = await sut.PrepareAsync(
                sourcePath,
                new PrintJobSettings { Orientation = "portrait", Duplex = true },
                CancellationToken.None);
            Assert.Equal(2, prepared.PageCount);
            using var result = PdfReader.Open(prepared.FilePath, PdfDocumentOpenMode.Import);
            Assert.Equal(result.Pages[0].Width.Point, result.Pages[1].Width.Point);
            Assert.Equal(result.Pages[0].Height.Point, result.Pages[1].Height.Point);
            Assert.Equal(result.Pages[0].Rotate, result.Pages[1].Rotate);
        }
        finally
        {
            File.Delete(sourcePath);
        }
    }
}
