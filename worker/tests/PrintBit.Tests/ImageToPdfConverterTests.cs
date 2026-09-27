namespace PrintBit.Tests;

using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using PrintBit.Infrastructure.Services.DocumentConversion;
using PrintBit.Infrastructure.Services.PrintService;
using Xunit;

public class ImageToPdfConverterTests
{
    [Fact]
    public async Task ConvertAsync_PngImage_ProducesValidSinglePagePdf()
    {
        var tempPng = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.png");
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.pdf");

        try
        {
            // Valid 1x1 PNG base64
            var pngBytes = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
            await File.WriteAllBytesAsync(tempPng, pngBytes);

            var pageCount = await ImageToPdfConverter.ConvertAsync(tempPng, tempPdf);

            Assert.Equal(1, pageCount);
            Assert.True(File.Exists(tempPdf));
            Assert.True(new FileInfo(tempPdf).Length > 0);

            var counted = PdfPageCounter.Count(tempPdf);
            Assert.Equal(1, counted);
        }
        finally
        {
            if (File.Exists(tempPng)) File.Delete(tempPng);
            if (File.Exists(tempPdf)) File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task ConvertAsync_JpegImage_ProducesValidSinglePagePdf()
    {
        var tempJpg = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.jpg");
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.pdf");

        try
        {
            // Valid 1x1 JPEG base64
            var jpgBytes = Convert.FromBase64String("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=");
            await File.WriteAllBytesAsync(tempJpg, jpgBytes);

            var pageCount = await ImageToPdfConverter.ConvertAsync(tempJpg, tempPdf);

            Assert.Equal(1, pageCount);
            Assert.True(File.Exists(tempPdf));
            Assert.True(new FileInfo(tempPdf).Length > 0);

            var counted = PdfPageCounter.Count(tempPdf);
            Assert.Equal(1, counted);
        }
        finally
        {
            if (File.Exists(tempJpg)) File.Delete(tempJpg);
            if (File.Exists(tempPdf)) File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task ConvertAsync_BmpImage_ProducesValidSinglePagePdf()
    {
        var tempBmp = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.bmp");
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.pdf");

        try
        {
            // Valid 1x1 24bpp BMP base64
            var bmpBytes = Convert.FromBase64String("Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////AA==");
            await File.WriteAllBytesAsync(tempBmp, bmpBytes);

            var pageCount = await ImageToPdfConverter.ConvertAsync(tempBmp, tempPdf);

            Assert.Equal(1, pageCount);
            Assert.True(File.Exists(tempPdf));
            Assert.True(new FileInfo(tempPdf).Length > 0);

            var counted = PdfPageCounter.Count(tempPdf);
            Assert.Equal(1, counted);
        }
        finally
        {
            if (File.Exists(tempBmp)) File.Delete(tempBmp);
            if (File.Exists(tempPdf)) File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task ConvertAsync_GifImage_ProducesValidSinglePagePdf()
    {
        var tempGif = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.gif");
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.pdf");

        try
        {
            // Valid 1x1 GIF base64
            var gifBytes = Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
            await File.WriteAllBytesAsync(tempGif, gifBytes);

            var pageCount = await ImageToPdfConverter.ConvertAsync(tempGif, tempPdf);

            Assert.Equal(1, pageCount);
            Assert.True(File.Exists(tempPdf));
            Assert.True(new FileInfo(tempPdf).Length > 0);

            var counted = PdfPageCounter.Count(tempPdf);
            Assert.Equal(1, counted);
        }
        finally
        {
            if (File.Exists(tempGif)) File.Delete(tempGif);
            if (File.Exists(tempPdf)) File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task ConvertAsync_HighResImage_ProducesValidSinglePagePdf()
    {
        var tempPng = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.png");
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.pdf");

        try
        {
            using (var bmp = new Bitmap(1920, 1080))
            {
                using var g = Graphics.FromImage(bmp);
                g.Clear(Color.Blue);
                bmp.Save(tempPng, ImageFormat.Png);
            }

            var pageCount = await ImageToPdfConverter.ConvertAsync(tempPng, tempPdf);

            Assert.Equal(1, pageCount);
            Assert.True(File.Exists(tempPdf));
            Assert.True(new FileInfo(tempPdf).Length > 0);

            var counted = PdfPageCounter.Count(tempPdf);
            Assert.Equal(1, counted);
        }
        finally
        {
            if (File.Exists(tempPng)) File.Delete(tempPng);
            if (File.Exists(tempPdf)) File.Delete(tempPdf);
        }
    }

    [Fact]
    public async Task ConvertAsync_NonExistentFile_ThrowsFileNotFoundException()
    {
        var missing = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.png");
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.pdf");

        await Assert.ThrowsAsync<FileNotFoundException>(() =>
            ImageToPdfConverter.ConvertAsync(missing, tempPdf));
    }

    [Theory]
    [InlineData("", "test.pdf")]
    [InlineData("   ", "test.pdf")]
    [InlineData("test.png", "")]
    [InlineData("test.png", "   ")]
    public async Task ConvertAsync_NullOrEmptyArguments_ThrowsArgumentException(string input, string output)
    {
        await Assert.ThrowsAsync<ArgumentException>(() =>
            ImageToPdfConverter.ConvertAsync(input, output));
    }

    [Fact]
    public async Task ConvertAsync_CancellationToken_ThrowsWhenCancelled()
    {
        var tempPng = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.png");
        var tempPdf = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.pdf");

        try
        {
            var pngBytes = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
            await File.WriteAllBytesAsync(tempPng, pngBytes);

            using var cts = new CancellationTokenSource();
            cts.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                ImageToPdfConverter.ConvertAsync(tempPng, tempPdf, cts.Token));
        }
        finally
        {
            if (File.Exists(tempPng)) File.Delete(tempPng);
            if (File.Exists(tempPdf)) File.Delete(tempPdf);
        }
    }
}
