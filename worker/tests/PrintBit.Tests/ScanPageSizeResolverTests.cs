using NAPS2.Images;
using PrintBit.Infrastructure.Windows.Scanning;
using Xunit;

namespace PrintBit.Tests;

public class ScanPageSizeResolverTests
{
    private static (decimal Width, decimal Height) Millimetres(PageSize size) =>
        size.Unit switch
        {
            PageSizeUnit.Millimetre => (size.Width, size.Height),
            PageSizeUnit.Inch => (size.Width * 25.4m, size.Height * 25.4m),
            PageSizeUnit.Centimetre => (size.Width * 10m, size.Height * 10m),
            _ => throw new InvalidOperationException($"Unexpected unit {size.Unit}")
        };

    [Theory]
    [InlineData("long")]
    [InlineData("Long")]
    [InlineData("legal")]
    [InlineData("folio")]
    public void LongOnTheGlass_IsClampedToTheGlassLength(string paperSize)
    {
        var resolved = ScanPageSizeResolver.Resolve(paperSize, isFeeder: false);

        Assert.True(resolved.ClampedToGlass);
        var (width, height) = Millimetres(resolved.PageSize!);
        Assert.Equal(216m, width);
        Assert.Equal(297m, height);
    }

    [Fact]
    public void LongInTheFeeder_KeepsTheFullLength()
    {
        var resolved = ScanPageSizeResolver.Resolve("long", isFeeder: true);

        Assert.False(resolved.ClampedToGlass);
        var (width, height) = Millimetres(resolved.PageSize!);
        Assert.Equal(216m, width);
        Assert.Equal(330m, height);
    }

    [Theory]
    [InlineData("a4", false)]
    [InlineData("a4", true)]
    [InlineData("short", false)]
    [InlineData("short", true)]
    [InlineData("letter", false)]
    [InlineData(null, false)]
    [InlineData("unknown", false)]
    public void SizesThatFitTheGlass_AreNotClamped(string? paperSize, bool isFeeder)
    {
        var resolved = ScanPageSizeResolver.Resolve(paperSize, isFeeder);

        Assert.False(resolved.ClampedToGlass);
        if (resolved.PageSize is { } size)
        {
            var (_, height) = Millimetres(size);
            if (!isFeeder) Assert.True(height <= 297.5m, $"{paperSize} is {height} mm long on the glass");
        }
    }

    [Fact]
    public void ShortOnTheGlass_KeepsItsExistingSize()
    {
        var resolved = ScanPageSizeResolver.Resolve("short", isFeeder: false);

        var (width, height) = Millimetres(resolved.PageSize!);
        Assert.Equal(216m, width);
        Assert.Equal(279m, height);
    }

    [Fact]
    public void UnknownSizeInTheFeeder_LeavesThePageSizeToTheDriver()
    {
        Assert.Null(ScanPageSizeResolver.Resolve(null, isFeeder: true).PageSize);
    }
}
