using PrintBit.Infrastructure.Services.PrintService;

namespace PrintBit.Infrastructure.Services.DocumentProcessing;

/// <summary>PDF-point layout contract shared with Node's print-configuration.ts.</summary>
internal readonly record struct PrintLayout(double Width, double Height, double Scale)
{
    public const double MarginPoints = 14.4;

    public static (double Width, double Height) PaperGeometry(string? paperSize, string? orientation)
    {
        var (width, height) = paperSize?.Trim().ToUpperInvariant() switch
        {
            "LETTER" => (612d, 792d),
            "LEGAL" or "FOLIO" => (612d, 936d),
            _ => (595.28d, 841.89d)
        };
        return string.Equals(orientation?.Trim(), "landscape", StringComparison.OrdinalIgnoreCase)
            ? (height, width) : (width, height);
    }

    public static PrintLayout Calculate(double sourceWidth, double sourceHeight, PrintJobSettings settings, int rotation)
    {
        if (!double.IsFinite(sourceWidth) || !double.IsFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0)
            throw new InvalidDataException("Invalid source page dimensions");
        var (width, height) = PaperGeometry(settings.PaperSize, settings.Orientation);
        var quarterTurn = rotation is 90 or 270;
        var contentWidth = quarterTurn ? sourceHeight : sourceWidth;
        var contentHeight = quarterTurn ? sourceWidth : sourceHeight;
        var scale = string.Equals(settings.Scaling, "actual", StringComparison.OrdinalIgnoreCase) ? 1 : Math.Min(
            (width - 2 * MarginPoints) / contentWidth,
            (height - 2 * MarginPoints) / contentHeight);
        return new(width, height, scale);
    }
}
