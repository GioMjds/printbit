using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using PrintBit.Infrastructure.Services.DocumentConversion;
using Xunit;

namespace PrintBit.Tests;

public class ExifOrientationTests
{
    private const int OrientationTagId = 0x0112;

    /// <summary>40x20 image: left half red, right half blue.</summary>
    private static Bitmap CreateLandscape(int? orientation)
    {
        var bitmap = new Bitmap(40, 20, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.Clear(Color.Blue);
            g.FillRectangle(Brushes.Red, 0, 0, 20, 20);
        }

        if (orientation is int value)
        {
            var item = (PropertyItem)RuntimeHelpers.GetUninitializedObject(typeof(PropertyItem));
            item.Id = OrientationTagId;
            item.Type = 3; // SHORT
            item.Len = 2;
            item.Value = BitConverter.GetBytes((ushort)value);
            bitmap.SetPropertyItem(item);
        }

        return bitmap;
    }

    private static bool IsRed(Color c) => c.R > 200 && c.B < 60;
    private static bool IsBlue(Color c) => c.B > 200 && c.R < 60;

    [Theory]
    [InlineData(1, RotateFlipType.RotateNoneFlipNone)]
    [InlineData(2, RotateFlipType.RotateNoneFlipX)]
    [InlineData(3, RotateFlipType.Rotate180FlipNone)]
    [InlineData(4, RotateFlipType.Rotate180FlipX)]
    [InlineData(5, RotateFlipType.Rotate90FlipX)]
    [InlineData(6, RotateFlipType.Rotate90FlipNone)]
    [InlineData(7, RotateFlipType.Rotate270FlipX)]
    [InlineData(8, RotateFlipType.Rotate270FlipNone)]
    [InlineData(0, RotateFlipType.RotateNoneFlipNone)]
    [InlineData(9, RotateFlipType.RotateNoneFlipNone)]
    public void ToRotateFlip_MapsExifOrientation(int orientation, RotateFlipType expected)
    {
        Assert.Equal(expected, ExifOrientation.ToRotateFlip(orientation));
    }

    [Fact]
    public void Apply_Orientation6_RotatesClockwiseSoLeftBecomesTop()
    {
        using var bitmap = CreateLandscape(6);

        ExifOrientation.Apply(bitmap);

        Assert.Equal(20, bitmap.Width);
        Assert.Equal(40, bitmap.Height);
        Assert.True(IsRed(bitmap.GetPixel(10, 5)), "top should be the original left (red)");
        Assert.True(IsBlue(bitmap.GetPixel(10, 35)), "bottom should be the original right (blue)");
        Assert.DoesNotContain(OrientationTagId, bitmap.PropertyIdList);
    }

    [Fact]
    public void Apply_Orientation8_RotatesCounterClockwiseSoLeftBecomesBottom()
    {
        using var bitmap = CreateLandscape(8);

        ExifOrientation.Apply(bitmap);

        Assert.Equal(20, bitmap.Width);
        Assert.Equal(40, bitmap.Height);
        Assert.True(IsBlue(bitmap.GetPixel(10, 5)));
        Assert.True(IsRed(bitmap.GetPixel(10, 35)));
    }

    [Fact]
    public void Apply_Orientation3_TurnsUpsideDown()
    {
        using var bitmap = CreateLandscape(3);

        ExifOrientation.Apply(bitmap);

        Assert.Equal(40, bitmap.Width);
        Assert.Equal(20, bitmap.Height);
        Assert.True(IsBlue(bitmap.GetPixel(5, 10)));
        Assert.True(IsRed(bitmap.GetPixel(35, 10)));
    }

    [Fact]
    public void Apply_NoOrientationTag_LeavesImageUnchanged()
    {
        using var bitmap = CreateLandscape(null);

        ExifOrientation.Apply(bitmap);

        Assert.Equal(40, bitmap.Width);
        Assert.Equal(20, bitmap.Height);
        Assert.True(IsRed(bitmap.GetPixel(5, 10)));
    }

    [Fact]
    public async Task ConvertAsync_PortraitPhoneJpeg_ProducesPortraitPage()
    {
        var dir = Path.Combine(Path.GetTempPath(), "printbit-exif-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var jpegPath = Path.Combine(dir, "phone.jpg");
            var pdfPath = Path.Combine(dir, "phone.pdf");
            using (var bitmap = CreateLandscape(6))
            {
                bitmap.Save(jpegPath, ImageFormat.Jpeg);
            }

            await ImageToPdfConverter.ConvertAsync(jpegPath, pdfPath);

            var pdfText = Encoding.Latin1.GetString(await File.ReadAllBytesAsync(pdfPath));
            var mediaBox = Regex.Match(pdfText, @"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]");
            Assert.True(mediaBox.Success);
            Assert.Equal("20.00", mediaBox.Groups[1].Value);
            Assert.Equal("40.00", mediaBox.Groups[2].Value);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
