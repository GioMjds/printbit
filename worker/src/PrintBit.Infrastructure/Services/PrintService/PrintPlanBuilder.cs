namespace PrintBit.Infrastructure.Services.PrintService;

public sealed record PrintPlan(
    IReadOnlyList<int> SelectedPages,
    int TotalSelectedPages,
    int Copies,
    string NormalizedRangeString
);

public static class PrintPlanBuilder
{
    public static PrintPlan Build(int pageCount, PrintJobSettings settings)
    {
        if (pageCount < 1)
        {
            throw new InvalidDataException("Document has no pages");
        }

        var copies = Math.Max(1, settings.Copies);

        // 1. Structured PageSelection
        if (settings.PageSelection != null &&
            !string.Equals(settings.PageSelection.Mode, "all", StringComparison.OrdinalIgnoreCase) &&
            settings.PageSelection.Ranges != null &&
            settings.PageSelection.Ranges.Count > 0)
        {
            return BuildFromRanges(pageCount, settings.PageSelection.Ranges, copies);
        }

        // 2. Legacy string PageRange
        if (!string.IsNullOrWhiteSpace(settings.PageRange))
        {
            return BuildFromString(pageCount, settings.PageRange, copies);
        }

        // 3. Default All Pages
        var allPages = Enumerable.Range(1, pageCount).ToArray();
        return new PrintPlan(allPages, pageCount, copies, pageCount == 1 ? "1" : $"1-{pageCount}");
    }

    private static PrintPlan BuildFromRanges(int pageCount, IEnumerable<PageRangeDto> ranges, int copies)
    {
        var selected = new SortedSet<int>();

        foreach (var r in ranges)
        {
            var start = r.Start;
            var end = r.End;

            if (start > end)
            {
                (start, end) = (end, start);
            }

            if (start < 1 || end > pageCount)
            {
                throw new InvalidDataException($"Page range {start}-{end} exceeds document bounds (1-{pageCount})");
            }

            for (var p = start; p <= end; p++)
            {
                selected.Add(p);
            }
        }

        if (selected.Count == 0)
        {
            throw new InvalidDataException("Page range selected no pages");
        }

        var pagesList = selected.ToArray();
        var rangeString = FormatPages(pagesList);
        return new PrintPlan(pagesList, pagesList.Length, copies, rangeString);
    }

    private static PrintPlan BuildFromString(int pageCount, string rawRange, int copies)
    {
        var selected = new SortedSet<int>();
        var chunks = rawRange.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

        foreach (var chunk in chunks)
        {
            var parts = chunk.Split('-', StringSplitOptions.TrimEntries);
            if (!int.TryParse(parts[0], out var start) || start < 1 || start > pageCount)
            {
                throw new InvalidDataException($"Invalid page {parts[0]} for document with {pageCount} pages");
            }

            var end = start;
            if (parts.Length == 2)
            {
                if (!int.TryParse(parts[1], out end) || end < start || end > pageCount)
                {
                    throw new InvalidDataException($"Invalid end page in chunk '{chunk}'");
                }
            }
            else if (parts.Length > 2)
            {
                throw new InvalidDataException($"Malformed page range chunk '{chunk}'");
            }

            for (var p = start; p <= end; p++)
            {
                selected.Add(p);
            }
        }

        if (selected.Count == 0)
        {
            throw new InvalidDataException("Page range selected no pages");
        }

        var pagesList = selected.ToArray();
        var rangeString = FormatPages(pagesList);
        return new PrintPlan(pagesList, pagesList.Length, copies, rangeString);
    }

    public static string FormatPages(IReadOnlyList<int> pages)
    {
        if (pages.Count == 0) return string.Empty;

        var ranges = new List<string>();
        var start = pages[0];
        var prev = pages[0];

        for (var i = 1; i < pages.Count; i++)
        {
            var curr = pages[i];
            if (curr == prev + 1)
            {
                prev = curr;
                continue;
            }

            ranges.Add(start == prev ? start.ToString() : $"{start}-{prev}");
            start = prev = curr;
        }

        ranges.Add(start == prev ? start.ToString() : $"{start}-{prev}");
        return string.Join(',', ranges);
    }
}
