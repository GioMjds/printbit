using PrintBit.Shared.Configurations;

namespace PrintBit.Infrastructure.Services.PrintService;

internal static class PrinterProfileResolver
{
    public static string Resolve(HardwareSettings settings, string? quality) =>
        Resolve(settings, quality, null);

    public static string Resolve(HardwareSettings settings, string? quality, string? orientation)
    {
        ArgumentNullException.ThrowIfNull(settings);

        var isLandscape = string.Equals(orientation?.Trim(), "landscape", StringComparison.OrdinalIgnoreCase);

        if (string.Equals(quality, "standard", StringComparison.OrdinalIgnoreCase))
        {
            if (isLandscape && !string.IsNullOrWhiteSpace(settings.PrinterProfiles.StandardLandscape))
            {
                return settings.PrinterProfiles.StandardLandscape;
            }

            return string.IsNullOrWhiteSpace(settings.PrinterProfiles.Standard)
                ? settings.PrinterName
                : settings.PrinterProfiles.Standard;
        }

        if (string.Equals(quality, "high", StringComparison.OrdinalIgnoreCase))
        {
            if (isLandscape && !string.IsNullOrWhiteSpace(settings.PrinterProfiles.HighLandscape))
            {
                return settings.PrinterProfiles.HighLandscape;
            }

            if (isLandscape && !string.IsNullOrWhiteSpace(settings.PrinterProfiles.StandardLandscape))
            {
                return settings.PrinterProfiles.StandardLandscape;
            }

            if (string.IsNullOrWhiteSpace(settings.PrinterProfiles.High))
            {
                throw new InvalidOperationException(
                    "High-quality printer profile is not configured.");
            }

            return settings.PrinterProfiles.High;
        }

        throw new ArgumentException(
            $"Unsupported print quality '{quality}'.",
            nameof(quality));
    }
}
