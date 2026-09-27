using System.Text.Json.Serialization;

namespace PrintBit.Infrastructure.Services.PrintService;

public sealed record PageRangeDto(
    [property: JsonPropertyName("start")] int Start,
    [property: JsonPropertyName("end")] int End
);

public sealed record PageSelectionDto(
    [property: JsonPropertyName("mode")] string Mode,
    [property: JsonPropertyName("ranges")] IReadOnlyList<PageRangeDto> Ranges
);

public class PrintJobSettings
{
    public int Copies { get; set; } = 1;
    public bool Color { get; set; } = false;
    public string Quality { get; set; } = "standard";
    public string? PageRange { get; set; }
    public PageSelectionDto? PageSelection { get; set; }
    public string? Orientation { get; set; }
    public int RotationDeg { get; set; }
    public string PaperSize { get; set; } = "A4";
    public string Scaling { get; set; } = "fit";
    public bool Duplex { get; set; }
}
