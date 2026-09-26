# Custom Range Optimization & Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform custom page ranges into a first-class structured domain model across PrintBit's kiosk UI (`src/public/config`), Node.js backend pricing and queue orchestration, and C# Worker Service (`printbit-worker`).

**Architecture:** Touchscreen-friendly range row builder with live feedback and automatic overlap merging in the kiosk UI; canonical `PageRange` and `PageSelection` normalization in Node.js; dual-support JSON sidecar contract (`schemaVersion: 3`); and a dedicated `PrintPlanBuilder` in C# validating and slicing exact pages.

**Tech Stack:** TypeScript, Node.js (Express, Jest), C# (.NET 10, xUnit, PDFsharp, SumatraPDF), HTML5/CSS3.

**Spec:** [docs/superpowers/specs/2026-09-26-custom-range-enhancement-design.md](file:///D:/giomj/Projects/printbit/docs/superpowers/specs/2026-09-26-custom-range-enhancement-design.md)

## Global Constraints

- Dual-support sidecar contract: always include both `pageSelection` object and `pageRange` legacy string for backward compatibility.
- Zero external UI dependencies for the range builder: vanilla TypeScript, accessible HTML/CSS, minimum 44px touch targets.
- Fail-fast boundary checks: any range index $< 1$ or $> \text{documentPageCount}$ must be rejected or clamped before spooling.
- Automatic overlap/adjacent merging: ranges like `1-5` and `4-9` must automatically merge into `1-9` to eliminate duplicate billing and misprints.

---

### Task 1: Canonical Page Selection Types & Normalization Engine (Node.js)

**Files:**

- Create: `src/shared/page-selection.ts`
- Test: `tests/shared/page-selection.spec.ts`

**Interfaces:**

- Consumes: None (root domain contract)
- Produces:
  - `export interface PageRange { start: number; end: number; }`
  - `export type PageSelectionMode = 'all' | 'custom' | 'single';`
  - `export interface PageSelection { mode: PageSelectionMode; ranges: PageRange[]; }`
  - `export function normalizePageSelection(raw: unknown, totalPages: number): NormalizedPageSelectionResult`
  - `export function formatPageRangeString(ranges: PageRange[]): string`
  - `export function parsePageRangeString(raw: string, totalPages: number): PageRange[]`

* [ ] **Step 1: Write the failing test**

Create `tests/shared/page-selection.spec.ts`:

```typescript
import {
  normalizePageSelection,
  formatPageRangeString,
  parsePageRangeString,
  type PageRange,
  type PageSelection,
} from '../../src/shared/page-selection';

describe('Page Selection & Range Normalization', () => {
  it('normalizes disjoint sorted ranges correctly', () => {
    const raw: PageSelection = {
      mode: 'custom',
      ranges: [
        { start: 1, end: 5 },
        { start: 7, end: 9 },
        { start: 15, end: 15 },
        { start: 22, end: 25 },
      ],
    };
    const result = normalizePageSelection(raw, 30);
    expect(result.ranges).toEqual([
      { start: 1, end: 5 },
      { start: 7, end: 9 },
      { start: 15, end: 15 },
      { start: 22, end: 25 },
    ]);
    expect(result.totalSelectedPages).toBe(14);
    expect(result.canonicalString).toBe('1-5, 7-9, 15, 22-25');
  });

  it('automatically merges overlapping ranges', () => {
    const raw: PageSelection = {
      mode: 'custom',
      ranges: [
        { start: 1, end: 5 },
        { start: 4, end: 9 },
      ],
    };
    const result = normalizePageSelection(raw, 30);
    expect(result.ranges).toEqual([{ start: 1, end: 9 }]);
    expect(result.totalSelectedPages).toBe(9);
    expect(result.hasOverlapsMerged).toBe(true);
    expect(result.canonicalString).toBe('1-9');
  });

  it('automatically merges adjacent contiguous ranges', () => {
    const raw: PageSelection = {
      mode: 'custom',
      ranges: [
        { start: 1, end: 5 },
        { start: 6, end: 9 },
      ],
    };
    const result = normalizePageSelection(raw, 30);
    expect(result.ranges).toEqual([{ start: 1, end: 9 }]);
    expect(result.totalSelectedPages).toBe(9);
  });

  it('handles inverted ranges (e.g. 8-4 -> 4-8)', () => {
    const raw: PageSelection = {
      mode: 'custom',
      ranges: [{ start: 8, end: 4 }],
    };
    const result = normalizePageSelection(raw, 30);
    expect(result.ranges).toEqual([{ start: 4, end: 8 }]);
    expect(result.totalSelectedPages).toBe(5);
  });

  it('clamps out-of-bounds endpoints to document length', () => {
    const raw: PageSelection = {
      mode: 'custom',
      ranges: [{ start: 0, end: 35 }],
    };
    const result = normalizePageSelection(raw, 30);
    expect(result.ranges).toEqual([{ start: 1, end: 30 }]);
    expect(result.totalSelectedPages).toBe(30);
  });

  it('parses legacy string format correctly', () => {
    const parsed = parsePageRangeString('1-5, 7-9, 15, 22-25', 30);
    expect(parsed).toEqual([
      { start: 1, end: 5 },
      { start: 7, end: 9 },
      { start: 15, end: 15 },
      { start: 22, end: 25 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/shared/page-selection.spec.ts`
Expected: FAIL (Cannot find module `../../src/shared/page-selection`)

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/page-selection.ts`:

```typescript
export interface PageRange {
  start: number;
  end: number;
}

export type PageSelectionMode = 'all' | 'custom' | 'single';

export interface PageSelection {
  mode: PageSelectionMode;
  ranges: PageRange[];
}

export interface NormalizedPageSelectionResult {
  mode: PageSelectionMode;
  ranges: PageRange[];
  totalSelectedPages: number;
  canonicalString: string;
  hasOverlapsMerged: boolean;
  warnings?: string[];
}

export function formatPageRangeString(ranges: PageRange[]): string {
  if (ranges.length === 0) return '';
  return ranges
    .map((r) => (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`))
    .join(', ');
}

export function parsePageRangeString(
  raw: string,
  totalPages: number,
): PageRange[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const max = Math.max(1, totalPages);
  const chunks = trimmed.split(',');
  const parsed: PageRange[] = [];

  for (const chunk of chunks) {
    const part = chunk.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [sStr, eStr] = part.split('-');
      const s = parseInt(sStr.trim(), 10);
      const e = parseInt(eStr.trim(), 10);
      if (Number.isFinite(s) && Number.isFinite(e)) {
        const start = Math.max(1, Math.min(max, Math.min(s, e)));
        const end = Math.max(1, Math.min(max, Math.max(s, e)));
        parsed.push({ start, end });
      }
    } else {
      const p = parseInt(part, 10);
      if (Number.isFinite(p)) {
        const clamped = Math.max(1, Math.min(max, p));
        parsed.push({ start: clamped, end: clamped });
      }
    }
  }

  return parsed;
}

export function normalizePageSelection(
  raw: unknown,
  totalPages: number,
): NormalizedPageSelectionResult {
  const maxPages = Math.max(1, totalPages);

  if (!raw || typeof raw !== 'object') {
    return {
      mode: 'all',
      ranges: [{ start: 1, end: maxPages }],
      totalSelectedPages: maxPages,
      canonicalString: `1-${maxPages}`,
      hasOverlapsMerged: false,
    };
  }

  const selection = raw as Partial<PageSelection>;
  const mode: PageSelectionMode =
    selection.mode === 'custom' || selection.mode === 'single'
      ? selection.mode
      : 'all';

  if (mode === 'all') {
    return {
      mode: 'all',
      ranges: [{ start: 1, end: maxPages }],
      totalSelectedPages: maxPages,
      canonicalString: `1-${maxPages}`,
      hasOverlapsMerged: false,
    };
  }

  let inputRanges: PageRange[] = [];
  if (Array.isArray(selection.ranges)) {
    inputRanges = selection.ranges
      .filter(
        (r): r is PageRange =>
          r && typeof r.start === 'number' && typeof r.end === 'number',
      )
      .map((r) => ({
        start: Math.max(1, Math.min(maxPages, Math.min(r.start, r.end))),
        end: Math.max(1, Math.min(maxPages, Math.max(r.start, r.end))),
      }));
  }

  if (inputRanges.length === 0) {
    return {
      mode,
      ranges: [{ start: 1, end: maxPages }],
      totalSelectedPages: maxPages,
      canonicalString: `1-${maxPages}`,
      hasOverlapsMerged: false,
    };
  }

  inputRanges.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: PageRange[] = [];
  let overlapsMerged = false;

  for (const range of inputRanges) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ ...range });
      continue;
    }

    if (range.start <= prev.end + 1) {
      overlapsMerged = true;
      prev.end = Math.max(prev.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  let totalSelected = 0;
  for (const r of merged) {
    totalSelected += r.end - r.start + 1;
  }

  return {
    mode,
    ranges: merged,
    totalSelectedPages: totalSelected,
    canonicalString: formatPageRangeString(merged),
    hasOverlapsMerged: overlapsMerged,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/shared/page-selection.spec.ts`
Expected: PASS (6 tests passed)

- [ ] **Step 5: Commit**

```bash
git add src/shared/page-selection.ts tests/shared/page-selection.spec.ts
git commit -m "feat(domain): add canonical PageSelection contracts and normalizer"
```

---

### Task 2: Pricing & Queue Worker Handoff Integration (Node.js)

**Files:**

- Modify: `src/services/print-quote.ts`
- Modify: `src/services/worker-handoff.ts`
- Modify: `src/modules/print-queue/print-job.schema.ts`
- Modify: `src/modules/print-queue/print-queue.orchestration.ts`
- Test: `tests/services/print-quote-multirange.spec.ts`

**Interfaces:**

- Consumes: `normalizePageSelection`, `PageSelection` from `src/shared/page-selection.ts`
- Produces:
  - `parsePageRange` in `src/services/print-quote.ts` handles structured `PageSelection` payloads.
  - `handoffToWorker` includes `pageSelection` and `schemaVersion: 3` alongside legacy `pageRange`.

* [ ] **Step 1: Write the failing test**

Create `tests/services/print-quote-multirange.spec.ts`:

```typescript
import { calculatePrintQuote } from '../../src/services/print-quote';
import type { DocumentAnalysis } from '../../src/services/session';

describe('Multi-range Print Quote Calculation', () => {
  const sampleAnalysis: DocumentAnalysis = {
    pageCount: 30,
    totalPages: 30,
    colorMode: 'grayscale',
    colorPages: 0,
    bwPages: 30,
    pages: Array.from({ length: 30 }, (_, i) => ({
      pageNumber: i + 1,
      isColor: false,
      colorPixelCount: 0,
      totalPixelCount: 1000,
      coverage: 0.05,
      coverageTier: 'low',
      hasGraphics: false,
    })),
  };

  it('calculates billable pages and sheets for multi-range selection', async () => {
    const quoteComputation = await calculatePrintQuote({
      analysis: sampleAnalysis,
      options: {
        copies: 1,
        colorMode: 'grayscale',
        quality: 'standard',
        paperSize: 'A4',
        duplex: false,
        pageRange: {
          mode: 'custom',
          ranges: [
            { start: 1, end: 5 },
            { start: 7, end: 9 },
          ],
        },
      },
    });

    expect(quoteComputation.ok).toBe(true);
    if (!quoteComputation.ok) return;
    expect(quoteComputation.quote.selectedPages).toBe(8);
    expect(quoteComputation.quote.totalPages).toBe(30);
    expect(quoteComputation.quote.physicalSheets).toBe(8);
  });

  it('calculates duplex sheets for multi-range selection correctly', async () => {
    const quoteComputation = await calculatePrintQuote({
      analysis: sampleAnalysis,
      options: {
        copies: 2,
        colorMode: 'grayscale',
        quality: 'standard',
        paperSize: 'A4',
        duplex: true,
        pageRange: {
          mode: 'custom',
          ranges: [
            { start: 1, end: 5 }, // 5 pages
            { start: 7, end: 9 }, // 3 pages = 8 pages total
          ],
        },
      },
    });

    expect(quoteComputation.ok).toBe(true);
    if (!quoteComputation.ok) return;
    expect(quoteComputation.quote.selectedPages).toBe(8);
    // 8 pages duplex = 4 sheets * 2 copies = 8 sheets
    expect(quoteComputation.quote.physicalSheets).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/services/print-quote-multirange.spec.ts`
Expected: FAIL (types or parsePageRange do not yet support structured `pageRange.mode === 'custom'` with ranges array)

- [ ] **Step 3: Update `src/services/print-quote.ts` and `src/services/worker-handoff.ts`**

In `src/services/print-quote.ts`:
Update `parsePageRange` to integrate with `normalizePageSelection`:

```typescript
import {
  normalizePageSelection,
  parsePageRangeString,
  type PageSelection,
} from '../shared/page-selection';
```

When `payload` is an object with `mode` or `ranges`, or a string, normalize via `normalizePageSelection`:

```typescript
// Support both structured PageSelection and legacy PageRangeSelectionPayload
if (typeof raw === 'object' && raw !== null) {
  const sel = raw as any;
  if (sel.ranges && Array.isArray(sel.ranges)) {
    const norm = normalizePageSelection(sel, totalPages);
    return { normalized: norm.canonicalString };
  }
}
```

In `src/services/worker-handoff.ts`:
Add `pageSelection?: PageSelection` to `printSettings`:

```typescript
import type { PageSelection } from '../shared/page-selection';

export async function handoffToWorker(input: {
  sourcePath: string;
  queueDir: string;
  transactionId: string;
  spoolerCorrelationKey: string;
  printSettings?: {
    copies?: number;
    color?: boolean;
    pageRange?: string | null;
    pageSelection?: PageSelection | null;
    duplex?: boolean;
    orientation?: string | null;
    rotationDeg?: number;
    paperSize?: 'A4' | 'Short' | 'Long';
    quality?: 'standard' | 'high';
    scaling?: PrintScaling;
  };
}) { ... }
```

And serialize `pageSelection` into the JSON sidecar with `schemaVersion: 3`:

```typescript
const sidecar = {
  copies: input.printSettings?.copies ?? 1,
  color: input.printSettings?.color ?? false,
  pageRange: input.printSettings?.pageRange ?? null,
  pageSelection: input.printSettings?.pageSelection ?? null,
  duplex: input.printSettings?.duplex ?? false,
  orientation: input.printSettings?.orientation ?? null,
  rotationDeg: input.printSettings?.rotationDeg ?? 0,
  paperSize: input.printSettings?.paperSize ?? 'A4',
  quality: input.printSettings?.quality ?? 'standard',
  scaling: input.printSettings?.scaling ?? DEFAULT_PRINT_SCALING,
  schemaVersion: 3,
  transactionId: input.transactionId,
  spoolerCorrelationKey: input.spoolerCorrelationKey,
};
```

Update `src/modules/print-queue/print-job.schema.ts` to include `pageSelection?: PageSelection | null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/services/print-quote-multirange.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/print-quote.ts src/services/worker-handoff.ts src/modules/print-queue/ tests/services/print-quote-multirange.spec.ts
git commit -m "feat(services): integrate PageSelection in quote calculations and worker handoff"
```

---

### Task 3: C# Worker DTOs & PrintPlanBuilder (`printbit-worker`)

**Files:**

- Modify: `D:\giomj\Projects\printbit-worker\src\PrintBit.Infrastructure\Services\PrintService\PrintJobSettings.cs`
- Create: `D:\giomj\Projects\printbit-worker\src\PrintBit.Infrastructure\Services\PrintService\PrintPlanBuilder.cs`
- Create: `D:\giomj\Projects\printbit-worker\tests\PrintBit.Infrastructure.Tests\PrintPlanBuilderTests.cs`

**Interfaces:**

- Consumes: `PrintJobSettings`
- Produces:
  - `PageRangeDto(int Start, int End)`
  - `PageSelectionDto(string Mode, IReadOnlyList<PageRangeDto> Ranges)`
  - `PrintPlan(IReadOnlyList<int> SelectedPages, int TotalSelectedPages, int Copies, string NormalizedRangeString)`
  - `PrintPlanBuilder.Build(int pageCount, PrintJobSettings settings)`

* [ ] **Step 1: Write the failing test**

Create `D:\giomj\Projects\printbit-worker\tests\PrintBit.Infrastructure.Tests\PrintPlanBuilderTests.cs`:

```csharp
using PrintBit.Infrastructure.Services.PrintService;
using Xunit;

namespace PrintBit.Infrastructure.Tests;

public class PrintPlanBuilderTests
{
    [Fact]
    public void Build_WithStructuredPageSelection_ReturnsCorrectPlan()
    {
        var settings = new PrintJobSettings
        {
            Copies = 1,
            PageSelection = new PageSelectionDto(
                "custom",
                new[]
                {
                    new PageRangeDto(1, 5),
                    new PageRangeDto(7, 9),
                    new PageRangeDto(15, 15),
                    new PageRangeDto(22, 25)
                }
            )
        };

        var plan = PrintPlanBuilder.Build(30, settings);

        Assert.Equal(14, plan.TotalSelectedPages);
        Assert.Equal(new[] { 1, 2, 3, 4, 5, 7, 8, 9, 15, 22, 23, 24, 25 }, plan.SelectedPages);
        Assert.Equal("1-5,7-9,15,22-25", plan.NormalizedRangeString);
    }

    [Fact]
    public void Build_WithOverlappingRanges_MergesPagesCorrectly()
    {
        var settings = new PrintJobSettings
        {
            Copies = 1,
            PageSelection = new PageSelectionDto(
                "custom",
                new[]
                {
                    new PageRangeDto(1, 5),
                    new PageRangeDto(4, 9)
                }
            )
        };

        var plan = PrintPlanBuilder.Build(30, settings);

        Assert.Equal(9, plan.TotalSelectedPages);
        Assert.Equal(Enumerable.Range(1, 9), plan.SelectedPages);
        Assert.Equal("1-9", plan.NormalizedRangeString);
    }

    [Fact]
    public void Build_WithLegacyString_FallsBackSuccessfully()
    {
        var settings = new PrintJobSettings
        {
            Copies = 1,
            PageRange = "1-3, 5, 7-9"
        };

        var plan = PrintPlanBuilder.Build(30, settings);

        Assert.Equal(7, plan.TotalSelectedPages);
        Assert.Equal(new[] { 1, 2, 3, 5, 7, 8, 9 }, plan.SelectedPages);
        Assert.Equal("1-3,5,7-9", plan.NormalizedRangeString);
    }

    [Fact]
    public void Build_WhenRangeExceedsPageCount_ThrowsInvalidDataException()
    {
        var settings = new PrintJobSettings
        {
            Copies = 1,
            PageSelection = new PageSelectionDto(
                "custom",
                new[] { new PageRangeDto(1, 35) }
            )
        };

        Assert.Throws<InvalidDataException>(() => PrintPlanBuilder.Build(30, settings));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run in `D:\giomj\Projects\printbit-worker`:
`dotnet test --filter "FullyQualifiedName~PrintPlanBuilderTests"`
Expected: FAIL (types do not exist)

- [ ] **Step 3: Implement `PrintPlanBuilder.cs` and update `PrintJobSettings.cs`**

In `PrintJobSettings.cs`:

```csharp
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
```

Create `PrintPlanBuilder.cs`:

```csharp
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
            string.Equals(settings.PageSelection.Mode, "custom", StringComparison.OrdinalIgnoreCase) &&
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
```

- [ ] **Step 4: Run test to verify it passes**

Run in `D:\giomj\Projects\printbit-worker`:
`dotnet test --filter "FullyQualifiedName~PrintPlanBuilderTests"`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit in `printbit-worker`**

```bash
git -C D:\giomj\Projects\printbit-worker add src/ tests/
git -C D:\giomj\Projects\printbit-worker commit -m "feat(print): add PrintPlanBuilder and structured PageSelection DTOs"
```

---

### Task 4: C# Worker Preprocessor & Orchestrator Integration (`printbit-worker`)

**Files:**

- Modify: `D:\giomj\Projects\printbit-worker\src\PrintBit.Infrastructure\Services\DocumentProcessing\DocumentPreprocessor.cs`
- Modify: `D:\giomj\Projects\printbit-worker\src\PrintBit.Infrastructure\Services\PrintService\JobOrchestrator.cs`
- Test: `dotnet test` in `printbit-worker`

**Interfaces:**

- Consumes: `PrintPlanBuilder.Build`
- Produces: Cleanly sliced PDF matching `PrintPlan.SelectedPages`

* [ ] **Step 1: Write integration test**

Add test to `D:\giomj\Projects\printbit-worker\tests\PrintBit.Infrastructure.Tests\PrintPlanBuilderTests.cs`:

```csharp
    [Fact]
    public void Build_SinglePageMode_ReturnsSinglePage()
    {
        var settings = new PrintJobSettings
        {
            Copies = 1,
            PageSelection = new PageSelectionDto(
                "single",
                new[] { new PageRangeDto(4, 4) }
            )
        };

        var plan = PrintPlanBuilder.Build(10, settings);
        Assert.Single(plan.SelectedPages);
        Assert.Equal(4, plan.SelectedPages[0]);
    }
```

- [ ] **Step 2: Update `DocumentPreprocessor.cs`**

Replace `SelectPages` call with `PrintPlanBuilder.Build`:

```csharp
var plan = PrintPlanBuilder.Build(form.PageCount, settings);
foreach (var pageNumber in plan.SelectedPages)
{
    cancellationToken.ThrowIfCancellationRequested();
    form.PageNumber = pageNumber;
    ...
}
```

- [ ] **Step 3: Update `JobOrchestrator.cs`**

In `JobOrchestrator.cs`, log the built `PrintPlan`:

```csharp
var plan = PrintPlanBuilder.Build(pdfPageCount, request.Settings);
_logger.LogInformation("Print plan built: {Count} pages ({Range}) for {Copies} copies",
    plan.TotalSelectedPages, plan.NormalizedRangeString, plan.Copies);
```

- [ ] **Step 4: Run full test suite in `printbit-worker`**

Run: `dotnet test` in `D:\giomj\Projects\printbit-worker`
Expected: PASS (all tests pass, 0 failed)

- [ ] **Step 5: Commit in `printbit-worker`**

```bash
git -C D:\giomj\Projects\printbit-worker add src/ tests/
git -C D:\giomj\Projects\printbit-worker commit -m "feat(preprocessor): slice documents using PrintPlanBuilder"
```

---

### Task 5: Kiosk Custom Range UI Builder Component (`src/public/config`)

**Files:**

- Create: `src/public/config/custom-range-builder.ts`
- Modify: `src/public/config/index.html`
- Modify: `src/public/config/styles.css`
- Modify: `src/public/config/app.ts`

**Interfaces:**

- Consumes: `preview.goToPage(page)`, `preview.pageCount`
- Produces:
  - `createCustomRangeBuilder(options): CustomRangeBuilder`
  - Emits `onChange(result: NormalizedPageSelectionResult)`
  - Exports `getPageRange(): PageRangeSelection` to `app.ts`

* [ ] **Step 1: Create `src/public/config/custom-range-builder.ts`**

Implement component:

- Maintains `rows: Array<{ id: string, start: number, end: number }>`
- Renders each row as:
  ```html
  <div class="custom-range-row" data-row-id="{id}">
    <span class="custom-range-row__label">Range {index}</span>
    <div class="copies-control">
      <button
        type="button"
        class="copies-btn dec-start"
        aria-label="Decrease start"
      >
        -
      </button>
      <input
        type="number"
        class="copies-input start-input"
        value="{start}"
        readonly
      />
      <button
        type="button"
        class="copies-btn inc-start"
        aria-label="Increase start"
      >
        +
      </button>
    </div>
    <span class="custom-range-row__to">to</span>
    <div class="copies-control">
      <button
        type="button"
        class="copies-btn dec-end"
        aria-label="Decrease end"
      >
        -
      </button>
      <input
        type="number"
        class="copies-input end-input"
        value="{end}"
        readonly
      />
      <button
        type="button"
        class="copies-btn inc-end"
        aria-label="Increase end"
      >
        +
      </button>
    </div>
    <button
      type="button"
      class="custom-range-row__delete"
      aria-label="Delete range"
    >
      <svg>...</svg>
    </button>
  </div>
  ```
- Stepper buttons update row values, trigger `preview.goToPage(row.start)`.
- `+ Add page range` appends a row with start = `min(maxPages, lastEnd + 1)`.
- Delete button removes the row (hidden/disabled when `rows.length === 1`).
- Synchronizes with `<input id="customRangeManualInput" />`.
- Displays live feedback:
  - Selected pages count: `Selected: 1–5, 7–9 (8 of 30 pages)`.
  - Merged overlap notification if any overlaps were merged.

* [ ] **Step 2: Update `index.html` and `styles.css`**

In `src/public/config/index.html`:
Replace static `customRangeStartInput` & `customRangeEndInput` with:

```html
<div id="pageRangeCustomWrap" class="page-range-wrap hidden">
  <div id="customRangeRowsContainer" class="custom-range-rows"></div>
  <button type="button" id="addCustomRangeRowBtn" class="add-range-btn">
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
    >
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
    Add page range
  </button>

  <details class="custom-range-manual-details">
    <summary>Advanced page selection</summary>
    <div class="custom-range-manual-wrap">
      <input
        type="text"
        id="customRangeManualInput"
        class="custom-range-manual-input"
        placeholder="e.g. 1-5, 7-9, 15"
      />
    </div>
  </details>

  <div
    id="customRangeFeedbackCard"
    class="custom-range-feedback-card"
    aria-live="polite"
  ></div>
</div>
```

In `src/public/config/styles.css`:
Add styles for `.custom-range-row`, `.custom-range-row__delete`, `.add-range-btn`, and `.custom-range-feedback-card`.

- [ ] **Step 3: Update `src/public/config/app.ts`**

Connect `custom-range-builder` to `app.ts`:

- Initialize builder with `preview.pageCount`.
- On preview load / pageCount change: update builder maxPages.
- Update `getPageRange()` to return:
  ```typescript
  if (pageModeCustom?.checked) {
    const norm = rangeBuilder.getSelection();
    return {
      type: 'custom',
      ranges: norm.ranges,
      range: norm.canonicalString,
    };
  }
  ```
- Trigger `schedulePrintQuoteRefresh()` and `updateSummary()`.

* [ ] **Step 4: Verify client build**

Run: `node scripts/build-client.js`
Expected: SUCCESS without build errors

- [ ] **Step 5: Commit**

```bash
git add src/public/config/
git commit -m "feat(config): add touch-friendly custom range builder with live feedback"
```

---

### Task 6: Confirmation Screen & End-to-End Verification (`src/public/confirm`)

**Files:**

- Modify: `src/public/confirm/app.ts`
- Modify: `src/public/confirm/print-settings.ts`
- Test: `tests/public/custom-range-e2e.spec.ts`

**Interfaces:**

- Consumes: `pageRange` with structured `{ type: 'custom', ranges, range }`
- Produces: Clean confirmation display (e.g. `Pages: 1–5, 7–9 (8 pages)`)

* [ ] **Step 1: Write verification test**

Create `tests/public/custom-range-e2e.spec.ts`:

```typescript
import { buildPhysicalPrintSettings } from '../../src/public/confirm/print-settings';

describe('Confirm Print Settings with Custom Ranges', () => {
  it('formats custom range selection with structured ranges', () => {
    const settings = buildPhysicalPrintSettings(
      {
        copies: 1,
        orientation: 'portrait',
        paperSize: 'A4',
        pageRange: {
          type: 'custom',
          range: '1-5, 7-9',
          ranges: [
            { start: 1, end: 5 },
            { start: 7, end: 9 },
          ],
        } as any,
      },
      'grayscale',
    );

    expect(settings.pageRange.type).toBe('custom');
    expect((settings.pageRange as any).range).toBe('1-5, 7-9');
  });
});
```

- [ ] **Step 2: Update `src/public/confirm/app.ts` and `print-settings.ts`**

Ensure `pageRangeLabel` in `confirm/app.ts` handles:

```typescript
function pageRangeLabel(sel?: PageRangeSelection): string {
  if (!sel) return 'All pages';
  if (sel.type === 'single') return `Page ${sel.page}`;
  if (sel.type === 'custom') {
    return sel.range ? `Pages ${sel.range}` : 'Pages (custom)';
  }
  return 'All pages';
}
```

- [ ] **Step 3: Run test suite**

Run: `pnpm test`
Expected: ALL test suites PASS

- [ ] **Step 4: Commit**

```bash
git add src/public/confirm/ tests/public/
git commit -m "feat(confirm): format and propagate structured custom page ranges"
```

---

## Plan Self-Review Check

1. **Spec coverage:**
   - Kiosk touch-friendly row-based builder: covered in Task 5.
   * Auto merging overlapping/adjacent ranges: covered in Task 1 & Task 3.
   * Advanced manual text input with two-way sync: covered in Task 5.
   * Dual-support sidecar contract: covered in Task 2.
   * C# `PrintPlanBuilder` & preprocessor slicing: covered in Task 3 & Task 4.
   * Confirm screen summary: covered in Task 6.
2. **Placeholders:** Zero TBD/TODOs, all file paths and method signatures are explicit.
3. **Type consistency:** `PageRange`, `PageSelection`, `PageRangeDto`, and `PageSelectionDto` match across all tasks.
