using System.Drawing;

namespace PrintBit.Infrastructure.Services.DocumentConversion;

/// <summary>
/// Applies the EXIF orientation tag to an image.
/// Phone cameras store portrait photos as landscape pixels plus an orientation tag.
/// Browsers honor the tag, GDI+ does not, so without this step a photo prints
/// sideways compared with the preview the customer saw.
/// </summary>
internal static class ExifOrientation
{
    /// <summary>EXIF tag 0x0112 (Orientation).</summary>
    internal const int OrientationTagId = 0x0112;

    /// <summary>
    /// Maps an EXIF orientation value (1 to 8) to the transform that makes the pixels upright.
    /// Unknown values map to no transform.
    /// </summary>
    internal static RotateFlipType ToRotateFlip(int orientation) => orientation switch
    {
        2 => RotateFlipType.RotateNoneFlipX,
        3 => RotateFlipType.Rotate180FlipNone,
        4 => RotateFlipType.Rotate180FlipX,
        5 => RotateFlipType.Rotate90FlipX,
        6 => RotateFlipType.Rotate90FlipNone,
        7 => RotateFlipType.Rotate270FlipX,
        8 => RotateFlipType.Rotate270FlipNone,
        _ => RotateFlipType.RotateNoneFlipNone
    };

    /// <summary>
    /// Rotates or flips the image in place according to its orientation tag, then removes
    /// the tag so the transform cannot be applied a second time.
    /// </summary>
    internal static void Apply(Image image)
    {
        ArgumentNullException.ThrowIfNull(image);

        if (Array.IndexOf(image.PropertyIdList, OrientationTagId) < 0)
        {
            return;
        }

        int orientation;
        try
        {
            var value = image.GetPropertyItem(OrientationTagId)?.Value;
            if (value is null || value.Length < 2)
            {
                return;
            }

            orientation = BitConverter.ToUInt16(value, 0);
        }
        catch (ArgumentException)
        {
            // Tag listed but unreadable: treat the image as already upright.
            return;
        }

        var transform = ToRotateFlip(orientation);
        if (transform != RotateFlipType.RotateNoneFlipNone)
        {
            image.RotateFlip(transform);
        }

        try
        {
            image.RemovePropertyItem(OrientationTagId);
        }
        catch (ArgumentException)
        {
            // Some decoders expose the tag read-only. The pixels are upright either way.
        }
    }
}
