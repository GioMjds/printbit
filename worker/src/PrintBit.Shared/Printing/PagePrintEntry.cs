using System;

namespace PrintBit.Shared.Printing;

public class PagePrintEntry
{
    public int PageNumber { get; init; }
    public int CopyNumber { get; init; }
    public int SequenceIndex { get; init; }
    public PagePrintState State { get; set; }
    public string? ErrorMessage { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
}
