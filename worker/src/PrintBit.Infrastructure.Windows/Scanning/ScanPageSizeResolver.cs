using NAPS2.Images;

namespace PrintBit.Infrastructure.Windows.Scanning;

/// <summary>
/// Maps a requested paper size to the scan area. The EPSON L5290 glass is
/// 216 x 297 mm, so a longer sheet (Long bond, 216 x 330 mm) can only be
/// scanned in full through the feeder. On the glass the area is clamped to the
/// glass length instead of asking the driver for an area it does not have.
/// </summary>
public static class ScanPageSizeResolver
{
    public const decimal GlassWidthMm = 216m;
    public const decimal GlassMaxLengthMm = 297m;
    private const decimal LongLengthMm = 330m;

    public readonly record struct Resolution(PageSize? PageSize, bool ClampedToGlass);

    public static Resolution Resolve(string? paperSize, bool isFeeder)
    {
        switch (paperSize?.Trim().ToLowerInvariant())
        {
            case "a4":
                return new Resolution(PageSize.A4, false);
            case "letter" or "short":
                return new Resolution(
                    isFeeder ? PageSize.Letter : new PageSize(GlassWidthMm, 279m, PageSizeUnit.Millimetre),
                    false);
            case "legal" or "folio" or "long":
                return isFeeder
                    ? new Resolution(new PageSize(GlassWidthMm, LongLengthMm, PageSizeUnit.Millimetre), false)
                    : new Resolution(new PageSize(GlassWidthMm, GlassMaxLengthMm, PageSizeUnit.Millimetre), true);
            default:
                return new Resolution(
                    isFeeder ? null : new PageSize(GlassWidthMm, GlassMaxLengthMm, PageSizeUnit.Millimetre),
                    false);
        }
    }
}
