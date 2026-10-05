using System.Drawing.Printing;
using PrintBit.Infrastructure.Services.DocumentProcessing;
using PrintBit.Infrastructure.Services.PrintService;
using Xunit;

namespace PrintBit.Tests;

public class PaperConfigurationTests
{
    [Theory]
    [InlineData("Short", 612d, 792d)]
    [InlineData("short", 612d, 792d)]
    [InlineData("Letter", 612d, 792d)]
    [InlineData("letter", 612d, 792d)]
    [InlineData("Long", 612d, 936d)]
    [InlineData("long", 612d, 936d)]
    [InlineData("Folio", 612d, 936d)]
    [InlineData("folio", 612d, 936d)]
    [InlineData("Legal", 612d, 936d)]
    [InlineData("legal", 612d, 936d)]
    [InlineData("A4", 595.28d, 841.89d)]
    [InlineData("a4", 595.28d, 841.89d)]
    public void PaperGeometry_ResolvesExpectedDimensions(string paperSize, double expectedWidth, double expectedHeight)
    {
        var (width, height) = PrintLayout.PaperGeometry(paperSize, "portrait");
        Assert.Equal(expectedWidth, width, 2);
        Assert.Equal(expectedHeight, height, 2);
    }

    [Fact]
    public void Calculate_LetterSourceWithShortPaper_DoesNotScaleOrChangeDimensions()
    {
        var settings = new PrintJobSettings
        {
            PaperSize = "Short",
            Orientation = "portrait",
            Scaling = "fit"
        };

        var layout = PrintLayout.Calculate(612d, 792d, settings, 0);

        Assert.Equal(612d, layout.Width, 2);
        Assert.Equal(792d, layout.Height, 2);
        Assert.Equal(1.0d, layout.Scale, 4);
    }

    [Theory]
    [InlineData("Short", "paper=letter")]
    [InlineData("short", "paper=letter")]
    [InlineData("Letter", "paper=letter")]
    [InlineData("Long", "paperkind=14")]
    [InlineData("long", "paperkind=14")]
    [InlineData("Folio", "paperkind=14")]
    [InlineData("Legal", "paperkind=14")]
    [InlineData("A4", "paper=A4")]
    public void NormalizePaperSetting_MapsPhilippineAndStandardPaperSizes(string paperSize, string expectedSetting)
    {
        var result = DocumentPrinter.NormalizePaperSetting(paperSize);
        Assert.Equal(expectedSetting, result);
    }

    [Theory]
    [InlineData("Short", PaperKind.Letter)]
    [InlineData("short", PaperKind.Letter)]
    [InlineData("Letter", PaperKind.Letter)]
    [InlineData("Long", PaperKind.Folio)]
    [InlineData("long", PaperKind.Folio)]
    [InlineData("Folio", PaperKind.Folio)]
    [InlineData("Legal", PaperKind.Folio)]
    [InlineData("A4", PaperKind.A4)]
    public void MapPaperKind_MapsPhilippineAndStandardPaperSizes(string paperSize, PaperKind expectedKind)
    {
        var result = NativePdfPrinter.MapPaperKind(paperSize);
        Assert.Equal(expectedKind, result);
    }
}
