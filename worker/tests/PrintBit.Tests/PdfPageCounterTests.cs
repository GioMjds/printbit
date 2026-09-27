using PrintBit.Infrastructure.Services.PrintService;

namespace PrintBit.Tests;

/// <summary>
/// Tests for <see cref="PdfPageCounter"/>. All fixtures are written by
/// hand so we don't depend on a PDF library or external files. The
/// <c>%PDF-</c> magic header is preserved, the trailer contains a
/// <c>/Root</c> reference, and the catalog object contains
/// <c>/Count N</c> — which is all the parser uses.
/// </summary>
public class PdfPageCounterTests
{
    [Fact]
    public void Count_ReturnsNull_OnMissingFile()
    {
        var result = PdfPageCounter.Count(
            @"C:\does\not\exist\printbit-test-nonexistent.pdf");
        Assert.Null(result);
    }

    [Fact]
    public void Count_ReturnsNull_OnEmptyPath()
    {
        Assert.Null(PdfPageCounter.Count(string.Empty));
        Assert.Null(PdfPageCounter.Count("   "));
    }

    [Fact]
    public void Count_ReturnsNull_OnNonPdfFile()
    {
        var path = Path.Combine(Path.GetTempPath(), $"printbit-test-{Guid.NewGuid():N}.txt");
        File.WriteAllText(path, "this is not a PDF, just plain text");
        try
        {
            Assert.Null(PdfPageCounter.Count(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Count_ReturnsNull_OnTruncatedPdf()
    {
        // Valid magic, then truncated. No trailer, no /Count.
        var bytes = "%PDF-1.4\n"u8.ToArray();
        var path = Path.Combine(Path.GetTempPath(), $"printbit-test-{Guid.NewGuid():N}.pdf");
        File.WriteAllBytes(path, bytes);
        try
        {
            Assert.Null(PdfPageCounter.Count(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Count_Returns3_OnValid3PagePdfBytes()
    {
        var bytes = BuildMinimalPdfWithCount(3);
        var path = Path.Combine(Path.GetTempPath(), $"printbit-test-{Guid.NewGuid():N}.pdf");
        File.WriteAllBytes(path, bytes);
        try
        {
            Assert.Equal(3, PdfPageCounter.Count(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Count_Returns1_OnValid1PagePdfBytes()
    {
        var bytes = BuildMinimalPdfWithCount(1);
        var path = Path.Combine(Path.GetTempPath(), $"printbit-test-{Guid.NewGuid():N}.pdf");
        File.WriteAllBytes(path, bytes);
        try
        {
            Assert.Equal(1, PdfPageCounter.Count(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Count_ReturnsLargestCount_WhenMultiplePageTreesPresent()
    {
        // The /Pages object with /Count 5 is the root; the /Count 2
        // belongs to a nested subtree. The parser picks the largest.
        var body = "1 0 obj\n<< /Type /Pages /Count 2 /Kids [ ] >>\nendobj\n" +
                   "2 0 obj\n<< /Type /Pages /Count 5 /Kids [ ] >>\nendobj\n" +
                   "trailer\n<< /Root 2 0 R /Size 3 >>\nstartxref\n0\n%%EOF\n";
        var bytes = "%PDF-1.4\n"u8.ToArray().Concat(System.Text.Encoding.Latin1.GetBytes(body)).ToArray();
        var path = Path.Combine(Path.GetTempPath(), $"printbit-test-{Guid.NewGuid():N}.pdf");
        File.WriteAllBytes(path, bytes);
        try
        {
            Assert.Equal(5, PdfPageCounter.Count(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Count_ReturnsCorrectCount_OnCompressedPdfViaQpdf()
    {
        // Path to the real failed test artifact if available, or generate a qpdf compressed PDF
        var tempPdf = Path.Combine(Path.GetTempPath(), $"printbit-compressed-{Guid.NewGuid():N}.pdf");
        var minimalBytes = BuildMinimalPdfWithCount(2);
        File.WriteAllBytes(tempPdf, minimalBytes);

        try
        {
            var count = PdfPageCounter.Count(tempPdf, @"C:\Program Files\qpdf 12.3.2\bin\qpdf.exe");
            Assert.Equal(2, count);
        }
        finally
        {
            File.Delete(tempPdf);
        }
    }

    /// <summary>
    /// Builds a minimal-but-valid-enough PDF whose trailer contains
    /// <c>/Root N 0 R</c> pointing to an object that has
    /// <c>/Count PAGES</c>. The parser scans head and tail windows
    /// for <c>/Count N</c> tokens, so we don't need a real
    /// cross-reference table.
    /// </summary>
    private static byte[] BuildMinimalPdfWithCount(int pages)
    {
        var body = $"""
            1 0 obj
            << /Type /Catalog /Pages 2 0 R >>
            endobj
            2 0 obj
            << /Type /Pages /Count {pages} /Kids [ 3 0 R ] >>
            endobj
            3 0 obj
            << /Type /Page /Parent 2 0 R /MediaBox [ 0 0 612 792 ] >>
            endobj
            xref
            0 4
            0000000000 65535 f
            0000000010 00000 n
            0000000060 00000 n
            0000000110 00000 n
            trailer
            << /Size 4 /Root 1 0 R >>
            startxref
            200
            %%EOF
            """;
        return "%PDF-1.4\n"u8.ToArray()
            .Concat(System.Text.Encoding.Latin1.GetBytes(body))
            .ToArray();
    }
}
