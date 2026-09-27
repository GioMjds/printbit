using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text;

namespace PrintBit.Infrastructure.Services.DocumentConversion;

/// <summary>
/// Converts Windows GDI+-supported image files (.jpg, .jpeg, .png, .bmp, .gif) to a standard single-page PDF 1.4 document.
/// Performs proportional scaling within printable margins and generates self-contained PDF objects completely offline.
/// </summary>
public static class ImageToPdfConverter
{
    private const double PageWidth = 595.28;   // Standard A4 width in points (72 pt/inch)
    private const double PageHeight = 841.89;  // Standard A4 height in points (72 pt/inch)
    private const double Margin = 20.0;        // 20 pt safe margins

    /// <summary>
    /// Converts an image file to a single-page PDF document.
    /// </summary>
    /// <param name="imagePath">Path to the source image file.</param>
    /// <param name="outputPdfPath">Path to save the generated PDF file.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The number of pages in the generated PDF (always 1).</returns>
    public static async Task<int> ConvertAsync(
        string imagePath,
        string outputPdfPath,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(imagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPdfPath);

        if (!File.Exists(imagePath))
        {
            throw new FileNotFoundException($"Image file not found: {imagePath}", imagePath);
        }

        cancellationToken.ThrowIfCancellationRequested();

        // 1. Load image and obtain JPEG encoded bytes + dimensions
        var (jpegBytes, imgWidth, imgHeight) = await Task.Run(() => LoadImageAsJpeg(imagePath), cancellationToken);

        cancellationToken.ThrowIfCancellationRequested();

        // 2. Build the PDF document in memory
        var pdfBytes = BuildPdf(jpegBytes, imgWidth, imgHeight);

        cancellationToken.ThrowIfCancellationRequested();

        // 3. Ensure target directory exists and write output file
        var outputDir = Path.GetDirectoryName(outputPdfPath);
        if (!string.IsNullOrEmpty(outputDir) && !Directory.Exists(outputDir))
        {
            Directory.CreateDirectory(outputDir);
        }

        await File.WriteAllBytesAsync(outputPdfPath, pdfBytes, cancellationToken);

        return 1;
    }

    private static (byte[] JpegBytes, int Width, int Height) LoadImageAsJpeg(string imagePath)
    {
        using var stream = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var srcImage = Image.FromStream(stream, useEmbeddedColorManagement: true, validateImageData: true);
        return ConvertToJpeg(srcImage);
    }

    private static (byte[] JpegBytes, int Width, int Height) ConvertToJpeg(Image srcImage)
    {
        int width = srcImage.Width;
        int height = srcImage.Height;

        if (width <= 0 || height <= 0)
        {
            throw new InvalidDataException("Image has invalid dimensions.");
        }

        using var rgbBitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(rgbBitmap))
        {
            g.Clear(Color.White);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(srcImage, new Rectangle(0, 0, width, height));
        }

        using var ms = new MemoryStream();
        var encoder = GetJpegEncoder();
        using var encoderParams = new EncoderParameters(1);
        encoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 95L);

        if (encoder != null)
        {
            rgbBitmap.Save(ms, encoder, encoderParams);
        }
        else
        {
            rgbBitmap.Save(ms, ImageFormat.Jpeg);
        }

        return (ms.ToArray(), width, height);
    }

    private static ImageCodecInfo? GetJpegEncoder()
    {
        return ImageCodecInfo.GetImageEncoders()
            .FirstOrDefault(e => e.FormatID == ImageFormat.Jpeg.Guid);
    }

    private static byte[] BuildPdf(byte[] jpegBytes, int imgWidth, int imgHeight)
    {
        // Calculate scaling to fit proportionally inside printable area
        double maxW = PageWidth - 2.0 * Margin;
        double maxH = PageHeight - 2.0 * Margin;
        double scale = Math.Min(maxW / imgWidth, maxH / imgHeight);

        double drawW = imgWidth * scale;
        double drawH = imgHeight * scale;
        double posX = (PageWidth - drawW) / 2.0;
        double posY = (PageHeight - drawH) / 2.0;

        var culture = CultureInfo.InvariantCulture;
        string contentStream = string.Format(
            culture,
            "q {0:F2} 0 0 {1:F2} {2:F2} {3:F2} cm\n/Im1 Do\nQ\n",
            drawW,
            drawH,
            posX,
            posY);
        byte[] contentBytes = Encoding.ASCII.GetBytes(contentStream);

        using var ms = new MemoryStream();
        using var writer = new BinaryWriter(ms, Encoding.ASCII, leaveOpen: true);

        // PDF Header
        writer.Write(Encoding.ASCII.GetBytes("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));

        var objectOffsets = new long[6]; // 1-based indexing for objects 1..5

        // Object 1: Catalog
        objectOffsets[1] = ms.Position;
        writer.Write(Encoding.ASCII.GetBytes(
            "1 0 obj\n" +
            "<<\n" +
            "  /Type /Catalog\n" +
            "  /Pages 2 0 R\n" +
            ">>\n" +
            "endobj\n"));

        // Object 2: Pages
        objectOffsets[2] = ms.Position;
        writer.Write(Encoding.ASCII.GetBytes(
            "2 0 obj\n" +
            "<<\n" +
            "  /Type /Pages\n" +
            "  /Kids [3 0 R]\n" +
            "  /Count 1\n" +
            ">>\n" +
            "endobj\n"));

        // Object 3: Page
        objectOffsets[3] = ms.Position;
        string pageObj = string.Format(
            culture,
            "3 0 obj\n" +
            "<<\n" +
            "  /Type /Page\n" +
            "  /Parent 2 0 R\n" +
            "  /MediaBox [0 0 {0:F2} {1:F2}]\n" +
            "  /Contents 4 0 R\n" +
            "  /Resources <<\n" +
            "    /XObject <<\n" +
            "      /Im1 5 0 R\n" +
            "    >>\n" +
            "  >>\n" +
            ">>\n" +
            "endobj\n",
            PageWidth,
            PageHeight);
        writer.Write(Encoding.ASCII.GetBytes(pageObj));

        // Object 4: Contents
        objectOffsets[4] = ms.Position;
        string contentObjHead = string.Format(
            culture,
            "4 0 obj\n" +
            "<<\n" +
            "  /Length {0}\n" +
            ">>\n" +
            "stream\n",
            contentBytes.Length);
        writer.Write(Encoding.ASCII.GetBytes(contentObjHead));
        writer.Write(contentBytes);
        writer.Write(Encoding.ASCII.GetBytes("endstream\nendobj\n"));

        // Object 5: Image XObject
        objectOffsets[5] = ms.Position;
        string imageObjHead = string.Format(
            culture,
            "5 0 obj\n" +
            "<<\n" +
            "  /Type /XObject\n" +
            "  /Subtype /Image\n" +
            "  /Width {0}\n" +
            "  /Height {1}\n" +
            "  /ColorSpace /DeviceRGB\n" +
            "  /BitsPerComponent 8\n" +
            "  /Filter /DCTDecode\n" +
            "  /Length {2}\n" +
            ">>\n" +
            "stream\n",
            imgWidth,
            imgHeight,
            jpegBytes.Length);
        writer.Write(Encoding.ASCII.GetBytes(imageObjHead));
        writer.Write(jpegBytes);
        writer.Write(Encoding.ASCII.GetBytes("\nendstream\nendobj\n"));

        // xref table
        long startXref = ms.Position;
        writer.Write(Encoding.ASCII.GetBytes("xref\n0 6\n"));
        writer.Write(Encoding.ASCII.GetBytes("0000000000 65535 f\r\n"));
        for (int i = 1; i <= 5; i++)
        {
            string entry = string.Format(culture, "{0:D10} 00000 n\r\n", objectOffsets[i]);
            writer.Write(Encoding.ASCII.GetBytes(entry));
        }

        // Trailer
        writer.Write(Encoding.ASCII.GetBytes(
            "trailer\n" +
            "<<\n" +
            "  /Size 6\n" +
            "  /Root 1 0 R\n" +
            ">>\n" +
            "startxref\n" +
            $"{startXref}\n" +
            "%%EOF\n"));

        writer.Flush();
        return ms.ToArray();
    }
}
