# ID Card Copy and Merged Copy Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ID Card copy type to `/copy` that scans front and back, merges both at real size on one sheet with a preview, and move the copy print settings onto `/copy` so the flow is `/copy` then `/confirm`.

**Architecture:** The worker gains one scan size (`idcard`, a 100 x 100 mm region at the glass origin). Node owns a two-scan ID session: it stores each side, checks it, and builds a one-page PDF with `pdf-lib` that rides the existing `previewPath` copy pipeline unchanged. `/copy` adopts the `/config` layout with a two-stage right pane (capture, then settings) driven by a pure reducer.

**Tech Stack:** TypeScript, Express, `pdf-lib`, `pdfjs-dist` + `canvas` (already used by `document-analysis.ts`), Jest + ts-jest (`testEnvironment: 'node'`), esbuild client bundle (`pnpm build`), ESLint, pnpm; C# worker with NAPS2.Sdk 1.5.0, xUnit.

**Spec:** `docs/superpowers/specs/2026-11-15-id-card-copy-design.md`

## Global Constraints

- Branch: `feat/id-card-copy`, created from `main`.
- No change to `src/modules/copy/copy.service.ts`, pricing, settlement, the print queue, receipts, or the copy job API payload.
- No new worker IPC command and no new worker event.
- No edits to `src/public/config/styles.css`. `/config` must look and behave as before.
- The preview class stays inside `src/public/config/app.ts`. Dead copy-mode branches in `/config` stay.
- ID scans and merged sheets are identity documents: never log file contents or serve them outside `/api/scan/preview/:filename`; delete on release, on expiry and on server start.
- Scan content warnings never block the customer.
- Card real size is 85.6 x 54 mm. Scan region is 100 x 100 mm. Price is one copy page.
- New customer-facing strings need a Filipino entry in `src/locales/fil/translation.json` and an identity entry in `src/locales/en/translation.json`.
- One commit per task. Stage files by explicit path only; never `git add -A`. Do not commit `docs/superpowers/**` or `worker/**/appsettings*.json`.
- Run a single spec with `pnpm exec jest <path>`. Type-check with `pnpm exec tsc --noEmit -p tsconfig.json`. Lint with `pnpm lint`. Client bundle with `pnpm build`.

### Deviations from the spec (deliberate)

- **Styles.** `/copy` links `/config/styles.css` directly instead of both pages linking an extracted stylesheet. `config/styles.css` is 3,036 lines with overriding duplicate sections; extracting blocks risks changing `/config`. Linking the file gives one source of layout CSS with zero edits to it.
- **Retake and Rotate buttons** sit in a copy-specific `copy-preview-actions` row under the sheet. `.preview-toolbar` in `/config` lives in the right footer and is styled for the pager and zoom.
- **Session expiry** is 10 minutes for an incomplete session and 45 minutes for a complete one (the existing `SCAN_RELEASE_TOKEN_TTL_MS`). A single 10 minute limit would delete the sheet under a customer who is slow to insert coins on `/confirm`.
- **Orchestration** lives in a new `src/modules/scanner/id-copy.service.ts` with injected dependencies. `ScannerService` imports the database, admin and settlement services and is not unit-tested directly; it only delegates.
- **Shared contract types** live in a new `src/shared/id-copy-contract.ts`. The thumbnail renderer is a new export of `src/services/document-analysis.ts`, which already owns the pdf.js + canvas loader for Node.
- **Scan failure responses** from the side endpoint also carry `sessionId`, so the page keeps the session after a failed back scan.
- **Image previews.** `/copy` drops the image-format preview branch. Copy pre-scans are always PDF.
- **`/config` redirect** is a three-line inline script in the `<head>` of `src/public/config/index.html`, keyed on the `?mode=copy` query only. `src/public/config/app.ts` is not touched. A stale `printbit.mode = 'copy'` in session storage must not bounce a print customer.
- **Document "Scan Again"** is Start over: it releases the scan and returns to the capture stage, as the current Scan Again does. It does not start a scan by itself.
- **Session keys.** `/copy` adds `printbit.copyFlow`, `printbit.copySettings` and `printbit.copyIdSessionId`. It restores them only when `printbit.copyPreviewPath` is still present, so settings never carry over to the next customer (`/confirm` already clears that key after a job).
- **Layout input.** `idCardSheetLayout` takes each side's scanned page size as well as its rotation, and each side is clipped to its 100 x 100 mm slot. This keeps the sheet correct if the scanner driver ignores the custom scan area and returns the whole platen.

## Review Focus

1. The scanner driver ignores the 100 x 100 mm area and returns the full glass. Expected: the card still lands in its slot at real size and the rest is clipped. Pinned in Task 2.
2. A customer takes longer than 10 minutes to pay on `/confirm`. Expected: the merged sheet still exists and prints. Pinned in Task 4.
3. Retaking the front after rotating it, while the back exists. Expected: the front rotation resets to 0, the back and its rotation are untouched. Pinned in Tasks 4 and 6.
4. A second scan is requested while one runs, or a scan fails on the back. Expected: the stored front is kept and the session survives. Pinned in Tasks 6 and 7.
5. The page holds a session id the server no longer has (restart or expiry), or sends a rotation that is not 0, 90, 180 or 270. Expected: a clear "scan again" reset, or a 400, never a stuck page or a crash. Pinned in Tasks 6 and 7.

## File Structure

| File                                                                          | Status          | Responsibility                            |
| ----------------------------------------------------------------------------- | --------------- | ----------------------------------------- |
| `worker/src/PrintBit.Infrastructure.Windows/Scanning/ScanPageSizeResolver.cs` | modify          | `idcard` scan region                      |
| `worker/src/PrintBit.Infrastructure.Windows/Scanning/Naps2ScannerService.cs`  | modify          | Anchor the ID region to the origin corner |
| `worker/src/PrintBit.Infrastructure.Windows/Scanning/StubScannerService.cs`   | modify          | ID-sized stub page                        |
| `worker/tests/PrintBit.Tests/ScanPageSizeResolverTests.cs`                    | modify          | Resolver tests                            |
| `src/shared/id-card-layout.ts` + `.spec.ts`                                   | create          | Sheet geometry                            |
| `src/shared/id-copy-contract.ts`                                              | create          | Types shared by server and browser        |
| `src/modules/scanner/id-copy-compose.ts` + `.spec.ts`                         | create          | Build the one-page PDF                    |
| `src/modules/scanner/id-copy-session.ts` + `.spec.ts`                         | create          | Session store, expiry, file cleanup       |
| `src/services/document-analysis.ts`                                           | modify          | 32 x 32 gray thumbnail of a PDF page      |
| `src/services/document-analysis-thumbnail.spec.ts`                            | create          | Thumbnail tests                           |
| `src/modules/scanner/id-copy-scan-checks.ts` + `.spec.ts`                     | create          | `side_blank`, `sides_identical`           |
| `src/modules/scanner/id-copy.service.ts` + `.spec.ts`                         | create          | Scan side, compose, release               |
| `src/modules/scanner/copy-preview-settings.ts` + `.spec.ts`                   | modify          | ID scan settings                          |
| `src/services/job-store.ts`                                                   | modify          | Widen `ScanJobSettings.paperSize`         |
| `src/modules/scanner/scanner.service.ts`                                      | modify          | Delegate to `IdCopyService`; release hook |
| `src/modules/scanner/scanner.controller.ts`                                   | modify          | Two endpoints                             |
| `src/modules/scanner/scanner.module.ts`                                       | modify          | Startup purge, expiry sweeper             |
| `src/public/copy/copy-flow-state.ts` + `.spec.ts`                             | create          | Page reducer                              |
| `src/public/shared/copy-config.ts` + `.spec.ts`                               | create          | `printbit.config` builder                 |
| `src/public/copy/copy-settings.ts` + `.spec.ts`                               | create          | Four setting controls                     |
| `src/public/copy/id-capture.ts` + `.spec.ts`                                  | create          | ID endpoint calls                         |
| `src/public/copy/index.html`, `styles.css`                                    | modify          | New layout and styles                     |
| `src/public/copy/app.ts`                                                      | modify          | Wiring                                    |
| `src/public/confirm/printing-stage.ts` + `.spec.ts`                           | modify / create | "Copying n/N"                             |
| `src/public/confirm/app.ts`                                                   | modify          | Pass mode to the stage label              |
| `src/public/config/index.html`                                                | modify          | Redirect `?mode=copy` to `/copy`          |
| `src/locales/en/translation.json`, `src/locales/fil/translation.json`         | modify          | New strings                               |

---

### Task 1: Worker `idcard` scan region

**Files:**

- Modify: `worker/src/PrintBit.Infrastructure.Windows/Scanning/ScanPageSizeResolver.cs`
- Modify: `worker/src/PrintBit.Infrastructure.Windows/Scanning/Naps2ScannerService.cs` (after `options.PageSize = pageSize.PageSize;`)
- Modify: `worker/src/PrintBit.Infrastructure.Windows/Scanning/StubScannerService.cs` (`WriteMockPdf`)
- Test: `worker/tests/PrintBit.Tests/ScanPageSizeResolverTests.cs`

**Interfaces:**

- Consumes: nothing.
- Produces: `StartScan` with `paperSize: "IdCard"` (case-insensitive) scans a 100 x 100 mm flatbed region from the glass origin. `ScanPageSizeResolver.IsIdCard(string?)` and `ScanPageSizeResolver.IdCardRegionMm` (100m).

- [ ] **Step 1: Create the branch**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/id-card-copy
```

- [ ] **Step 2: Write the failing tests**

Add inside `ScanPageSizeResolverTests` in `worker/tests/PrintBit.Tests/ScanPageSizeResolverTests.cs`:

```csharp
    [Theory]
    [InlineData("idcard", false)]
    [InlineData("IdCard", false)]
    [InlineData(" IDCARD ", false)]
    [InlineData("idcard", true)]
    public void IdCard_IsASquareRegionAtTheGlassOrigin(string paperSize, bool isFeeder)
    {
        var resolved = ScanPageSizeResolver.Resolve(paperSize, isFeeder);

        Assert.False(resolved.ClampedToGlass);
        var (width, height) = Millimetres(resolved.PageSize!);
        Assert.Equal(100m, width);
        Assert.Equal(100m, height);
    }

    [Theory]
    [InlineData("idcard", true)]
    [InlineData(" IdCard ", true)]
    [InlineData("a4", false)]
    [InlineData(null, false)]
    [InlineData("", false)]
    public void IsIdCard_MatchesOnlyTheIdCardSize(string? paperSize, bool expected)
    {
        Assert.Equal(expected, ScanPageSizeResolver.IsIdCard(paperSize));
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `dotnet test worker/tests/PrintBit.Tests/PrintBit.Tests.csproj --filter "FullyQualifiedName~ScanPageSizeResolverTests"`
Expected: build error `'ScanPageSizeResolver' does not contain a definition for 'IsIdCard'`.

- [ ] **Step 4: Implement the resolver change**

In `ScanPageSizeResolver.cs`, add below `private const decimal LongLengthMm = 330m;`:

```csharp
    /// <summary>
    /// Side of the square scanned for an ID card. The card (85.6 x 54 mm) sits
    /// at the glass origin corner; the square fits it in either orientation.
    /// </summary>
    public const decimal IdCardRegionMm = 100m;

    public static bool IsIdCard(string? paperSize) =>
        string.Equals(paperSize?.Trim(), "idcard", StringComparison.OrdinalIgnoreCase);
```

In `Resolve`, add this case before `case "a4":`:

```csharp
            case "idcard":
                return new Resolution(
                    new PageSize(IdCardRegionMm, IdCardRegionMm, PageSizeUnit.Millimetre),
                    false);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test worker/tests/PrintBit.Tests/PrintBit.Tests.csproj --filter "FullyQualifiedName~ScanPageSizeResolverTests"`
Expected: PASS, all tests in the class.

- [ ] **Step 6: Anchor the region in the NAPS2 scan**

In `Naps2ScannerService.cs`, directly after `options.PageSize = pageSize.PageSize;` add:

```csharp
        if (ScanPageSizeResolver.IsIdCard(request.PaperSize))
        {
            // A region smaller than the glass must start at the origin corner,
            // where the customer places the card (the marked corner).
            options.PageAlign = HorizontalAlign.Left;
        }
```

Add `using NAPS2.Scan;` at the top if `HorizontalAlign` does not resolve.

`ScanOptions.PageAlign` and `HorizontalAlign` could not be checked against the NAPS2.Sdk 1.5.0 package while writing this plan. If the build reports that `ScanOptions` has no `PageAlign`, open the `ScanOptions` definition (Go To Definition on `ScanOptions`) and use the horizontal alignment property it declares with its `Left` value. Task 11 confirms on the real scanner whether `Left` or `Right` matches the marked corner.

- [ ] **Step 7: Make the stub produce an ID-sized page**

In `StubScannerService.cs`, add a field to the class:

```csharp
    private static int _idStubCounter;
```

In `WriteMockPdf`, replace the block that starts at `var sb = new StringBuilder();` and ends at `sb.AppendLine("ET");` with:

```csharp
        var isIdCard = ScanPageSizeResolver.IsIdCard(request.PaperSize);
        var titleFont = isIdCard ? 9 : 18;
        var bodyFont = isIdCard ? 6 : 11;
        var startX = isIdCard ? 10 : 50;
        var startY = isIdCard ? 255 : 780;
        var lineStep = isIdCard ? 10 : 20;

        var sb = new StringBuilder();
        if (isIdCard)
        {
            // A card-sized block at the origin corner, alternating colour so the
            // two sides of a stub ID differ and the scan checks stay quiet.
            var shade = Interlocked.Increment(ref _idStubCounter) % 2 == 0
                ? "0.20 0.30 0.60"
                : "0.75 0.35 0.20";
            sb.AppendLine($"{shade} rg");
            sb.AppendLine("0 130 243 153 re f");
            sb.AppendLine("1 1 1 rg");
        }
        sb.AppendLine("BT");
        sb.AppendLine($"/F1 {titleFont} Tf");
        sb.AppendLine($"{startX} {startY} Td");
        sb.AppendLine($"({EscapePdf(textLines[0])}) Tj");
        sb.AppendLine($"/F1 {bodyFont} Tf");
        for (int i = 1; i < textLines.Length; i++)
        {
            sb.AppendLine($"0 -{lineStep} Td");
            sb.AppendLine($"({EscapePdf(textLines[i])}) Tj");
        }
        sb.AppendLine("ET");
```

In the same method, replace the page object line:

```csharp
        writer.Write("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n");
```

with:

```csharp
        var mediaBox = isIdCard ? "0 0 283 283" : "0 0 595 842";
        writer.Write($"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [{mediaBox}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n");
```

Add `using System.Threading;` at the top if `Interlocked` does not resolve.

- [ ] **Step 8: Build the worker**

Run: `pnpm worker:build`
Expected: `Build succeeded` with 0 errors.

- [ ] **Step 9: Run all worker tests**

Run: `dotnet test worker/tests/PrintBit.Tests/PrintBit.Tests.csproj`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add worker/src/PrintBit.Infrastructure.Windows/Scanning/ScanPageSizeResolver.cs worker/src/PrintBit.Infrastructure.Windows/Scanning/Naps2ScannerService.cs worker/src/PrintBit.Infrastructure.Windows/Scanning/StubScannerService.cs worker/tests/PrintBit.Tests/ScanPageSizeResolverTests.cs
git commit -m "feat(worker): add idcard scan region"
```

---

### Task 2: Sheet geometry

**Files:**

- Create: `src/shared/id-card-layout.ts`
- Test: `src/shared/id-card-layout.spec.ts`

**Interfaces:**

- Consumes: `PAPER_POINTS`, `DEFAULT_PRINT_SCALING`, `calculatePrintLayout`, `PaperSize` from `src/shared/print-configuration.ts`.
- Produces:
  - `type IdSide = 'front' | 'back'`, `type IdRotation = 0 | 90 | 180 | 270`
  - `MM_TO_PT`, `ID_CARD_WIDTH_MM` (85.6), `ID_CARD_HEIGHT_MM` (54), `ID_SLOT_SIZE_MM` (100)
  - `interface IdRect { x: number; y: number; width: number; height: number }` (PDF points, origin bottom-left)
  - `interface IdSideInput { region: { width: number; height: number }; rotationDeg: IdRotation }` (`region` is the unrotated scanned page size in points)
  - `interface IdSidePlacement { slot: IdRect; region: IdRect; rotationDeg: IdRotation }` (`region` is the rotated footprint)
  - `interface IdCardSheetLayout { pageWidth: number; pageHeight: number; fitScale: number; front: IdSidePlacement | null; back: IdSidePlacement | null }`
  - `idCardSheetLayout(paperSize: PaperSize, sides: Record<IdSide, IdSideInput | null>): IdCardSheetLayout`
  - `slotFractions(paperSize: PaperSize, side: IdSide): { left: number; top: number; width: number; height: number }` (fractions of the printed sheet, origin top-left)

Geometry rules. All real-size positions are defined in millimetres from the top-left of the printed sheet, then enlarged about the page centre by `1 / fitScale`, because the print path shrinks the page by `fitScale` about its centre. The card is assumed to sit at the top-left corner of the scan image and to lie landscape after rotation. Each side has a 100 x 100 mm slot with the card centred in it; front slot top is 15 mm, back slot is 10 mm below the front slot.

- [ ] **Step 1: Write the failing test**

Create `src/shared/id-card-layout.spec.ts`:

```ts
import {
  ID_CARD_HEIGHT_MM,
  ID_CARD_WIDTH_MM,
  MM_TO_PT,
  idCardSheetLayout,
  slotFractions,
  type IdCardSheetLayout,
  type IdRect,
  type IdRotation,
} from './id-card-layout';
import { PAPER_POINTS, type PaperSize } from './print-configuration';

const PAPERS: PaperSize[] = ['A4', 'Short', 'Long'];
const SQUARE = { width: 100 * MM_TO_PT, height: 100 * MM_TO_PT };

/** Where a sheet rectangle lands on paper after fit scaling, in mm from the top-left. */
function printedMm(layout: IdCardSheetLayout, rect: IdRect) {
  const cx = layout.pageWidth / 2;
  const cy = layout.pageHeight / 2;
  const leftPt = cx + (rect.x - cx) * layout.fitScale;
  const topDownPt = layout.pageHeight - (rect.y + rect.height);
  const topPt = cy + (topDownPt - cy) * layout.fitScale;
  return {
    x: leftPt / MM_TO_PT,
    y: topPt / MM_TO_PT,
    width: (rect.width * layout.fitScale) / MM_TO_PT,
    height: (rect.height * layout.fitScale) / MM_TO_PT,
  };
}

function both(rotationDeg: IdRotation = 0) {
  return {
    front: { region: SQUARE, rotationDeg },
    back: { region: SQUARE, rotationDeg },
  };
}

describe('idCardSheetLayout', () => {
  it.each(PAPERS)('prints the scan region at real size on %s', (paper) => {
    const layout = idCardSheetLayout(paper, both());
    const front = printedMm(layout, layout.front!.region);
    expect(front.width).toBeCloseTo(100, 3);
    expect(front.height).toBeCloseTo(100, 3);
  });

  it.each(PAPERS)('centres the card horizontally on %s', (paper) => {
    const layout = idCardSheetLayout(paper, both());
    const paperWidthMm = PAPER_POINTS[paper][0] / MM_TO_PT;
    const front = printedMm(layout, layout.front!.region);
    expect(front.x).toBeCloseTo((paperWidthMm - ID_CARD_WIDTH_MM) / 2, 3);
  });

  it.each(PAPERS)('keeps both slots on the page and apart on %s', (paper) => {
    const layout = idCardSheetLayout(paper, both());
    const front = layout.front!.slot;
    const back = layout.back!.slot;
    for (const slot of [front, back]) {
      expect(slot.x).toBeGreaterThanOrEqual(0);
      expect(slot.y).toBeGreaterThanOrEqual(0);
      expect(slot.x + slot.width).toBeLessThanOrEqual(layout.pageWidth);
      expect(slot.y + slot.height).toBeLessThanOrEqual(layout.pageHeight);
    }
    // PDF y grows upward: the front slot sits above the back slot.
    expect(front.y).toBeGreaterThanOrEqual(back.y + back.height);
  });

  it('puts the card at the same printed place for every rotation', () => {
    const base = idCardSheetLayout('A4', both(0));
    const baseRegion = printedMm(base, base.front!.region);
    const slack = { x: 100 - ID_CARD_WIDTH_MM, y: 100 - ID_CARD_HEIGHT_MM };
    const expected: Record<IdRotation, { dx: number; dy: number }> = {
      0: { dx: 0, dy: 0 },
      90: { dx: -slack.x, dy: 0 },
      180: { dx: -slack.x, dy: -slack.y },
      270: { dx: 0, dy: -slack.y },
    };
    for (const rotation of [0, 90, 180, 270] as IdRotation[]) {
      const layout = idCardSheetLayout('A4', both(rotation));
      const region = printedMm(layout, layout.front!.region);
      expect(region.x - baseRegion.x).toBeCloseTo(expected[rotation].dx, 3);
      expect(region.y - baseRegion.y).toBeCloseTo(expected[rotation].dy, 3);
      expect(layout.front!.rotationDeg).toBe(rotation);
    }
  });

  it('does not move the slot when a side is rotated', () => {
    const a = idCardSheetLayout('A4', both(0));
    const b = idCardSheetLayout('A4', both(180));
    expect(b.front!.slot).toEqual(a.front!.slot);
    expect(b.back!.slot).toEqual(a.back!.slot);
  });

  it('anchors a full-glass scan at the card corner and keeps the slot', () => {
    const fullGlass = { width: 216 * MM_TO_PT, height: 297 * MM_TO_PT };
    const normal = idCardSheetLayout('A4', both());
    const layout = idCardSheetLayout('A4', {
      front: { region: fullGlass, rotationDeg: 0 },
      back: null,
    });
    const region = printedMm(layout, layout.front!.region);
    const normalRegion = printedMm(normal, normal.front!.region);
    expect(region.x).toBeCloseTo(normalRegion.x, 3);
    expect(region.y).toBeCloseTo(normalRegion.y, 3);
    expect(region.width).toBeCloseTo(216, 3);
    expect(layout.front!.slot).toEqual(normal.front!.slot);
  });

  it('swaps the footprint of a non-square region on a quarter turn', () => {
    const wide = { width: 120 * MM_TO_PT, height: 80 * MM_TO_PT };
    const layout = idCardSheetLayout('A4', {
      front: { region: wide, rotationDeg: 90 },
      back: null,
    });
    const region = printedMm(layout, layout.front!.region);
    expect(region.width).toBeCloseTo(80, 3);
    expect(region.height).toBeCloseTo(120, 3);
  });

  it('returns null for a side that is not scanned', () => {
    const layout = idCardSheetLayout('A4', {
      front: { region: SQUARE, rotationDeg: 0 },
      back: null,
    });
    expect(layout.front).not.toBeNull();
    expect(layout.back).toBeNull();
  });
});

describe('slotFractions', () => {
  it.each(PAPERS)(
    'stays inside the sheet with back below front on %s',
    (paper) => {
      const front = slotFractions(paper, 'front');
      const back = slotFractions(paper, 'back');
      for (const slot of [front, back]) {
        expect(slot.left).toBeGreaterThan(0);
        expect(slot.top).toBeGreaterThan(0);
        expect(slot.left + slot.width).toBeLessThan(1);
        expect(slot.top + slot.height).toBeLessThan(1);
      }
      expect(back.top).toBeGreaterThan(front.top + front.height);
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/shared/id-card-layout.spec.ts`
Expected: FAIL with `Cannot find module './id-card-layout'`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/id-card-layout.ts`:

```ts
/**
 * Geometry of an ID card copy sheet: front above back, each at real size.
 * Units are PDF points unless a name says millimetres.
 */
import {
  DEFAULT_PRINT_SCALING,
  PAPER_POINTS,
  calculatePrintLayout,
  type PaperSize,
} from './print-configuration';

export type IdSide = 'front' | 'back';
export type IdRotation = 0 | 90 | 180 | 270;

export const MM_TO_PT = 72 / 25.4;
export const ID_CARD_WIDTH_MM = 85.6;
export const ID_CARD_HEIGHT_MM = 54;
/** Visible window per side. Matches the worker's scan region. */
export const ID_SLOT_SIZE_MM = 100;
export const ID_SLOT_TOP_MM = 15;
export const ID_SLOT_GAP_MM = 10;

/** PDF points, origin bottom-left. */
export interface IdRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IdSideInput {
  /** Unrotated size of the scanned page, in points. */
  region: { width: number; height: number };
  rotationDeg: IdRotation;
}

export interface IdSidePlacement {
  /** Clip window for this side. */
  slot: IdRect;
  /** Footprint of the rotated scan on the sheet. */
  region: IdRect;
  rotationDeg: IdRotation;
}

export interface IdCardSheetLayout {
  pageWidth: number;
  pageHeight: number;
  /** Scale the print path applies to a full page. */
  fitScale: number;
  front: IdSidePlacement | null;
  back: IdSidePlacement | null;
}

/** Millimetres on the printed sheet, origin top-left. */
interface MmRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function fitScaleFor(paperSize: PaperSize): number {
  const [width, height] = PAPER_POINTS[paperSize];
  return calculatePrintLayout(width, height, {
    paperSize,
    scaling: DEFAULT_PRINT_SCALING,
    orientation: 'portrait',
    rotationDeg: 0,
  }).scale;
}

function printedCardMm(paperSize: PaperSize, side: IdSide): MmRect {
  const paperWidthMm = PAPER_POINTS[paperSize][0] / MM_TO_PT;
  const slotTop =
    side === 'front'
      ? ID_SLOT_TOP_MM
      : ID_SLOT_TOP_MM + ID_SLOT_SIZE_MM + ID_SLOT_GAP_MM;
  return {
    x: (paperWidthMm - ID_CARD_WIDTH_MM) / 2,
    y: slotTop + (ID_SLOT_SIZE_MM - ID_CARD_HEIGHT_MM) / 2,
    width: ID_CARD_WIDTH_MM,
    height: ID_CARD_HEIGHT_MM,
  };
}

function printedSlotMm(paperSize: PaperSize, side: IdSide): MmRect {
  const card = printedCardMm(paperSize, side);
  return {
    x: card.x - (ID_SLOT_SIZE_MM - ID_CARD_WIDTH_MM) / 2,
    y: card.y - (ID_SLOT_SIZE_MM - ID_CARD_HEIGHT_MM) / 2,
    width: ID_SLOT_SIZE_MM,
    height: ID_SLOT_SIZE_MM,
  };
}

/**
 * The card sits at the top-left corner of the scan. Turning the scan clockwise
 * moves that corner: 90 to top-right, 180 to bottom-right, 270 to bottom-left.
 * The scan is placed so the card, assumed landscape after the turn, lands on
 * the fixed card position.
 */
function printedRegionMm(
  paperSize: PaperSize,
  side: IdSide,
  input: IdSideInput,
): MmRect {
  const width = input.region.width / MM_TO_PT;
  const height = input.region.height / MM_TO_PT;
  const quarterTurn = input.rotationDeg === 90 || input.rotationDeg === 270;
  const rotatedWidth = quarterTurn ? height : width;
  const rotatedHeight = quarterTurn ? width : height;
  const card = printedCardMm(paperSize, side);
  const offsetX =
    input.rotationDeg === 90 || input.rotationDeg === 180
      ? rotatedWidth - ID_CARD_WIDTH_MM
      : 0;
  const offsetY =
    input.rotationDeg === 180 || input.rotationDeg === 270
      ? rotatedHeight - ID_CARD_HEIGHT_MM
      : 0;
  return {
    x: card.x - offsetX,
    y: card.y - offsetY,
    width: rotatedWidth,
    height: rotatedHeight,
  };
}

/** Enlarges a printed rectangle about the page centre and flips to PDF axes. */
function toSheetRect(
  rect: MmRect,
  pageWidth: number,
  pageHeight: number,
  fitScale: number,
): IdRect {
  const grow = 1 / fitScale;
  const centreX = pageWidth / 2;
  const centreY = pageHeight / 2;
  const left = centreX + (rect.x * MM_TO_PT - centreX) * grow;
  const top = centreY + (rect.y * MM_TO_PT - centreY) * grow;
  const width = rect.width * MM_TO_PT * grow;
  const height = rect.height * MM_TO_PT * grow;
  return { x: left, y: pageHeight - top - height, width, height };
}

export function idCardSheetLayout(
  paperSize: PaperSize,
  sides: Record<IdSide, IdSideInput | null>,
): IdCardSheetLayout {
  const [pageWidth, pageHeight] = PAPER_POINTS[paperSize];
  const fitScale = fitScaleFor(paperSize);
  const place = (side: IdSide): IdSidePlacement | null => {
    const input = sides[side];
    if (!input) return null;
    return {
      slot: toSheetRect(
        printedSlotMm(paperSize, side),
        pageWidth,
        pageHeight,
        fitScale,
      ),
      region: toSheetRect(
        printedRegionMm(paperSize, side, input),
        pageWidth,
        pageHeight,
        fitScale,
      ),
      rotationDeg: input.rotationDeg,
    };
  };
  return {
    pageWidth,
    pageHeight,
    fitScale,
    front: place('front'),
    back: place('back'),
  };
}

/** Slot position as fractions of the printed sheet, origin top-left. */
export function slotFractions(
  paperSize: PaperSize,
  side: IdSide,
): { left: number; top: number; width: number; height: number } {
  const [pageWidth, pageHeight] = PAPER_POINTS[paperSize];
  const slot = printedSlotMm(paperSize, side);
  return {
    left: (slot.x * MM_TO_PT) / pageWidth,
    top: (slot.y * MM_TO_PT) / pageHeight,
    width: (slot.width * MM_TO_PT) / pageWidth,
    height: (slot.height * MM_TO_PT) / pageHeight,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/shared/id-card-layout.spec.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/id-card-layout.ts src/shared/id-card-layout.spec.ts
git commit -m "feat(copy): add ID card sheet geometry"
```

---

### Task 3: Compose the one-page sheet

**Files:**

- Create: `src/modules/scanner/id-copy-compose.ts`
- Test: `src/modules/scanner/id-copy-compose.spec.ts`

**Interfaces:**

- Consumes: `idCardSheetLayout`, `IdRotation`, `IdSidePlacement` from `@/shared/id-card-layout`; `PAPER_POINTS`, `PaperSize` from `@/shared/print-configuration`.
- Produces:
  - `interface IdSheetSideInput { filePath: string; rotationDeg: IdRotation }`
  - `interface ComposeIdSheetInput { paperSize: PaperSize; front: IdSheetSideInput | null; back: IdSheetSideInput | null }`
  - `composeIdSheet(input: ComposeIdSheetInput): Promise<Uint8Array>` (one-page PDF bytes; throws `Error('No ID side to compose.')` when both sides are null)
  - `regionDrawOptions(placement: IdSidePlacement): { x: number; y: number; width: number; height: number; rotateDeg: number }`

`pdf-lib` rotates counter-clockwise about the draw origin. A clockwise turn of the scan is therefore a negative angle with the origin moved to the corner that ends up bottom-left of the unrotated page.

- [ ] **Step 1: Write the failing test**

Create `src/modules/scanner/id-copy-compose.spec.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { MM_TO_PT } from '@/shared/id-card-layout';
import { PAPER_POINTS, type PaperSize } from '@/shared/print-configuration';
import { composeIdSheet, regionDrawOptions } from './id-copy-compose';

let dir: string;

async function writeSidePdf(name: string): Promise<string> {
  const doc = await PDFDocument.create();
  const side = 100 * MM_TO_PT;
  const page = doc.addPage([side, side]);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: side / 2,
    height: side,
    color: rgb(0, 0, 0),
  });
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, await doc.save());
  return filePath;
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'id-compose-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('composeIdSheet', () => {
  it.each(['A4', 'Short', 'Long'] as PaperSize[])(
    'builds one %s page from both sides',
    async (paperSize) => {
      const front = await writeSidePdf('front.pdf');
      const back = await writeSidePdf('back.pdf');
      const bytes = await composeIdSheet({
        paperSize,
        front: { filePath: front, rotationDeg: 0 },
        back: { filePath: back, rotationDeg: 180 },
      });
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
      const { width, height } = doc.getPage(0).getSize();
      expect(width).toBeCloseTo(PAPER_POINTS[paperSize][0], 2);
      expect(height).toBeCloseTo(PAPER_POINTS[paperSize][1], 2);
    },
  );

  it('builds a valid sheet from the front alone', async () => {
    const front = await writeSidePdf('front.pdf');
    const bytes = await composeIdSheet({
      paperSize: 'A4',
      front: { filePath: front, rotationDeg: 90 },
      back: null,
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('rejects a sheet with no side', async () => {
    await expect(
      composeIdSheet({ paperSize: 'A4', front: null, back: null }),
    ).rejects.toThrow('No ID side to compose.');
  });

  it('rejects a missing side file', async () => {
    await expect(
      composeIdSheet({
        paperSize: 'A4',
        front: { filePath: path.join(dir, 'gone.pdf'), rotationDeg: 0 },
        back: null,
      }),
    ).rejects.toThrow();
  });
});

describe('regionDrawOptions', () => {
  const slot = { x: 0, y: 0, width: 1, height: 1 };
  const region = { x: 10, y: 20, width: 300, height: 200 };

  it('draws an unrotated scan at its footprint', () => {
    expect(regionDrawOptions({ slot, region, rotationDeg: 0 })).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      rotateDeg: 0,
    });
  });

  it('starts a 90 degree clockwise turn at the top-left corner', () => {
    expect(regionDrawOptions({ slot, region, rotationDeg: 90 })).toEqual({
      x: 10,
      y: 220,
      width: 200,
      height: 300,
      rotateDeg: -90,
    });
  });

  it('starts a half turn at the top-right corner', () => {
    expect(regionDrawOptions({ slot, region, rotationDeg: 180 })).toEqual({
      x: 310,
      y: 220,
      width: 300,
      height: 200,
      rotateDeg: 180,
    });
  });

  it('starts a 270 degree clockwise turn at the bottom-right corner', () => {
    expect(regionDrawOptions({ slot, region, rotationDeg: 270 })).toEqual({
      x: 310,
      y: 20,
      width: 200,
      height: 300,
      rotateDeg: 90,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/modules/scanner/id-copy-compose.spec.ts`
Expected: FAIL with `Cannot find module './id-copy-compose'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/scanner/id-copy-compose.ts`:

```ts
import fs from 'node:fs';
import {
  PDFDocument,
  clip,
  degrees,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  type PDFEmbeddedPage,
} from 'pdf-lib';
import {
  idCardSheetLayout,
  type IdRotation,
  type IdSide,
  type IdSidePlacement,
} from '@/shared/id-card-layout';
import { PAPER_POINTS, type PaperSize } from '@/shared/print-configuration';

export interface IdSheetSideInput {
  filePath: string;
  rotationDeg: IdRotation;
}

export interface ComposeIdSheetInput {
  paperSize: PaperSize;
  front: IdSheetSideInput | null;
  back: IdSheetSideInput | null;
}

export interface RegionDrawOptions {
  x: number;
  y: number;
  /** Unrotated draw size. */
  width: number;
  height: number;
  /** Counter-clockwise degrees, as pdf-lib expects. */
  rotateDeg: number;
}

/**
 * Turns a rotated footprint into pdf-lib draw options. pdf-lib rotates
 * counter-clockwise about (x, y), so a clockwise turn starts from the corner
 * that the unrotated page's bottom-left ends up on.
 */
export function regionDrawOptions(
  placement: IdSidePlacement,
): RegionDrawOptions {
  const { x, y, width, height } = placement.region;
  switch (placement.rotationDeg) {
    case 90:
      return { x, y: y + height, width: height, height: width, rotateDeg: -90 };
    case 180:
      return { x: x + width, y: y + height, width, height, rotateDeg: 180 };
    case 270:
      return { x: x + width, y, width: height, height: width, rotateDeg: 90 };
    default:
      return { x, y, width, height, rotateDeg: 0 };
  }
}

async function embedFirstPage(
  out: PDFDocument,
  filePath: string,
): Promise<PDFEmbeddedPage> {
  const bytes = await fs.promises.readFile(filePath);
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const [embedded] = await out.embedPdf(source, [0]);
  return embedded;
}

/** Builds the one-page ID copy sheet. A side that is null is left empty. */
export async function composeIdSheet(
  input: ComposeIdSheetInput,
): Promise<Uint8Array> {
  if (!input.front && !input.back) {
    throw new Error('No ID side to compose.');
  }

  const out = await PDFDocument.create();
  const [pageWidth, pageHeight] = PAPER_POINTS[input.paperSize];
  const page = out.addPage([pageWidth, pageHeight]);

  const embedded: Record<IdSide, PDFEmbeddedPage | null> = {
    front: input.front ? await embedFirstPage(out, input.front.filePath) : null,
    back: input.back ? await embedFirstPage(out, input.back.filePath) : null,
  };

  const sideInput = (side: IdSide) => {
    const source = input[side];
    const pageRef = embedded[side];
    if (!source || !pageRef) return null;
    return {
      region: { width: pageRef.width, height: pageRef.height },
      rotationDeg: source.rotationDeg,
    };
  };

  const layout = idCardSheetLayout(input.paperSize, {
    front: sideInput('front'),
    back: sideInput('back'),
  });

  for (const side of ['front', 'back'] as const) {
    const placement = layout[side];
    const pageRef = embedded[side];
    if (!placement || !pageRef) continue;
    const draw = regionDrawOptions(placement);
    page.pushOperators(
      pushGraphicsState(),
      rectangle(
        placement.slot.x,
        placement.slot.y,
        placement.slot.width,
        placement.slot.height,
      ),
      clip(),
      endPath(),
    );
    page.drawPage(pageRef, {
      x: draw.x,
      y: draw.y,
      width: draw.width,
      height: draw.height,
      rotate: degrees(draw.rotateDeg),
    });
    page.pushOperators(popGraphicsState());
  }

  return out.save();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/modules/scanner/id-copy-compose.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/scanner/id-copy-compose.ts src/modules/scanner/id-copy-compose.spec.ts
git commit -m "feat(copy): compose ID card sheet PDF"
```

---

### Task 4: ID copy session store

**Files:**

- Create: `src/modules/scanner/id-copy-session.ts`
- Test: `src/modules/scanner/id-copy-session.spec.ts`

**Interfaces:**

- Consumes: `IdRotation`, `IdSide` from `@/shared/id-card-layout`.
- Produces:
  - `ID_COPY_INCOMPLETE_TTL_MS` (600000), `ID_COPY_COMPLETE_TTL_MS` (2700000)
  - `class IdCopySessionNotFoundError extends Error`
  - `interface IdCopySideRecord { fileName: string; rotationDeg: IdRotation }`
  - `interface IdCopySession { id: string; front: IdCopySideRecord | null; back: IdCopySideRecord | null; mergedFileName: string | null; releaseToken: string | null; touchedAt: number }`
  - `class IdCopySessionStore` with `constructor(options: { scansDir: string; now?: () => number })` and methods:
    - `create(): IdCopySession`
    - `get(id: string): Promise<IdCopySession | null>` (purges expired sessions, refreshes `touchedAt`)
    - `setSide(id: string, side: IdSide, scannedFileName: string): Promise<IdCopySession>` (renames the scan to `id-side-<uuid>.pdf`, deletes the previous file for that side, resets its rotation to 0)
    - `setRotation(id: string, side: IdSide, rotationDeg: IdRotation): IdCopySession`
    - `setMerged(id: string, fileName: string, releaseToken: string): Promise<string | null>` (deletes and returns the previous merged file name)
    - `findByReleaseToken(token: string): IdCopySession | null`
    - `destroy(id: string): Promise<void>` (deletes every file of the session)
    - `purgeExpired(): Promise<number>`
    - `startSweeper(intervalMs?: number): () => void`
  - `purgeIdCopyFiles(scansDir: string): Promise<number>` (deletes every `id-side-*.pdf` and `id-copy-*.pdf`)

`setSide`, `setRotation` and `setMerged` throw `IdCopySessionNotFoundError` for an unknown id.

- [ ] **Step 1: Write the failing test**

Create `src/modules/scanner/id-copy-session.spec.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ID_COPY_COMPLETE_TTL_MS,
  ID_COPY_INCOMPLETE_TTL_MS,
  IdCopySessionNotFoundError,
  IdCopySessionStore,
  purgeIdCopyFiles,
} from './id-copy-session';

let dir: string;
let clock: number;
let store: IdCopySessionStore;

async function writeScan(name: string): Promise<string> {
  await fs.promises.writeFile(path.join(dir, name), 'scan');
  return name;
}

const exists = (name: string) => fs.existsSync(path.join(dir, name));

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'id-session-'));
  clock = 1_000_000;
  store = new IdCopySessionStore({ scansDir: dir, now: () => clock });
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('IdCopySessionStore', () => {
  it('renames a scanned side to an id-side file', async () => {
    const session = store.create();
    const updated = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-1.pdf'),
    );
    expect(updated.front!.fileName).toMatch(/^id-side-[0-9a-f-]+\.pdf$/);
    expect(exists(updated.front!.fileName)).toBe(true);
    expect(exists('scan-1.pdf')).toBe(false);
    expect(updated.front!.rotationDeg).toBe(0);
  });

  it('retaking a side deletes the old file, resets its rotation and keeps the other side', async () => {
    const session = store.create();
    await store.setSide(session.id, 'front', await writeScan('scan-1.pdf'));
    await store.setSide(session.id, 'back', await writeScan('scan-2.pdf'));
    store.setRotation(session.id, 'front', 180);
    store.setRotation(session.id, 'back', 90);
    const before = (await store.get(session.id))!;
    const oldFront = before.front!.fileName;
    const backFile = before.back!.fileName;

    const after = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-3.pdf'),
    );

    expect(exists(oldFront)).toBe(false);
    expect(after.front!.rotationDeg).toBe(0);
    expect(after.back).toEqual({ fileName: backFile, rotationDeg: 90 });
    expect(exists(backFile)).toBe(true);
  });

  it('replacing the merged file deletes and returns the previous one', async () => {
    const session = store.create();
    await writeScan('id-copy-a.pdf');
    await writeScan('id-copy-b.pdf');
    expect(
      await store.setMerged(session.id, 'id-copy-a.pdf', 'token-a'),
    ).toBeNull();
    expect(await store.setMerged(session.id, 'id-copy-b.pdf', 'token-b')).toBe(
      'id-copy-a.pdf',
    );
    expect(exists('id-copy-a.pdf')).toBe(false);
    expect(exists('id-copy-b.pdf')).toBe(true);
    expect(store.findByReleaseToken('token-b')!.id).toBe(session.id);
    expect(store.findByReleaseToken('token-a')).toBeNull();
  });

  it('destroy deletes every file and forgets the session', async () => {
    const session = store.create();
    const withFront = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-1.pdf'),
    );
    await writeScan('id-copy-a.pdf');
    await store.setMerged(session.id, 'id-copy-a.pdf', 'token-a');

    await store.destroy(session.id);

    expect(exists(withFront.front!.fileName)).toBe(false);
    expect(exists('id-copy-a.pdf')).toBe(false);
    expect(await store.get(session.id)).toBeNull();
  });

  it('expires an incomplete session after 10 idle minutes and deletes its files', async () => {
    const session = store.create();
    const withFront = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-1.pdf'),
    );

    clock += ID_COPY_INCOMPLETE_TTL_MS - 1;
    expect(await store.get(session.id)).not.toBeNull();

    clock += ID_COPY_INCOMPLETE_TTL_MS;
    expect(await store.get(session.id)).toBeNull();
    expect(exists(withFront.front!.fileName)).toBe(false);
  });

  it('keeps a complete session for 45 idle minutes so a slow payer still prints', async () => {
    const session = store.create();
    await store.setSide(session.id, 'front', await writeScan('scan-1.pdf'));
    await store.setSide(session.id, 'back', await writeScan('scan-2.pdf'));
    await writeScan('id-copy-a.pdf');
    await store.setMerged(session.id, 'id-copy-a.pdf', 'token-a');

    clock += ID_COPY_INCOMPLETE_TTL_MS * 3;
    expect(await store.purgeExpired()).toBe(0);
    expect(exists('id-copy-a.pdf')).toBe(true);

    clock += ID_COPY_COMPLETE_TTL_MS;
    expect(await store.purgeExpired()).toBe(1);
    expect(exists('id-copy-a.pdf')).toBe(false);
  });

  it('rejects writes to an unknown session', async () => {
    await expect(
      store.setSide('nope', 'front', 'scan-1.pdf'),
    ).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
    expect(() => store.setRotation('nope', 'front', 90)).toThrow(
      IdCopySessionNotFoundError,
    );
    await expect(
      store.setMerged('nope', 'id-copy-a.pdf', 't'),
    ).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
  });

  it('survives a file that is already gone', async () => {
    const session = store.create();
    const withFront = await store.setSide(
      session.id,
      'front',
      await writeScan('scan-1.pdf'),
    );
    await fs.promises.unlink(path.join(dir, withFront.front!.fileName));
    await expect(store.destroy(session.id)).resolves.toBeUndefined();
  });
});

describe('purgeIdCopyFiles', () => {
  it('deletes ID files and leaves other scans', async () => {
    await writeScan('id-side-0a1b.pdf');
    await writeScan('id-copy-2c3d.pdf');
    await writeScan('scan-123.pdf');
    expect(await purgeIdCopyFiles(dir)).toBe(2);
    expect(exists('id-side-0a1b.pdf')).toBe(false);
    expect(exists('id-copy-2c3d.pdf')).toBe(false);
    expect(exists('scan-123.pdf')).toBe(true);
  });

  it('returns 0 when the folder does not exist', async () => {
    expect(await purgeIdCopyFiles(path.join(dir, 'missing'))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/modules/scanner/id-copy-session.spec.ts`
Expected: FAIL with `Cannot find module './id-copy-session'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/scanner/id-copy-session.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IdRotation, IdSide } from '@/shared/id-card-layout';

/** An abandoned capture is removed quickly: the files are ID images. */
export const ID_COPY_INCOMPLETE_TTL_MS = 10 * 60 * 1000;
/** A finished sheet lives as long as a normal copy preview's release token. */
export const ID_COPY_COMPLETE_TTL_MS = 45 * 60 * 1000;

const ID_FILE_PATTERN = /^id-(side|copy)-[0-9a-f-]+\.pdf$/i;

export class IdCopySessionNotFoundError extends Error {
  constructor() {
    super('ID copy session not found.');
    this.name = 'IdCopySessionNotFoundError';
  }
}

export interface IdCopySideRecord {
  fileName: string;
  rotationDeg: IdRotation;
}

export interface IdCopySession {
  id: string;
  front: IdCopySideRecord | null;
  back: IdCopySideRecord | null;
  mergedFileName: string | null;
  releaseToken: string | null;
  touchedAt: number;
}

async function removeFile(dir: string, fileName: string): Promise<void> {
  try {
    await fs.promises.unlink(path.join(dir, fileName));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Leave it for the startup purge; never fail the customer's flow.
      console.warn(`[ID-COPY] Could not delete a session file (${code}).`);
    }
  }
}

export class IdCopySessionStore {
  private readonly sessions = new Map<string, IdCopySession>();
  private readonly scansDir: string;
  private readonly now: () => number;

  constructor(options: { scansDir: string; now?: () => number }) {
    this.scansDir = options.scansDir;
    this.now = options.now ?? Date.now;
  }

  create(): IdCopySession {
    const session: IdCopySession = {
      id: randomUUID(),
      front: null,
      back: null,
      mergedFileName: null,
      releaseToken: null,
      touchedAt: this.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<IdCopySession | null> {
    await this.purgeExpired();
    const session = this.sessions.get(id);
    if (!session) return null;
    session.touchedAt = this.now();
    return session;
  }

  async setSide(
    id: string,
    side: IdSide,
    scannedFileName: string,
  ): Promise<IdCopySession> {
    const session = this.require(id);
    const fileName = `id-side-${randomUUID()}.pdf`;
    await fs.promises.rename(
      path.join(this.scansDir, path.basename(scannedFileName)),
      path.join(this.scansDir, fileName),
    );
    const previous = session[side];
    session[side] = { fileName, rotationDeg: 0 };
    session.touchedAt = this.now();
    if (previous) await removeFile(this.scansDir, previous.fileName);
    return session;
  }

  setRotation(
    id: string,
    side: IdSide,
    rotationDeg: IdRotation,
  ): IdCopySession {
    const session = this.require(id);
    const record = session[side];
    if (record) record.rotationDeg = rotationDeg;
    session.touchedAt = this.now();
    return session;
  }

  async setMerged(
    id: string,
    fileName: string,
    releaseToken: string,
  ): Promise<string | null> {
    const session = this.require(id);
    const previous = session.mergedFileName;
    session.mergedFileName = fileName;
    session.releaseToken = releaseToken;
    session.touchedAt = this.now();
    if (previous && previous !== fileName) {
      await removeFile(this.scansDir, previous);
      return previous;
    }
    return null;
  }

  findByReleaseToken(token: string): IdCopySession | null {
    for (const session of this.sessions.values()) {
      if (session.releaseToken === token) return session;
    }
    return null;
  }

  async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    const files = [
      session.front?.fileName,
      session.back?.fileName,
      session.mergedFileName,
    ].filter((name): name is string => Boolean(name));
    for (const name of files) await removeFile(this.scansDir, name);
  }

  async purgeExpired(): Promise<number> {
    const now = this.now();
    const expired = [...this.sessions.values()].filter((session) => {
      const ttl =
        session.front && session.back
          ? ID_COPY_COMPLETE_TTL_MS
          : ID_COPY_INCOMPLETE_TTL_MS;
      return now - session.touchedAt >= ttl;
    });
    for (const session of expired) await this.destroy(session.id);
    return expired.length;
  }

  /** Deletes expired sessions on a timer. Returns a stop function. */
  startSweeper(intervalMs = 60_000): () => void {
    const timer = setInterval(() => {
      void this.purgeExpired();
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private require(id: string): IdCopySession {
    const session = this.sessions.get(id);
    if (!session) throw new IdCopySessionNotFoundError();
    return session;
  }
}

/** Removes ID side scans and merged sheets left by an earlier process. */
export async function purgeIdCopyFiles(scansDir: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(scansDir);
  } catch {
    return 0;
  }
  const targets = names.filter((name) => ID_FILE_PATTERN.test(name));
  for (const name of targets) await removeFile(scansDir, name);
  return targets.length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/modules/scanner/id-copy-session.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/scanner/id-copy-session.ts src/modules/scanner/id-copy-session.spec.ts
git commit -m "feat(copy): add ID copy session store"
```

---

### Task 5: Thumbnail renderer and scan content checks

**Files:**

- Create: `src/shared/id-copy-contract.ts`
- Modify: `src/services/document-analysis.ts` (`analyzePdfFile` loader block; new exported function)
- Test: `src/services/document-analysis-thumbnail.spec.ts`
- Create: `src/modules/scanner/id-copy-scan-checks.ts`
- Test: `src/modules/scanner/id-copy-scan-checks.spec.ts`

**Interfaces:**

- Consumes: `IdSide` from `@/shared/id-card-layout`.
- Produces:
  - In `src/shared/id-copy-contract.ts`:
    - `type IdScanWarningCode = 'side_blank' | 'sides_identical'`
    - `interface IdScanWarning { code: IdScanWarningCode; side: IdSide }`
    - `interface IdCopySheetResponse { detected: true; sessionId: string; sides: { front: boolean; back: boolean }; complete: boolean; previewPath: string; releaseToken: string; warnings: IdScanWarning[] }`
    - `interface IdCopyFailureResponse { detected: false; sessionId: string; code: string; error: string }`
    - `const ID_SESSION_EXPIRED_CODE = 'ID_SESSION_EXPIRED'`
  - In `src/services/document-analysis.ts`: `PDF_THUMBNAIL_SIZE` (32) and `renderPdfGrayThumbnail(pdfPath: string, size?: number): Promise<Uint8Array>` returning `size * size` gray levels, row-major, 0 black to 255 white.
  - In `src/modules/scanner/id-copy-scan-checks.ts`:
    - `ID_BLANK_STDDEV_THRESHOLD` (6), `ID_IDENTICAL_MEAN_DIFF_THRESHOLD` (8), `ID_CHECK_TIMEOUT_MS` (5000)
    - `grayStandardDeviation(thumbnail: Uint8Array): number`
    - `meanAbsoluteDifference(a: Uint8Array, b: Uint8Array): number`
    - `checkIdScan(input: { scannedSide: IdSide; frontPath: string | null; backPath: string | null }, deps: { thumbnail(filePath: string): Promise<Uint8Array>; timeoutMs?: number }): Promise<IdScanWarning[]>`

Why not `analyzeDocument`: its `isContentPixel` counts any pixel with a channel under 250 as content. A real scan of the empty lid is light gray, so it would never read as blank. The checks here measure contrast instead.

- [ ] **Step 1: Create the shared contract**

Create `src/shared/id-copy-contract.ts`:

```ts
/** Wire types for the ID copy endpoints, shared by the server and /copy. */
import type { IdSide } from './id-card-layout';

export type IdScanWarningCode = 'side_blank' | 'sides_identical';

export interface IdScanWarning {
  code: IdScanWarningCode;
  side: IdSide;
}

export interface IdCopySheetResponse {
  detected: true;
  sessionId: string;
  sides: { front: boolean; back: boolean };
  complete: boolean;
  previewPath: string;
  releaseToken: string;
  warnings: IdScanWarning[];
}

export interface IdCopyFailureResponse {
  detected: false;
  sessionId: string;
  code: string;
  error: string;
}

export const ID_SESSION_EXPIRED_CODE = 'ID_SESSION_EXPIRED';
```

- [ ] **Step 2: Write the failing thumbnail test**

Create `src/services/document-analysis-thumbnail.spec.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import {
  PDF_THUMBNAIL_SIZE,
  renderPdfGrayThumbnail,
} from './document-analysis';

let dir: string;

async function writePdf(name: string, leftHalfBlack: boolean): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([283, 283]);
  if (leftHalfBlack) {
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 141.5,
      height: 283,
      color: rgb(0, 0, 0),
    });
  }
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, await doc.save());
  return filePath;
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdf-thumb-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('renderPdfGrayThumbnail', () => {
  it('returns one gray level per cell', async () => {
    const thumbnail = await renderPdfGrayThumbnail(
      await writePdf('half.pdf', true),
    );
    expect(thumbnail).toHaveLength(PDF_THUMBNAIL_SIZE * PDF_THUMBNAIL_SIZE);
  });

  it('is dark where the page is dark and light where it is empty', async () => {
    const thumbnail = await renderPdfGrayThumbnail(
      await writePdf('half.pdf', true),
    );
    const row = 16 * PDF_THUMBNAIL_SIZE;
    expect(thumbnail[row + 4]).toBeLessThan(60);
    expect(thumbnail[row + 28]).toBeGreaterThan(200);
  });

  it('is light everywhere for an empty page', async () => {
    const thumbnail = await renderPdfGrayThumbnail(
      await writePdf('empty.pdf', false),
    );
    expect(Math.min(...thumbnail)).toBeGreaterThan(240);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec jest src/services/document-analysis-thumbnail.spec.ts`
Expected: FAIL, `renderPdfGrayThumbnail` is not exported from `./document-analysis`.

- [ ] **Step 4: Extract the pdf.js loader and add the thumbnail renderer**

In `src/services/document-analysis.ts`, inside `analyzePdfFile`, replace this block (from `let pdfjs: PdfjsLib;` through the closing brace of the outer `catch`, just above `const data = new Uint8Array(await fs.promises.readFile(pdfPath));`):

```ts
let pdfjs: PdfjsLib;
let canvasFactory: CanvasFactory = (w: number, h: number) => createCanvas(w, h);
try {
  const nativeRequire = createRequire(
    typeof __filename !== 'undefined'
      ? __filename
      : path.join(process.cwd(), 'index.js'),
  );
  pdfjs = nativeRequire('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsLib;
  try {
    const pdfjsPath = nativeRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjsReq = createRequire(pdfjsPath);
    const napiCanvas = pdfjsReq('@napi-rs/canvas') as {
      createCanvas?: (w: number, h: number) => CanvasInstance;
    };
    if (napiCanvas && typeof napiCanvas.createCanvas === 'function') {
      const factory = napiCanvas.createCanvas;
      canvasFactory = (w: number, h: number) => factory(w, h);
    }
  } catch {
    // Keep default createCanvas
  }
} catch {
  pdfjs =
    (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsLib;
}
```

with:

```ts
const { pdfjs, canvasFactory } = await loadPdfjsForNode();
```

Then add these two functions directly above `async function analyzePdfFile(`. The body of `loadPdfjsForNode` is the block removed above, unchanged, plus the `return`:

```ts
/** pdf.js for Node plus a canvas factory it can render into. */
async function loadPdfjsForNode(): Promise<{
  pdfjs: PdfjsLib;
  canvasFactory: CanvasFactory;
}> {
  let pdfjs: PdfjsLib;
  let canvasFactory: CanvasFactory = (w: number, h: number) =>
    createCanvas(w, h);
  try {
    const nativeRequire = createRequire(
      typeof __filename !== 'undefined'
        ? __filename
        : path.join(process.cwd(), 'index.js'),
    );
    pdfjs = nativeRequire('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsLib;
    try {
      const pdfjsPath = nativeRequire.resolve(
        'pdfjs-dist/legacy/build/pdf.mjs',
      );
      const pdfjsReq = createRequire(pdfjsPath);
      const napiCanvas = pdfjsReq('@napi-rs/canvas') as {
        createCanvas?: (w: number, h: number) => CanvasInstance;
      };
      if (napiCanvas && typeof napiCanvas.createCanvas === 'function') {
        const factory = napiCanvas.createCanvas;
        canvasFactory = (w: number, h: number) => factory(w, h);
      }
    } catch {
      // Keep default createCanvas
    }
  } catch {
    pdfjs =
      (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsLib;
  }
  return { pdfjs, canvasFactory };
}

export const PDF_THUMBNAIL_SIZE = 32;
const THUMBNAIL_OVERSAMPLE = 8;

/**
 * First page of a PDF as `size * size` gray levels (0 black, 255 white),
 * row-major. Rendered larger and box-averaged so small shifts of the content
 * change the result only a little.
 */
export async function renderPdfGrayThumbnail(
  pdfPath: string,
  size: number = PDF_THUMBNAIL_SIZE,
): Promise<Uint8Array> {
  const { pdfjs, canvasFactory } = await loadPdfjsForNode();
  const data = new Uint8Array(await fs.promises.readFile(pdfPath));
  const loadingTask = pdfjs.getDocument({ data, verbosity: 0 });
  try {
    const doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const renderSide = size * THUMBNAIL_OVERSAMPLE;
    const viewport = page.getViewport({
      scale: renderSide / Math.max(base.width, base.height),
    });
    const width = Math.max(1, Math.min(renderSide, Math.round(viewport.width)));
    const height = Math.max(
      1,
      Math.min(renderSide, Math.round(viewport.height)),
    );
    const canvas = canvasFactory(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not available');
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const rgba = ctx.getImageData(0, 0, width, height).data;
    page.cleanup();

    const sums = new Float64Array(size * size);
    const counts = new Uint32Array(size * size);
    for (let y = 0; y < height; y += 1) {
      const cellY = Math.min(size - 1, Math.floor(y / THUMBNAIL_OVERSAMPLE));
      for (let x = 0; x < width; x += 1) {
        const cellX = Math.min(size - 1, Math.floor(x / THUMBNAIL_OVERSAMPLE));
        const offset = (y * width + x) * 4;
        const alpha = rgba[offset + 3] / 255;
        const gray =
          0.299 * rgba[offset] +
          0.587 * rgba[offset + 1] +
          0.114 * rgba[offset + 2];
        const cell = cellY * size + cellX;
        sums[cell] += gray * alpha + 255 * (1 - alpha);
        counts[cell] += 1;
      }
    }

    const thumbnail = new Uint8Array(size * size);
    for (let cell = 0; cell < thumbnail.length; cell += 1) {
      thumbnail[cell] =
        counts[cell] === 0 ? 255 : Math.round(sums[cell] / counts[cell]);
    }
    return thumbnail;
  } finally {
    await loadingTask.destroy();
  }
}
```

- [ ] **Step 5: Run the thumbnail test and the existing analysis tests**

Run: `pnpm exec jest src/services/document-analysis-thumbnail.spec.ts src/services/document-analysis.spec.ts src/services/document-analysis-thread.spec.ts`
Expected: PASS. The two existing spec files must pass unchanged; they prove the loader extraction did not alter analysis.

- [ ] **Step 6: Write the failing checks test**

Create `src/modules/scanner/id-copy-scan-checks.spec.ts`:

```ts
import {
  ID_BLANK_STDDEV_THRESHOLD,
  ID_IDENTICAL_MEAN_DIFF_THRESHOLD,
  checkIdScan,
  grayStandardDeviation,
  meanAbsoluteDifference,
} from './id-copy-scan-checks';

const SIZE = 32;
const LID = 235;
const CARD = 135;
const INK = 40;

function thumb(paint: (x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) out[y * SIZE + x] = paint(x, y);
  }
  return out;
}

// An 85.6 x 54 mm card is about 27 x 17 cells of a 100 mm, 32-cell thumbnail.
const inCard = (x: number, y: number, shift = 0) =>
  x >= shift && x < 27 + shift && y < 17;

/** Card with a photo block on the left. */
const front = (shift = 0) =>
  thumb((x, y) => {
    if (!inCard(x, y, shift)) return LID;
    return x - shift < 8 && y >= 3 && y < 15 ? INK : CARD;
  });

/** Card with a stripe near the bottom. */
const back = () =>
  thumb((x, y) => {
    if (!inCard(x, y)) return LID;
    return y >= 12 && y < 15 && x >= 5 && x < 21 ? INK : CARD;
  });

/** Empty glass: light gray with gentle lid shading, not pure white. */
const emptyGlass = () => thumb((x) => 236 + Math.round((x / 31) * 8));

function depsFor(files: Record<string, Uint8Array>) {
  return {
    thumbnail: async (filePath: string) => {
      const found = files[filePath];
      if (!found) throw new Error('no thumbnail');
      return found;
    },
  };
}

describe('grayStandardDeviation', () => {
  it('is low for empty glass and high for a card', () => {
    expect(grayStandardDeviation(emptyGlass())).toBeLessThan(
      ID_BLANK_STDDEV_THRESHOLD,
    );
    expect(grayStandardDeviation(front())).toBeGreaterThan(
      ID_BLANK_STDDEV_THRESHOLD,
    );
  });

  it('is 0 for an empty array', () => {
    expect(grayStandardDeviation(new Uint8Array(0))).toBe(0);
  });
});

describe('meanAbsoluteDifference', () => {
  it('is 0 for equal thumbnails', () => {
    expect(meanAbsoluteDifference(front(), front())).toBe(0);
  });

  it('stays under the threshold when the same side moved one cell', () => {
    expect(meanAbsoluteDifference(front(), front(1))).toBeLessThan(
      ID_IDENTICAL_MEAN_DIFF_THRESHOLD,
    );
  });

  it('is over the threshold for two different sides', () => {
    expect(meanAbsoluteDifference(front(), back())).toBeGreaterThan(
      ID_IDENTICAL_MEAN_DIFF_THRESHOLD,
    );
  });
});

describe('checkIdScan', () => {
  it('flags an empty scan as side_blank', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'front', frontPath: 'f', backPath: null },
      depsFor({ f: emptyGlass() }),
    );
    expect(warnings).toEqual([{ code: 'side_blank', side: 'front' }]);
  });

  it('reports only side_blank when both scans are empty', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'back', frontPath: 'f', backPath: 'b' },
      depsFor({ f: emptyGlass(), b: emptyGlass() }),
    );
    expect(warnings).toEqual([{ code: 'side_blank', side: 'back' }]);
  });

  it('flags the same side scanned twice', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'back', frontPath: 'f', backPath: 'b' },
      depsFor({ f: front(), b: front(1) }),
    );
    expect(warnings).toEqual([{ code: 'sides_identical', side: 'back' }]);
  });

  it('is quiet for a real front and back', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'back', frontPath: 'f', backPath: 'b' },
      depsFor({ f: front(), b: back() }),
    );
    expect(warnings).toEqual([]);
  });

  it('is quiet for a single good side', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'front', frontPath: 'f', backPath: null },
      depsFor({ f: front() }),
    );
    expect(warnings).toEqual([]);
  });

  it('returns no warning when the thumbnail fails', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'front', frontPath: 'f', backPath: null },
      depsFor({}),
    );
    expect(warnings).toEqual([]);
  });

  it('returns no warning when the thumbnail hangs', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'front', frontPath: 'f', backPath: null },
      { thumbnail: () => new Promise<Uint8Array>(() => {}), timeoutMs: 20 },
    );
    expect(warnings).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm exec jest src/modules/scanner/id-copy-scan-checks.spec.ts`
Expected: FAIL with `Cannot find module './id-copy-scan-checks'`.

- [ ] **Step 8: Write the checks**

Create `src/modules/scanner/id-copy-scan-checks.ts`:

```ts
import type { IdSide } from '@/shared/id-card-layout';
import type { IdScanWarning } from '@/shared/id-copy-contract';

/**
 * Gray-level spread under this means "nothing on the glass". Empty glass scans
 * as an even light gray. Tune on the real scanner (see the hardware checklist).
 */
export const ID_BLANK_STDDEV_THRESHOLD = 6;
/** Mean gray difference under this means "the same side twice". Tune likewise. */
export const ID_IDENTICAL_MEAN_DIFF_THRESHOLD = 8;
export const ID_CHECK_TIMEOUT_MS = 5000;

export function grayStandardDeviation(thumbnail: Uint8Array): number {
  if (thumbnail.length === 0) return 0;
  let sum = 0;
  for (const value of thumbnail) sum += value;
  const mean = sum / thumbnail.length;
  let squares = 0;
  for (const value of thumbnail) squares += (value - mean) ** 2;
  return Math.sqrt(squares / thumbnail.length);
}

export function meanAbsoluteDifference(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 255;
  let total = 0;
  for (let i = 0; i < length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / length;
}

export interface IdScanCheckInput {
  scannedSide: IdSide;
  frontPath: string | null;
  backPath: string | null;
}

export interface IdScanCheckDeps {
  thumbnail(filePath: string): Promise<Uint8Array>;
  timeoutMs?: number;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ID scan check timed out')),
      timeoutMs,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Warnings for the side just scanned. Never throws: a failed or slow check
 * yields no warning, because a warning must never cost the customer a scan.
 */
export async function checkIdScan(
  input: IdScanCheckInput,
  deps: IdScanCheckDeps,
): Promise<IdScanWarning[]> {
  const scannedPath =
    input.scannedSide === 'front' ? input.frontPath : input.backPath;
  const otherPath =
    input.scannedSide === 'front' ? input.backPath : input.frontPath;
  if (!scannedPath) return [];
  const timeoutMs = deps.timeoutMs ?? ID_CHECK_TIMEOUT_MS;

  try {
    const scanned = await withTimeout(deps.thumbnail(scannedPath), timeoutMs);
    if (grayStandardDeviation(scanned) < ID_BLANK_STDDEV_THRESHOLD) {
      return [{ code: 'side_blank', side: input.scannedSide }];
    }
    if (!otherPath) return [];
    const other = await withTimeout(deps.thumbnail(otherPath), timeoutMs);
    if (
      meanAbsoluteDifference(scanned, other) < ID_IDENTICAL_MEAN_DIFF_THRESHOLD
    ) {
      return [{ code: 'sides_identical', side: input.scannedSide }];
    }
    return [];
  } catch (error) {
    console.warn(
      '[ID-COPY] Scan check skipped:',
      error instanceof Error ? error.message : 'unknown error',
    );
    return [];
  }
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm exec jest src/modules/scanner/id-copy-scan-checks.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 10: Commit**

```bash
git add src/shared/id-copy-contract.ts src/services/document-analysis.ts src/services/document-analysis-thumbnail.spec.ts src/modules/scanner/id-copy-scan-checks.ts src/modules/scanner/id-copy-scan-checks.spec.ts
git commit -m "feat(copy): add ID scan content checks"
```

---

### Task 6: ID copy service and endpoints

**Files:**

- Create: `src/modules/scanner/id-copy.service.ts`
- Test: `src/modules/scanner/id-copy.service.spec.ts`
- Modify: `src/modules/scanner/copy-preview-settings.ts`, `src/modules/scanner/copy-preview-settings.spec.ts`
- Modify: `src/services/job-store.ts` (`ScanJobSettings.paperSize`)
- Modify: `src/modules/scanner/scanner.service.ts`
- Modify: `src/modules/scanner/scanner.controller.ts`
- Modify: `src/modules/scanner/scanner.module.ts`

**Interfaces:**

- Consumes: `composeIdSheet` (Task 3); `IdCopySessionStore`, `IdCopySessionNotFoundError`, `purgeIdCopyFiles` (Task 4); `checkIdScan`, `renderPdfGrayThumbnail`, contract types (Task 5).
- Produces:
  - `class IdCopyService` with `constructor(deps: IdCopyServiceDeps)` and:
    - `scanSide(input: { sessionId?: string | null; side: IdSide; paperSize: PaperSize }): Promise<IdCopySheetResponse | IdCopyFailureResponse>`
    - `compose(input: { sessionId: string; paperSize: PaperSize; rotations: Partial<Record<IdSide, IdRotation>> }): Promise<IdCopySheetResponse>`
    - `releaseByToken(token: string): Promise<{ fileName: string } | null>`
  - `parseIdRotations(raw: unknown): Partial<Record<IdSide, IdRotation>> | null` (null when any given value is not 0, 90, 180 or 270)
  - `buildIdCopyScanSettings(cfg)` in `copy-preview-settings.ts`
  - HTTP: `POST /api/scan/id-copy/side`, `POST /api/scan/id-copy/compose`; `POST /api/scanner/release` frees an ID session.

A `sessionId` that the server does not know makes `scanSide` and `compose` throw `IdCopySessionNotFoundError` (HTTP 409). A new session is created only when no `sessionId` is sent. This differs from the spec's "absent or unknown": creating a fresh session for a back scan would silently lose the front.

- [ ] **Step 1: Write the failing service test**

Create `src/modules/scanner/id-copy.service.spec.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { IdCopyService, parseIdRotations } from './id-copy.service';
import {
  IdCopySessionNotFoundError,
  IdCopySessionStore,
} from './id-copy-session';

let dir: string;
let sessions: IdCopySessionStore;
let service: IdCopyService;
let scanShouldFail: boolean;
let scanCount: number;
let thumbnailFor: (filePath: string) => Uint8Array;
const tokens = new Map<string, string>();
const invalidated: string[] = [];

/** A thumbnail with a dark block whose position depends on `seed`. */
function patterned(seed: number): Uint8Array {
  const out = new Uint8Array(1024).fill(230);
  const start = (seed % 4) * 200;
  for (let i = start; i < start + 180; i += 1) out[i] = 30;
  return out;
}

const exists = (name: string) => fs.existsSync(path.join(dir, name));

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'id-service-'));
  sessions = new IdCopySessionStore({ scansDir: dir });
  scanShouldFail = false;
  scanCount = 0;
  tokens.clear();
  invalidated.length = 0;
  const seeds = new Map<string, number>();
  thumbnailFor = (filePath) => {
    if (!seeds.has(filePath)) seeds.set(filePath, seeds.size);
    return patterned(seeds.get(filePath)!);
  };
  service = new IdCopyService({
    scansDir: dir,
    sessions,
    scanIdRegion: async () => {
      if (scanShouldFail) throw new Error('scanner busy');
      scanCount += 1;
      const doc = await PDFDocument.create();
      doc.addPage([283, 283]);
      const outputPath = path.join(dir, `scan-${scanCount}.pdf`);
      await fs.promises.writeFile(outputPath, await doc.save());
      return { outputPath };
    },
    describeFailure: () => ({
      code: 'SCANNER_BUSY',
      error: 'The scanner is busy.',
    }),
    registerReleaseToken: (fileName) => {
      const token = `token-${tokens.size + 1}`;
      tokens.set(token, fileName);
      return token;
    },
    invalidateReleaseTokens: (fileName) => {
      invalidated.push(fileName);
    },
    thumbnail: async (filePath) => thumbnailFor(filePath),
  });
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('IdCopyService.scanSide', () => {
  it('creates a session and a front-only sheet', async () => {
    const result = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!result.detected) throw new Error('expected a sheet');
    expect(result.sides).toEqual({ front: true, back: false });
    expect(result.complete).toBe(false);
    expect(result.previewPath).toMatch(/^id-copy-[0-9a-f-]+\.pdf$/);
    expect(exists(result.previewPath)).toBe(true);
    expect(tokens.get(result.releaseToken)).toBe(result.previewPath);
    expect(result.warnings).toEqual([]);
  });

  it('completes on the back scan and replaces the merged file', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    const second = await service.scanSide({
      sessionId: first.sessionId,
      side: 'back',
      paperSize: 'A4',
    });
    if (!second.detected) throw new Error('expected a sheet');
    expect(second.complete).toBe(true);
    expect(second.previewPath).not.toBe(first.previewPath);
    expect(exists(first.previewPath)).toBe(false);
    expect(invalidated).toContain(first.previewPath);
    const doc = await PDFDocument.load(
      await fs.promises.readFile(path.join(dir, second.previewPath)),
    );
    expect(doc.getPageCount()).toBe(1);
  });

  it('keeps the front and the session when the back scan fails', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    scanShouldFail = true;
    const failed = await service.scanSide({
      sessionId: first.sessionId,
      side: 'back',
      paperSize: 'A4',
    });
    expect(failed).toEqual({
      detected: false,
      sessionId: first.sessionId,
      code: 'SCANNER_BUSY',
      error: 'The scanner is busy.',
    });
    expect(exists(first.previewPath)).toBe(true);
    const sheet = await service.compose({
      sessionId: first.sessionId,
      paperSize: 'A4',
      rotations: {},
    });
    expect(sheet.sides).toEqual({ front: true, back: false });
  });

  it('resets only the retaken side when a rotated front is rescanned', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    await service.scanSide({
      sessionId: first.sessionId,
      side: 'back',
      paperSize: 'A4',
    });
    await service.compose({
      sessionId: first.sessionId,
      paperSize: 'A4',
      rotations: { front: 180, back: 90 },
    });
    await service.scanSide({
      sessionId: first.sessionId,
      side: 'front',
      paperSize: 'A4',
    });
    const session = (await sessions.get(first.sessionId))!;
    expect(session.front!.rotationDeg).toBe(0);
    expect(session.back!.rotationDeg).toBe(90);
  });

  it('rejects a session id the server does not know', async () => {
    await expect(
      service.scanSide({ sessionId: 'gone', side: 'back', paperSize: 'A4' }),
    ).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
    expect(scanCount).toBe(0);
  });

  it('passes scan warnings through', async () => {
    thumbnailFor = () => new Uint8Array(1024).fill(238);
    const result = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!result.detected) throw new Error('expected a sheet');
    expect(result.warnings).toEqual([{ code: 'side_blank', side: 'front' }]);
  });
});

describe('IdCopyService.compose', () => {
  it('rebuilds for another paper size without scanning', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    const sheet = await service.compose({
      sessionId: first.sessionId,
      paperSize: 'Long',
      rotations: {},
    });
    expect(scanCount).toBe(1);
    const doc = await PDFDocument.load(
      await fs.promises.readFile(path.join(dir, sheet.previewPath)),
    );
    expect(doc.getPage(0).getSize().height).toBeCloseTo(936, 1);
  });

  it('rejects an unknown session', async () => {
    await expect(
      service.compose({ sessionId: 'gone', paperSize: 'A4', rotations: {} }),
    ).rejects.toBeInstanceOf(IdCopySessionNotFoundError);
  });
});

describe('IdCopyService.releaseByToken', () => {
  it('deletes the sheet and both sides, once', async () => {
    const first = await service.scanSide({ side: 'front', paperSize: 'A4' });
    if (!first.detected) throw new Error('expected a sheet');
    const second = await service.scanSide({
      sessionId: first.sessionId,
      side: 'back',
      paperSize: 'A4',
    });
    if (!second.detected) throw new Error('expected a sheet');

    const released = await service.releaseByToken(second.releaseToken);

    expect(released).toEqual({ fileName: second.previewPath });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await service.releaseByToken(second.releaseToken)).toBeNull();
  });

  it('returns null for a token that is not an ID session', async () => {
    expect(await service.releaseByToken('other')).toBeNull();
  });
});

describe('parseIdRotations', () => {
  it('accepts quarter turns and missing sides', () => {
    expect(parseIdRotations({ front: 90, back: 270 })).toEqual({
      front: 90,
      back: 270,
    });
    expect(parseIdRotations({ back: 0 })).toEqual({ back: 0 });
    expect(parseIdRotations(undefined)).toEqual({});
    expect(parseIdRotations(null)).toEqual({});
  });

  it('rejects anything that is not a quarter turn', () => {
    expect(parseIdRotations({ front: 45 })).toBeNull();
    expect(parseIdRotations({ back: '90' })).toBeNull();
    expect(parseIdRotations('front')).toBeNull();
    expect(parseIdRotations([90])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/modules/scanner/id-copy.service.spec.ts`
Expected: FAIL with `Cannot find module './id-copy.service'`.

- [ ] **Step 3: Write the service**

Create `src/modules/scanner/id-copy.service.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IdRotation, IdSide } from '@/shared/id-card-layout';
import type {
  IdCopyFailureResponse,
  IdCopySheetResponse,
} from '@/shared/id-copy-contract';
import type { PaperSize } from '@/shared/print-configuration';
import { composeIdSheet } from './id-copy-compose';
import { checkIdScan } from './id-copy-scan-checks';
import {
  IdCopySessionNotFoundError,
  type IdCopySession,
  type IdCopySessionStore,
  type IdCopySideRecord,
} from './id-copy-session';

export interface IdCopyServiceDeps {
  scansDir: string;
  sessions: IdCopySessionStore;
  /** Scans the ID region on the glass. Throws when the scan fails. */
  scanIdRegion(): Promise<{ outputPath: string }>;
  describeFailure(error: unknown): { code: string; error: string };
  registerReleaseToken(fileName: string): string;
  invalidateReleaseTokens(fileName: string): void;
  thumbnail(filePath: string): Promise<Uint8Array>;
}

const QUARTER_TURNS = new Set<unknown>([0, 90, 180, 270]);

/** Rotations from a request body. Null when a given value is not a quarter turn. */
export function parseIdRotations(
  raw: unknown,
): Partial<Record<IdSide, IdRotation>> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const parsed: Partial<Record<IdSide, IdRotation>> = {};
  for (const side of ['front', 'back'] as const) {
    const value = source[side];
    if (value === undefined) continue;
    if (!QUARTER_TURNS.has(value)) return null;
    parsed[side] = value as IdRotation;
  }
  return parsed;
}

export class IdCopyService {
  constructor(private readonly deps: IdCopyServiceDeps) {}

  async scanSide(input: {
    sessionId?: string | null;
    side: IdSide;
    paperSize: PaperSize;
  }): Promise<IdCopySheetResponse | IdCopyFailureResponse> {
    const session = input.sessionId
      ? await this.requireSession(input.sessionId)
      : this.deps.sessions.create();

    let scanned: { outputPath: string };
    try {
      scanned = await this.deps.scanIdRegion();
    } catch (error) {
      const failure = this.deps.describeFailure(error);
      return {
        detected: false,
        sessionId: session.id,
        code: failure.code,
        error: failure.error,
      };
    }

    await this.deps.sessions.setSide(
      session.id,
      input.side,
      path.basename(scanned.outputPath),
    );
    const sheet = await this.rebuild(session, input.paperSize);
    const warnings = await checkIdScan(
      {
        scannedSide: input.side,
        frontPath: this.sidePath(session.front),
        backPath: this.sidePath(session.back),
      },
      { thumbnail: this.deps.thumbnail },
    );
    return { ...sheet, warnings };
  }

  async compose(input: {
    sessionId: string;
    paperSize: PaperSize;
    rotations: Partial<Record<IdSide, IdRotation>>;
  }): Promise<IdCopySheetResponse> {
    const session = await this.requireSession(input.sessionId);
    for (const side of ['front', 'back'] as const) {
      const rotation = input.rotations[side];
      if (rotation !== undefined) {
        this.deps.sessions.setRotation(session.id, side, rotation);
      }
    }
    return this.rebuild(session, input.paperSize);
  }

  /** Frees a whole ID session. Null when the token is not an ID session's. */
  async releaseByToken(token: string): Promise<{ fileName: string } | null> {
    const session = this.deps.sessions.findByReleaseToken(token);
    if (!session) return null;
    const merged = session.mergedFileName;
    await this.deps.sessions.destroy(session.id);
    if (merged) this.deps.invalidateReleaseTokens(merged);
    return { fileName: merged ?? '' };
  }

  private async requireSession(sessionId: string): Promise<IdCopySession> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session) throw new IdCopySessionNotFoundError();
    return session;
  }

  private sidePath(record: IdCopySideRecord | null): string | null {
    return record ? path.join(this.deps.scansDir, record.fileName) : null;
  }

  private async rebuild(
    session: IdCopySession,
    paperSize: PaperSize,
  ): Promise<IdCopySheetResponse> {
    const side = (record: IdCopySideRecord | null) =>
      record
        ? {
            filePath: path.join(this.deps.scansDir, record.fileName),
            rotationDeg: record.rotationDeg,
          }
        : null;
    const bytes = await composeIdSheet({
      paperSize,
      front: side(session.front),
      back: side(session.back),
    });
    const fileName = `id-copy-${randomUUID()}.pdf`;
    await fs.promises.writeFile(path.join(this.deps.scansDir, fileName), bytes);
    const releaseToken = this.deps.registerReleaseToken(fileName);
    const previous = await this.deps.sessions.setMerged(
      session.id,
      fileName,
      releaseToken,
    );
    if (previous) this.deps.invalidateReleaseTokens(previous);
    return {
      detected: true,
      sessionId: session.id,
      sides: { front: Boolean(session.front), back: Boolean(session.back) },
      complete: Boolean(session.front && session.back),
      previewPath: fileName,
      releaseToken,
      warnings: [],
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/modules/scanner/id-copy.service.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Add the ID scan settings (test first)**

Append to `src/modules/scanner/copy-preview-settings.spec.ts`, and add `buildIdCopyScanSettings` to its import:

```ts
describe('buildIdCopyScanSettings', () => {
  it('scans the ID region on the glass at the admin copy DPI', () => {
    expect(buildIdCopyScanSettings({ copyGlass: 600, copyAdf: 150 })).toEqual({
      source: 'flatbed',
      dpi: 600,
      colorMode: 'colored',
      duplex: false,
      format: 'pdf',
      paperSize: 'IdCard',
      maxPages: 1,
    });
  });

  it('defaults to 300 DPI', () => {
    expect(buildIdCopyScanSettings(undefined).dpi).toBe(300);
  });
});
```

Run: `pnpm exec jest src/modules/scanner/copy-preview-settings.spec.ts`
Expected: FAIL, `buildIdCopyScanSettings` is not exported.

Append to `src/modules/scanner/copy-preview-settings.ts`:

```ts
/**
 * Settings for one side of an ID card: the small region at the glass origin
 * corner. Always the flatbed and always colour; grayscale is applied at print.
 */
export function buildIdCopyScanSettings(
  cfg: ScannerDpiConfig | null | undefined,
) {
  return {
    source: 'flatbed' as const,
    dpi: resolveScannerDpi(cfg, 'copy', 'flatbed'),
    colorMode: 'colored' as const,
    duplex: false,
    format: 'pdf' as const,
    paperSize: 'IdCard' as const,
    maxPages: 1,
  };
}
```

In `src/services/job-store.ts`, in `interface ScanJobSettings`, change:

```ts
paperSize: 'A4' | 'Short' | 'Long';
```

to:

```ts
paperSize: 'A4' | 'Short' | 'Long' | 'IdCard';
```

Run: `pnpm exec jest src/modules/scanner/copy-preview-settings.spec.ts`
Expected: PASS.

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors. If a line reports that `'IdCard'` is not assignable to `'A4' | 'Short' | 'Long'`, that line reads `ScanJobSettings.paperSize` into a narrower type; change the narrower type at that line to `ScanJobSettings['paperSize']`.

- [ ] **Step 6: Wire the service into `ScannerService`**

In `src/modules/scanner/scanner.service.ts`:

Change the `document-analysis` import to:

```ts
import {
  analyzeDocument,
  renderPdfGrayThumbnail,
} from '@/services/document-analysis';
```

Change the `copy-preview-settings` import to:

```ts
import {
  buildCopyPreviewScanSettings,
  buildIdCopyScanSettings,
  resolveScannerDpi,
} from './copy-preview-settings';
```

Add after the `scan-preview-failure` import:

```ts
import type { IdRotation, IdSide } from '@/shared/id-card-layout';
import type {
  IdCopyFailureResponse,
  IdCopySheetResponse,
} from '@/shared/id-copy-contract';
import { IdCopyService } from './id-copy.service';
import { IdCopySessionStore, purgeIdCopyFiles } from './id-copy-session';
```

In `class ScannerService`, add after `private readonly receiptService = new ReceiptService();`:

```ts
  private readonly idCopySessions = new IdCopySessionStore({
    scansDir: path.resolve('uploads', 'scans'),
  });
  private readonly idCopy = new IdCopyService({
    scansDir: path.resolve('uploads', 'scans'),
    sessions: this.idCopySessions,
    scanIdRegion: () =>
      getAdapter().scan(
        buildIdCopyScanSettings(db.data?.settings?.scannerDpi),
        'uploads/scans',
      ),
    describeFailure: (error) => {
      const failure = describeScanPreviewFailure(error, 'flatbed');
      void adminService.appendAdminLog(
        'scan_preview_failed',
        'ID copy scan failed.',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          code: failure.code,
          source: 'flatbed',
        },
      );
      return { code: failure.code, error: failure.error };
    },
    registerReleaseToken: (fileName) => this.registerReleaseToken(fileName),
    invalidateReleaseTokens: (fileName) =>
      this.invalidateReleaseTokensForFilename(fileName),
    thumbnail: (filePath) => renderPdfGrayThumbnail(filePath),
  });
```

Add these methods directly above `getPreviewPath(filename: string)`:

```ts
  /** Deletes ID files left by an earlier process and starts the expiry timer. */
  startIdCopyHousekeeping(): void {
    void purgeIdCopyFiles(path.resolve('uploads', 'scans'));
    this.idCopySessions.startSweeper();
  }

  async scanIdCopySide(input: {
    sessionId?: string | null;
    side: IdSide;
    paperSize: string;
  }): Promise<IdCopySheetResponse | IdCopyFailureResponse> {
    if (!VALID_PAPER_SIZES.has(input.paperSize)) {
      throw new Error('Invalid paperSize. Accepted: "A4", "Short", "Long"');
    }
    return this.idCopy.scanSide({
      sessionId: input.sessionId,
      side: input.side,
      paperSize: normalizeScannerPaperSize(input.paperSize),
    });
  }

  async composeIdCopy(input: {
    sessionId: string;
    paperSize: string;
    rotations: Partial<Record<IdSide, IdRotation>>;
  }): Promise<IdCopySheetResponse> {
    if (!VALID_PAPER_SIZES.has(input.paperSize)) {
      throw new Error('Invalid paperSize. Accepted: "A4", "Short", "Long"');
    }
    return this.idCopy.compose({
      sessionId: input.sessionId,
      paperSize: normalizeScannerPaperSize(input.paperSize),
      rotations: input.rotations,
    });
  }
```

In `releaseScanFileByToken`, directly after the first `if (!token) { throw new Error('Invalid release token.'); }` block, add:

```ts
const idRelease = await this.idCopy.releaseByToken(token);
if (idRelease) {
  this.releaseTokens.delete(token);
  return {
    deleted: true,
    alreadyMissing: false,
    fileName: idRelease.fileName,
  };
}
```

- [ ] **Step 7: Add the endpoints**

In `src/modules/scanner/scanner.controller.ts`:

Add to the imports:

```ts
import { ID_SESSION_EXPIRED_CODE } from '@/shared/id-copy-contract';
import { parseIdRotations } from './id-copy.service';
import { IdCopySessionNotFoundError } from './id-copy-session';
```

In `initializeRoutes`, after the `/api/scan/preview/:filename` line, add:

```ts
this.router.post('/api/scan/id-copy/side', this.scanIdCopySide);
this.router.post('/api/scan/id-copy/compose', this.composeIdCopy);
```

Add these members directly above `private getPreviewFile =`:

```ts
  private respondIdCopyError(res: Response, error: unknown): void {
    if (error instanceof IdCopySessionNotFoundError) {
      res.status(409).json({
        code: ID_SESSION_EXPIRED_CODE,
        error: 'Your ID scan session expired. Please scan your ID again.',
      });
      return;
    }
    const message = this.getErrorMessage(error, 'ID copy failed.');
    if (message.startsWith('Invalid paperSize')) {
      res.status(400).json({ error: message });
      return;
    }
    console.error('[ID-COPY] Request failed:', message);
    res.status(500).json({ error: 'Could not prepare the ID copy. Please try again.' });
  }

  private scanIdCopySide = async (req: Request, res: Response): Promise<void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    const body = (req.body ?? {}) as {
      sessionId?: unknown;
      side?: unknown;
      paperSize?: unknown;
    };
    if (body.side !== 'front' && body.side !== 'back') {
      res.status(400).json({ error: 'Invalid side. Accepted: "front", "back"' });
      return;
    }
    const sessionId =
      typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : null;

    try {
      const result = await this.scannerService.scanIdCopySide({
        sessionId,
        side: body.side,
        paperSize: typeof body.paperSize === 'string' ? body.paperSize : 'A4',
      });
      res.json(result);
    } catch (error) {
      this.respondIdCopyError(res, error);
    }
  };

  private composeIdCopy = async (req: Request, res: Response): Promise<void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    const body = (req.body ?? {}) as {
      sessionId?: unknown;
      paperSize?: unknown;
      rotations?: unknown;
    };
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      res.status(400).json({ error: 'Missing sessionId.' });
      return;
    }
    const rotations = parseIdRotations(body.rotations);
    if (!rotations) {
      res.status(400).json({
        error: 'Invalid rotation. Accepted values: 0, 90, 180, 270.',
      });
      return;
    }

    try {
      const result = await this.scannerService.composeIdCopy({
        sessionId: body.sessionId.trim(),
        paperSize: typeof body.paperSize === 'string' ? body.paperSize : 'A4',
        rotations,
      });
      res.json(result);
    } catch (error) {
      this.respondIdCopyError(res, error);
    }
  };
```

In `src/modules/scanner/scanner.module.ts`, after `const scannerService = new ScannerService();` add:

```ts
scannerService.startIdCopyHousekeeping();
```

- [ ] **Step 8: Type-check, lint and run the scanner tests**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `pnpm lint`
Expected: no errors.

Run: `pnpm exec jest src/modules/scanner`
Expected: PASS, every spec in the folder.

- [ ] **Step 9: Commit**

```bash
git add src/modules/scanner/id-copy.service.ts src/modules/scanner/id-copy.service.spec.ts src/modules/scanner/copy-preview-settings.ts src/modules/scanner/copy-preview-settings.spec.ts src/services/job-store.ts src/modules/scanner/scanner.service.ts src/modules/scanner/scanner.controller.ts src/modules/scanner/scanner.module.ts
git commit -m "feat(copy): add ID copy scan and compose endpoints"
```

---

### Task 7: Page state and config builder

**Files:**

- Create: `src/public/copy/copy-flow-state.ts`
- Test: `src/public/copy/copy-flow-state.spec.ts`
- Create: `src/public/shared/copy-config.ts`
- Test: `src/public/shared/copy-config.spec.ts`

**Interfaces:**

- Consumes: `IdRotation`, `IdSide` from `src/shared/id-card-layout.ts`; `IdScanWarning` from `src/shared/id-copy-contract.ts`; `DEFAULT_PRINT_SCALING`, `Orientation`, `PaperSize` from `src/shared/print-configuration.ts`.
- Produces, in `copy-flow-state.ts`:
  - `type CopyType = 'document' | 'id'`, `type CopyStage = 'capture' | 'settings'`, `type ScanTarget = 'document' | IdSide`
  - `interface CopyFlowState { copyType: CopyType; stage: CopyStage; documentScanned: boolean; front: boolean; back: boolean; rotations: Record<IdSide, IdRotation>; pendingWarnings: IdScanWarning[]; scanning: ScanTarget | null }`
  - `type CopyFlowEvent` (see code)
  - `createCopyFlowState(copyType?: CopyType): CopyFlowState`
  - `reduceCopyFlow(state: CopyFlowState, event: CopyFlowEvent): CopyFlowState`
  - `isCopyTypeLocked(state)`, `isSheetComplete(state)`, `canContinue(state)`: `boolean`
  - `nextIdScanTarget(state): IdSide | null`
  - `interface CopyFlowSnapshot`, `toSnapshot(state): CopyFlowSnapshot`, `parseSnapshot(raw: string | null): CopyFlowSnapshot | null`
- Produces, in `copy-config.ts`:
  - `interface CopyConfigInput { previewPath: string; releaseToken: string | null; paperSize: PaperSize; orientation: Orientation; colorMode: 'colored' | 'grayscale'; quality: 'standard' | 'high'; copies: number }`
  - `buildCopyConfig(input: CopyConfigInput)` returning the object stored in `sessionStorage['printbit.config']`.

- [ ] **Step 1: Write the failing reducer test**

Create `src/public/copy/copy-flow-state.spec.ts`:

```ts
import {
  canContinue,
  createCopyFlowState,
  isCopyTypeLocked,
  isSheetComplete,
  nextIdScanTarget,
  parseSnapshot,
  reduceCopyFlow,
  toSnapshot,
  type CopyFlowEvent,
  type CopyFlowState,
} from './copy-flow-state';

function run(
  events: CopyFlowEvent[],
  start = createCopyFlowState(),
): CopyFlowState {
  return events.reduce(reduceCopyFlow, start);
}

const scanFront: CopyFlowEvent[] = [
  { type: 'copy-type-selected', copyType: 'id' },
  { type: 'scan-started', target: 'front' },
  { type: 'side-scanned', side: 'front', warnings: [] },
];
const scanBoth: CopyFlowEvent[] = [
  ...scanFront,
  { type: 'scan-started', target: 'back' },
  { type: 'side-scanned', side: 'back', warnings: [] },
];

describe('document copy', () => {
  it('starts in capture with nothing scanned', () => {
    const state = createCopyFlowState();
    expect(state.copyType).toBe('document');
    expect(state.stage).toBe('capture');
    expect(canContinue(state)).toBe(false);
    expect(isCopyTypeLocked(state)).toBe(false);
  });

  it('moves to settings after the scan', () => {
    const state = run([
      { type: 'scan-started', target: 'document' },
      { type: 'document-scanned' },
    ]);
    expect(state.stage).toBe('settings');
    expect(isSheetComplete(state)).toBe(true);
    expect(canContinue(state)).toBe(true);
    expect(isCopyTypeLocked(state)).toBe(true);
  });

  it('stays in capture when the scan fails', () => {
    const state = run([
      { type: 'scan-started', target: 'document' },
      { type: 'scan-failed' },
    ]);
    expect(state.stage).toBe('capture');
    expect(state.scanning).toBeNull();
    expect(isCopyTypeLocked(state)).toBe(false);
  });
});

describe('ID card copy', () => {
  it('asks for the front, then the back', () => {
    const start = run([{ type: 'copy-type-selected', copyType: 'id' }]);
    expect(nextIdScanTarget(start)).toBe('front');
    const afterFront = run(scanFront);
    expect(nextIdScanTarget(afterFront)).toBe('back');
    expect(afterFront.stage).toBe('capture');
    expect(canContinue(afterFront)).toBe(false);
  });

  it('moves to settings only when both sides are scanned', () => {
    const state = run(scanBoth);
    expect(state.stage).toBe('settings');
    expect(nextIdScanTarget(state)).toBeNull();
    expect(canContinue(state)).toBe(true);
  });

  it('holds in capture while a warning is unanswered, then moves on Keep', () => {
    const warned = run([
      ...scanFront,
      { type: 'scan-started', target: 'back' },
      {
        type: 'side-scanned',
        side: 'back',
        warnings: [{ code: 'sides_identical', side: 'back' }],
      },
    ]);
    expect(warned.stage).toBe('capture');
    expect(canContinue(warned)).toBe(false);
    const kept = reduceCopyFlow(warned, { type: 'warning-kept' });
    expect(kept.pendingWarnings).toEqual([]);
    expect(kept.stage).toBe('settings');
    expect(canContinue(kept)).toBe(true);
  });

  it('clears the warning on Retake and keeps the side until the rescan', () => {
    const warned = run([
      ...scanFront.slice(0, 2),
      {
        type: 'side-scanned',
        side: 'front',
        warnings: [{ code: 'side_blank', side: 'front' }],
      },
    ]);
    const retake = reduceCopyFlow(warned, { type: 'warning-retake' });
    expect(retake.pendingWarnings).toEqual([]);
    expect(retake.front).toBe(true);
    expect(retake.stage).toBe('capture');
  });

  it('stays in settings during a retake and blocks Continue while it runs', () => {
    const retaking = run([
      ...scanBoth,
      { type: 'scan-started', target: 'front' },
    ]);
    expect(retaking.stage).toBe('settings');
    expect(canContinue(retaking)).toBe(false);
    const done = reduceCopyFlow(retaking, {
      type: 'side-scanned',
      side: 'front',
      warnings: [],
    });
    expect(done.stage).toBe('settings');
    expect(canContinue(done)).toBe(true);
  });

  it('blocks Continue in settings when a retake raises a warning', () => {
    const state = run([
      ...scanBoth,
      { type: 'scan-started', target: 'back' },
      {
        type: 'side-scanned',
        side: 'back',
        warnings: [{ code: 'side_blank', side: 'back' }],
      },
    ]);
    expect(state.stage).toBe('settings');
    expect(canContinue(state)).toBe(false);
  });

  it('rotates a scanned side by quarter turns and resets it on a retake', () => {
    let state = run(scanBoth);
    state = reduceCopyFlow(state, { type: 'side-rotated', side: 'front' });
    state = reduceCopyFlow(state, { type: 'side-rotated', side: 'front' });
    state = reduceCopyFlow(state, { type: 'side-rotated', side: 'back' });
    expect(state.rotations).toEqual({ front: 180, back: 90 });
    state = run(
      [
        { type: 'scan-started', target: 'front' },
        { type: 'side-scanned', side: 'front', warnings: [] },
      ],
      state,
    );
    expect(state.rotations).toEqual({ front: 0, back: 90 });
  });

  it('wraps a rotation back to 0 after four turns', () => {
    let state = run(scanFront);
    for (let i = 0; i < 4; i += 1) {
      state = reduceCopyFlow(state, { type: 'side-rotated', side: 'front' });
    }
    expect(state.rotations.front).toBe(0);
  });

  it('ignores a rotation for a side that is not scanned', () => {
    const state = reduceCopyFlow(run(scanFront), {
      type: 'side-rotated',
      side: 'back',
    });
    expect(state.rotations.back).toBe(0);
  });
});

describe('guards', () => {
  it('ignores a second scan while one is running', () => {
    const state = run([
      { type: 'copy-type-selected', copyType: 'id' },
      { type: 'scan-started', target: 'front' },
      { type: 'scan-started', target: 'back' },
    ]);
    expect(state.scanning).toBe('front');
  });

  it('ignores a scan target that does not match the copy type', () => {
    const state = run([{ type: 'scan-started', target: 'front' }]);
    expect(state.scanning).toBeNull();
  });

  it('locks the copy type once a scan exists or is running', () => {
    const scanning = run([{ type: 'scan-started', target: 'document' }]);
    expect(isCopyTypeLocked(scanning)).toBe(true);
    const changed = reduceCopyFlow(scanning, {
      type: 'copy-type-selected',
      copyType: 'id',
    });
    expect(changed.copyType).toBe('document');
  });

  it('start over clears every scan, returns to capture and keeps the type', () => {
    const state = reduceCopyFlow(run(scanBoth), { type: 'start-over' });
    expect(state).toEqual(createCopyFlowState('id'));
    expect(isCopyTypeLocked(state)).toBe(false);
  });
});

describe('snapshot', () => {
  it('restores the stage, sides and rotations', () => {
    const before = reduceCopyFlow(run(scanBoth), {
      type: 'side-rotated',
      side: 'back',
    });
    const raw = JSON.stringify(toSnapshot(before));
    const snapshot = parseSnapshot(raw)!;
    const after = reduceCopyFlow(createCopyFlowState(), {
      type: 'restored',
      snapshot,
    });
    expect(after).toEqual(before);
  });

  it('never restores a running scan or an open warning', () => {
    const warned = run([
      ...scanFront.slice(0, 2),
      {
        type: 'side-scanned',
        side: 'front',
        warnings: [{ code: 'side_blank', side: 'front' }],
      },
    ]);
    const snapshot = parseSnapshot(JSON.stringify(toSnapshot(warned)))!;
    const after = reduceCopyFlow(createCopyFlowState(), {
      type: 'restored',
      snapshot,
    });
    expect(after.pendingWarnings).toEqual([]);
    expect(after.scanning).toBeNull();
  });

  it('restores an incomplete ID capture into the capture stage', () => {
    const snapshot = parseSnapshot(
      JSON.stringify({
        copyType: 'id',
        stage: 'settings',
        documentScanned: false,
        front: true,
        back: false,
        rotations: { front: 0, back: 0 },
      }),
    )!;
    const after = reduceCopyFlow(createCopyFlowState(), {
      type: 'restored',
      snapshot,
    });
    expect(after.stage).toBe('capture');
  });

  it.each([
    null,
    '',
    'not json',
    '{}',
    '{"copyType":"fax"}',
    '{"copyType":"id","rotations":{"front":45}}',
  ])('rejects %p', (raw) => {
    expect(parseSnapshot(raw)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/public/copy/copy-flow-state.spec.ts`
Expected: FAIL with `Cannot find module './copy-flow-state'`.

- [ ] **Step 3: Write the reducer**

Create `src/public/copy/copy-flow-state.ts`:

```ts
/**
 * Pure state of the /copy page. No DOM, no fetch, no timers.
 * app.ts holds one value of this and renders from it.
 */
import type { IdRotation, IdSide } from '../../shared/id-card-layout';
import type { IdScanWarning } from '../../shared/id-copy-contract';

export type CopyType = 'document' | 'id';
/** capture: choosing and scanning. settings: print settings and Continue. */
export type CopyStage = 'capture' | 'settings';
export type ScanTarget = 'document' | IdSide;

export interface CopyFlowState {
  copyType: CopyType;
  stage: CopyStage;
  documentScanned: boolean;
  front: boolean;
  back: boolean;
  rotations: Record<IdSide, IdRotation>;
  /** Warnings the customer has not answered yet. The first one is shown. */
  pendingWarnings: IdScanWarning[];
  scanning: ScanTarget | null;
}

export interface CopyFlowSnapshot {
  copyType: CopyType;
  stage: CopyStage;
  documentScanned: boolean;
  front: boolean;
  back: boolean;
  rotations: Record<IdSide, IdRotation>;
}

export type CopyFlowEvent =
  | { type: 'copy-type-selected'; copyType: CopyType }
  | { type: 'scan-started'; target: ScanTarget }
  | { type: 'scan-failed' }
  | { type: 'document-scanned' }
  | { type: 'side-scanned'; side: IdSide; warnings: IdScanWarning[] }
  | { type: 'warning-kept' }
  | { type: 'warning-retake' }
  | { type: 'side-rotated'; side: IdSide }
  | { type: 'start-over' }
  | { type: 'restored'; snapshot: CopyFlowSnapshot };

export function createCopyFlowState(
  copyType: CopyType = 'document',
): CopyFlowState {
  return {
    copyType,
    stage: 'capture',
    documentScanned: false,
    front: false,
    back: false,
    rotations: { front: 0, back: 0 },
    pendingWarnings: [],
    scanning: null,
  };
}

export function isCopyTypeLocked(state: CopyFlowState): boolean {
  return (
    state.scanning !== null ||
    state.documentScanned ||
    state.front ||
    state.back
  );
}

export function isSheetComplete(state: CopyFlowState): boolean {
  return state.copyType === 'document'
    ? state.documentScanned
    : state.front && state.back;
}

export function canContinue(state: CopyFlowState): boolean {
  return (
    state.stage === 'settings' &&
    isSheetComplete(state) &&
    state.pendingWarnings.length === 0 &&
    state.scanning === null
  );
}

export function nextIdScanTarget(state: CopyFlowState): IdSide | null {
  if (!state.front) return 'front';
  if (!state.back) return 'back';
  return null;
}

function nextRotation(rotation: IdRotation): IdRotation {
  return ((rotation + 90) % 360) as IdRotation;
}

export function reduceCopyFlow(
  state: CopyFlowState,
  event: CopyFlowEvent,
): CopyFlowState {
  switch (event.type) {
    case 'copy-type-selected':
      if (isCopyTypeLocked(state)) return state;
      return createCopyFlowState(event.copyType);

    case 'scan-started': {
      if (state.scanning !== null) return state;
      const isDocumentTarget = event.target === 'document';
      if (isDocumentTarget !== (state.copyType === 'document')) return state;
      return { ...state, scanning: event.target };
    }

    case 'scan-failed':
      return { ...state, scanning: null };

    case 'document-scanned':
      if (state.copyType !== 'document') return state;
      return {
        ...state,
        documentScanned: true,
        stage: 'settings',
        scanning: null,
      };

    case 'side-scanned': {
      if (state.copyType !== 'id') return state;
      const next: CopyFlowState = {
        ...state,
        [event.side]: true,
        rotations: { ...state.rotations, [event.side]: 0 },
        pendingWarnings: event.warnings,
        scanning: null,
      };
      const ready = next.front && next.back && event.warnings.length === 0;
      return { ...next, stage: ready ? 'settings' : state.stage };
    }

    case 'warning-kept': {
      const pendingWarnings = state.pendingWarnings.slice(1);
      const ready = pendingWarnings.length === 0 && isSheetComplete(state);
      return {
        ...state,
        pendingWarnings,
        stage: ready ? 'settings' : state.stage,
      };
    }

    case 'warning-retake':
      return { ...state, pendingWarnings: [] };

    case 'side-rotated':
      if (state.scanning !== null || !state[event.side]) return state;
      return {
        ...state,
        rotations: {
          ...state.rotations,
          [event.side]: nextRotation(state.rotations[event.side]),
        },
      };

    case 'start-over':
      return createCopyFlowState(state.copyType);

    case 'restored': {
      const restored: CopyFlowState = {
        ...createCopyFlowState(event.snapshot.copyType),
        documentScanned: event.snapshot.documentScanned,
        front: event.snapshot.front,
        back: event.snapshot.back,
        rotations: { ...event.snapshot.rotations },
      };
      return {
        ...restored,
        stage:
          event.snapshot.stage === 'settings' && isSheetComplete(restored)
            ? 'settings'
            : 'capture',
      };
    }

    default:
      return state;
  }
}

export function toSnapshot(state: CopyFlowState): CopyFlowSnapshot {
  return {
    copyType: state.copyType,
    stage: state.stage,
    documentScanned: state.documentScanned,
    front: state.front,
    back: state.back,
    rotations: { ...state.rotations },
  };
}

const QUARTER_TURNS = new Set<unknown>([0, 90, 180, 270]);

/** Reads a stored snapshot. Null for anything that is not a valid one. */
export function parseSnapshot(raw: string | null): CopyFlowSnapshot | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;
  if (source.copyType !== 'document' && source.copyType !== 'id') return null;
  if (source.stage !== 'capture' && source.stage !== 'settings') return null;
  const rotations = source.rotations as Record<string, unknown> | undefined;
  if (
    typeof rotations !== 'object' ||
    rotations === null ||
    !QUARTER_TURNS.has(rotations.front) ||
    !QUARTER_TURNS.has(rotations.back)
  ) {
    return null;
  }
  return {
    copyType: source.copyType,
    stage: source.stage,
    documentScanned: source.documentScanned === true,
    front: source.front === true,
    back: source.back === true,
    rotations: {
      front: rotations.front as IdRotation,
      back: rotations.back as IdRotation,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/public/copy/copy-flow-state.spec.ts`
Expected: PASS, 27 tests.

- [ ] **Step 5: Write the failing config test**

Create `src/public/shared/copy-config.spec.ts`:

```ts
import { buildCopyConfig } from './copy-config';

const input = {
  previewPath: 'id-copy-1.pdf',
  releaseToken: 'token-1',
  paperSize: 'Short' as const,
  orientation: 'portrait' as const,
  colorMode: 'grayscale' as const,
  quality: 'high' as const,
  copies: 3,
};

describe('buildCopyConfig', () => {
  it('builds the object /confirm reads for a copy job', () => {
    expect(buildCopyConfig(input)).toEqual({
      scaling: 'fit',
      mode: 'copy',
      sessionId: null,
      documentId: null,
      filename: null,
      scanFilename: null,
      scanReleaseToken: null,
      copyPreviewPath: 'id-copy-1.pdf',
      copyPreviewReleaseToken: 'token-1',
      detectedColorMode: null,
      colorMode: 'grayscale',
      quality: 'high',
      duplex: false,
      copies: 3,
      orientation: 'portrait',
      rotationDeg: 0,
      paperSize: 'Short',
      pageRange: { type: 'all' },
      totalPages: 1,
    });
  });

  it.each([
    [0, 1],
    [-4, 1],
    [2.9, 2],
    [Number.NaN, 1],
    [500, 30],
  ])('clamps copies %p to %p', (copies, expected) => {
    expect(buildCopyConfig({ ...input, copies }).copies).toBe(expected);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm exec jest src/public/shared/copy-config.spec.ts`
Expected: FAIL with `Cannot find module './copy-config'`.

- [ ] **Step 7: Write the builder**

Create `src/public/shared/copy-config.ts`:

```ts
/**
 * The `printbit.config` object for a copy job. /copy writes it and /confirm
 * reads it. Field names match what /config wrote for copy mode.
 */
import {
  DEFAULT_PRINT_SCALING,
  type Orientation,
  type PaperSize,
} from '../../shared/print-configuration';

export const MAX_COPIES = 30;

export interface CopyConfigInput {
  previewPath: string;
  releaseToken: string | null;
  paperSize: PaperSize;
  orientation: Orientation;
  colorMode: 'colored' | 'grayscale';
  quality: 'standard' | 'high';
  copies: number;
}

export function clampCopies(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(MAX_COPIES, Math.max(1, Math.floor(numeric)));
}

export function buildCopyConfig(input: CopyConfigInput) {
  return {
    scaling: DEFAULT_PRINT_SCALING,
    mode: 'copy' as const,
    sessionId: null,
    documentId: null,
    filename: null,
    scanFilename: null,
    scanReleaseToken: null,
    copyPreviewPath: input.previewPath,
    copyPreviewReleaseToken: input.releaseToken,
    detectedColorMode: null,
    colorMode: input.colorMode,
    quality: input.quality,
    duplex: false,
    copies: clampCopies(input.copies),
    orientation: input.orientation,
    rotationDeg: 0 as const,
    paperSize: input.paperSize,
    pageRange: { type: 'all' as const },
    totalPages: 1,
  };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm exec jest src/public/shared/copy-config.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add src/public/copy/copy-flow-state.ts src/public/copy/copy-flow-state.spec.ts src/public/shared/copy-config.ts src/public/shared/copy-config.spec.ts
git commit -m "feat(copy): add copy page state and config builder"
```

---

### Task 8: Copy settings helpers

**Files:**

- Create: `src/public/copy/copy-settings.ts`
- Test: `src/public/copy/copy-settings.spec.ts`

**Interfaces:**

- Consumes: `clampCopies`, `MAX_COPIES` from `src/public/shared/copy-config.ts`; `PaperSize` from `src/shared/print-configuration.ts`.
- Produces:
  - `type CopyColorMode = 'colored' | 'grayscale'`, `type CopyQuality = 'standard' | 'high'`
  - `interface CopySettings { paperSize: PaperSize; colorMode: CopyColorMode; quality: CopyQuality; copies: number }`
  - `COPY_SETTINGS_STORAGE_KEY` (`'printbit.copySettings'`), `DEFAULT_COPY_SETTINGS` (A4, colored, standard, 1)
  - `parsePaperSize(value: unknown): PaperSize | null` (also maps the legacy `Letter` and `Legal`)
  - `parseCopySettings(raw: string | null): CopySettings` (never throws; falls back field by field)
  - `serializeCopySettings(settings: CopySettings): string`
  - `stepCopies(copies: number, delta: 1 | -1): number`
  - `copiesLimits(copies: number): { canDecrease: boolean; canIncrease: boolean }`

- [ ] **Step 1: Write the failing test**

Create `src/public/copy/copy-settings.spec.ts`:

```ts
import {
  DEFAULT_COPY_SETTINGS,
  copiesLimits,
  parseCopySettings,
  parsePaperSize,
  serializeCopySettings,
  stepCopies,
} from './copy-settings';

describe('parsePaperSize', () => {
  it.each([
    ['A4', 'A4'],
    ['Short', 'Short'],
    ['Long', 'Long'],
    ['Letter', 'Short'],
    ['Legal', 'Long'],
    ['B5', null],
    [42, null],
  ])('reads %p as %p', (value, expected) => {
    expect(parsePaperSize(value)).toBe(expected);
  });
});

describe('parseCopySettings', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(DEFAULT_COPY_SETTINGS).toEqual({
      paperSize: 'A4',
      colorMode: 'colored',
      quality: 'standard',
      copies: 1,
    });
    expect(parseCopySettings(null)).toEqual(DEFAULT_COPY_SETTINGS);
  });

  it('returns the defaults for text that is not JSON', () => {
    expect(parseCopySettings('not json')).toEqual(DEFAULT_COPY_SETTINGS);
  });

  it('reads stored settings', () => {
    const stored = {
      paperSize: 'Long',
      colorMode: 'grayscale',
      quality: 'high',
      copies: 4,
    };
    expect(parseCopySettings(JSON.stringify(stored))).toEqual(stored);
  });

  it('falls back field by field', () => {
    const raw = JSON.stringify({
      paperSize: 'B5',
      colorMode: 'grayscale',
      quality: 'ultra',
      copies: 'many',
    });
    expect(parseCopySettings(raw)).toEqual({
      paperSize: 'A4',
      colorMode: 'grayscale',
      quality: 'standard',
      copies: 1,
    });
  });

  it('clamps stored copies', () => {
    expect(parseCopySettings(JSON.stringify({ copies: 99 })).copies).toBe(30);
  });

  it('round-trips through serializeCopySettings', () => {
    const settings = {
      paperSize: 'Short' as const,
      colorMode: 'grayscale' as const,
      quality: 'high' as const,
      copies: 7,
    };
    expect(parseCopySettings(serializeCopySettings(settings))).toEqual(
      settings,
    );
  });
});

describe('stepCopies', () => {
  it.each([
    [1, -1, 1],
    [1, 1, 2],
    [30, 1, 30],
  ])('steps %p by %p to %p', (copies, delta, expected) => {
    expect(stepCopies(copies, delta as 1 | -1)).toBe(expected);
  });
});

describe('copiesLimits', () => {
  it.each([
    [1, false, true],
    [5, true, true],
    [30, true, false],
  ])('for %p copies: decrease %p, increase %p', (copies, down, up) => {
    expect(copiesLimits(copies)).toEqual({
      canDecrease: down,
      canIncrease: up,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/public/copy/copy-settings.spec.ts`
Expected: FAIL with `Cannot find module './copy-settings'`.

- [ ] **Step 3: Write the helpers**

Create `src/public/copy/copy-settings.ts`:

```ts
/**
 * The four print settings on /copy and how they are kept in session storage.
 * Pure: no DOM, no storage access.
 */
import type { PaperSize } from '../../shared/print-configuration';
import { clampCopies, MAX_COPIES } from '../shared/copy-config';

export type CopyColorMode = 'colored' | 'grayscale';
export type CopyQuality = 'standard' | 'high';

export interface CopySettings {
  paperSize: PaperSize;
  colorMode: CopyColorMode;
  quality: CopyQuality;
  copies: number;
}

export const COPY_SETTINGS_STORAGE_KEY = 'printbit.copySettings';

export const DEFAULT_COPY_SETTINGS: Readonly<CopySettings> = Object.freeze({
  paperSize: 'A4',
  colorMode: 'colored',
  quality: 'standard',
  copies: 1,
});

/** Reads a paper size. `Letter` and `Legal` are older names still in storage. */
export function parsePaperSize(value: unknown): PaperSize | null {
  if (value === 'A4' || value === 'Short' || value === 'Long') return value;
  if (value === 'Letter') return 'Short';
  if (value === 'Legal') return 'Long';
  return null;
}

export function parseCopySettings(raw: string | null): CopySettings {
  let source: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        source = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON: every field falls back to its default.
    }
  }
  return {
    paperSize:
      parsePaperSize(source.paperSize) ?? DEFAULT_COPY_SETTINGS.paperSize,
    colorMode: source.colorMode === 'grayscale' ? 'grayscale' : 'colored',
    quality: source.quality === 'high' ? 'high' : 'standard',
    copies: clampCopies(source.copies),
  };
}

export function serializeCopySettings(settings: CopySettings): string {
  return JSON.stringify({ ...settings, copies: clampCopies(settings.copies) });
}

export function stepCopies(copies: number, delta: 1 | -1): number {
  return clampCopies(copies + delta);
}

export function copiesLimits(copies: number): {
  canDecrease: boolean;
  canIncrease: boolean;
} {
  const value = clampCopies(copies);
  return { canDecrease: value > 1, canIncrease: value < MAX_COPIES };
}
```

`clampCopies(undefined)` and `clampCopies('many')` return 1, because `Number()` of either is `NaN`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/public/copy/copy-settings.spec.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/public/copy/copy-settings.ts src/public/copy/copy-settings.spec.ts
git commit -m "feat(copy): add copy settings helpers"
```

---

### Task 9: ID capture client

**Files:**

- Create: `src/public/copy/id-capture.ts`
- Test: `src/public/copy/id-capture.spec.ts`

**Interfaces:**

- Consumes: `IdRotation`, `IdSide` from `src/shared/id-card-layout.ts`; `ID_SESSION_EXPIRED_CODE`, `IdCopySheetResponse`, `IdScanWarning` from `src/shared/id-copy-contract.ts`; `PaperSize`. The response shapes of `POST /api/scan/id-copy/side` and `/compose` from Task 6: 200 with `IdCopySheetResponse` or `IdCopyFailureResponse`; 409 `{ code: 'ID_SESSION_EXPIRED', error }`; 400 and 500 `{ error }`; 503 `{ code: 'POWER_EMERGENCY', message }`.
- Produces:
  - `type FetchWithTimeout = (input: string, init: RequestInit, timeoutMs: number, label: string) => Promise<Response>` (`fetchWithTimeout` from `src/public/shared/fetch-with-timeout.ts` satisfies it)
  - `type IdCaptureResult = { kind: 'sheet'; sheet: IdCopySheetResponse } | { kind: 'scan-failed'; sessionId: string | null; code: string; error: string } | { kind: 'expired'; error: string } | { kind: 'error'; code: string; error: string }`
  - `interface IdCaptureClient { scanSide(input: { sessionId: string | null; side: IdSide; paperSize: PaperSize }): Promise<IdCaptureResult>; compose(input: { sessionId: string; paperSize: PaperSize; rotations: Record<IdSide, IdRotation> }): Promise<IdCaptureResult> }`
  - `createIdCaptureClient(deps: { fetch: FetchWithTimeout; timeoutMs: number }): IdCaptureClient`

The client never throws. `scan-failed` is a scanner failure the server reported (the session survives); `error` is everything else. The codes `SCANNER_TIMEOUT` and `SCANNER_OFFLINE` match what `/copy` sends to the troubleshooting guide today.

- [ ] **Step 1: Write the failing test**

Create `src/public/copy/id-capture.spec.ts`:

```ts
import { createIdCaptureClient } from './id-capture';

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function notJson(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  } as unknown as Response;
}

function setup(outcome: Response | Error) {
  const fetch = jest.fn(
    (): Promise<Response> =>
      outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome),
  );
  return {
    fetch,
    capture: createIdCaptureClient({ fetch, timeoutMs: 110_000 }),
  };
}

const sheet = {
  detected: true,
  sessionId: 's-1',
  sides: { front: true, back: false },
  complete: false,
  previewPath: 'id-copy-1.pdf',
  releaseToken: 't-1',
  warnings: [],
};

const frontRequest = {
  sessionId: null,
  side: 'front' as const,
  paperSize: 'A4' as const,
};

describe('scanSide', () => {
  it.each([
    ['front', 'Front scan'],
    ['back', 'Back scan'],
  ] as const)(
    'posts a %s scan with its label and timeout',
    async (side, label) => {
      const { fetch, capture } = setup(reply(200, sheet));
      await capture.scanSide({ sessionId: 's-1', side, paperSize: 'Short' });
      expect(fetch).toHaveBeenCalledWith(
        '/api/scan/id-copy/side',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 's-1', side, paperSize: 'Short' }),
        },
        110_000,
        label,
      );
    },
  );

  it('returns the sheet and its warnings', async () => {
    const warned = {
      ...sheet,
      warnings: [{ code: 'side_blank', side: 'front' }],
    };
    const { capture } = setup(reply(200, warned));
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'sheet',
      sheet: warned,
    });
  });

  it('treats missing warnings as none', async () => {
    const { warnings: _omitted, ...withoutWarnings } = sheet;
    const { capture } = setup(reply(200, withoutWarnings));
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'sheet',
      sheet,
    });
  });

  it('drops warnings it does not know', async () => {
    const { capture } = setup(
      reply(200, {
        ...sheet,
        warnings: [
          { code: 'blurry', side: 'front' },
          { code: 'sides_identical', side: 'back' },
        ],
      }),
    );
    const result = await capture.scanSide(frontRequest);
    expect(result.kind === 'sheet' && result.sheet.warnings).toEqual([
      { code: 'sides_identical', side: 'back' },
    ]);
  });

  it('keeps the session id of a failed scan', async () => {
    const { capture } = setup(
      reply(200, {
        detected: false,
        sessionId: 's-1',
        code: 'SCAN_TIMEOUT',
        error: 'Scanner timed out.',
      }),
    );
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'scan-failed',
      sessionId: 's-1',
      code: 'SCAN_TIMEOUT',
      error: 'Scanner timed out.',
    });
  });

  it('reports an expired session', async () => {
    const { capture } = setup(
      reply(409, {
        code: 'ID_SESSION_EXPIRED',
        error: 'Your ID scan session expired. Please scan your ID again.',
      }),
    );
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'expired',
      error: 'Your ID scan session expired. Please scan your ID again.',
    });
  });

  it('reports a power emergency', async () => {
    const { capture } = setup(
      reply(503, {
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      }),
    );
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'error',
      code: 'POWER_EMERGENCY',
      error: 'Power emergency active; customer work suspended',
    });
  });

  it('reports a rejected request with the server text', async () => {
    const { capture } = setup(
      reply(400, { error: 'Invalid side. Accepted: "front", "back"' }),
    );
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'error',
      code: 'SCAN_FAILED',
      error: 'Invalid side. Accepted: "front", "back"',
    });
  });

  it('falls back when the body is not JSON', async () => {
    const { capture } = setup(notJson(500));
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'error',
      code: 'SCAN_FAILED',
      error: 'Could not complete scanner check. Please try again.',
    });
  });

  it('reports a client timeout', async () => {
    const { capture } = setup(
      new Error('Front scan timed out after 110 seconds'),
    );
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'error',
      code: 'SCANNER_TIMEOUT',
      error: 'Front scan timed out after 110 seconds',
    });
  });

  it('reports a server it cannot reach', async () => {
    const { capture } = setup(new TypeError('Failed to fetch'));
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'error',
      code: 'SCANNER_OFFLINE',
      error: 'Could not reach the scanner. Please try again.',
    });
  });
});

describe('compose', () => {
  it('posts the paper size and rotations', async () => {
    const { fetch, capture } = setup(reply(200, sheet));
    const result = await capture.compose({
      sessionId: 's-1',
      paperSize: 'Short',
      rotations: { front: 90, back: 0 },
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/scan/id-copy/compose',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 's-1',
          paperSize: 'Short',
          rotations: { front: 90, back: 0 },
        }),
      },
      110_000,
      'ID sheet',
    );
    expect(result.kind).toBe('sheet');
  });
});
```

If ESLint flags `_omitted` as unused, add `// eslint-disable-next-line @typescript-eslint/no-unused-vars` above that line. Do not change the test otherwise.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/public/copy/id-capture.spec.ts`
Expected: FAIL with `Cannot find module './id-capture'`.

- [ ] **Step 3: Write the client**

Create `src/public/copy/id-capture.ts`:

```ts
/**
 * Calls the ID copy endpoints and turns every outcome into one result value.
 * The fetch is injected so each outcome is testable without a browser.
 */
import type { IdRotation, IdSide } from '../../shared/id-card-layout';
import {
  ID_SESSION_EXPIRED_CODE,
  type IdCopySheetResponse,
  type IdScanWarning,
} from '../../shared/id-copy-contract';
import type { PaperSize } from '../../shared/print-configuration';

export type FetchWithTimeout = (
  input: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
) => Promise<Response>;

export type IdCaptureResult =
  | { kind: 'sheet'; sheet: IdCopySheetResponse }
  | {
      kind: 'scan-failed';
      sessionId: string | null;
      code: string;
      error: string;
    }
  | { kind: 'expired'; error: string }
  | { kind: 'error'; code: string; error: string };

export interface IdCaptureClient {
  scanSide(input: {
    sessionId: string | null;
    side: IdSide;
    paperSize: PaperSize;
  }): Promise<IdCaptureResult>;
  compose(input: {
    sessionId: string;
    paperSize: PaperSize;
    rotations: Record<IdSide, IdRotation>;
  }): Promise<IdCaptureResult>;
}

const SCAN_FAILED_MESSAGE =
  'Could not complete scanner check. Please try again.';
const OFFLINE_MESSAGE = 'Could not reach the scanner. Please try again.';
const EXPIRED_MESSAGE =
  'Your ID scan session expired. Please scan your ID again.';
const WARNING_CODES = new Set<unknown>(['side_blank', 'sides_identical']);
const SIDES = new Set<unknown>(['front', 'back']);

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readWarnings(value: unknown): IdScanWarning[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is IdScanWarning => {
    if (typeof item !== 'object' || item === null) return false;
    const record = item as Record<string, unknown>;
    return WARNING_CODES.has(record.code) && SIDES.has(record.side);
  });
}

function readResult(
  status: number,
  ok: boolean,
  payload: Record<string, unknown>,
): IdCaptureResult {
  if (status === 409 && payload.code === ID_SESSION_EXPIRED_CODE) {
    return {
      kind: 'expired',
      error: text(payload, 'error') ?? EXPIRED_MESSAGE,
    };
  }
  if (!ok) {
    return {
      kind: 'error',
      code: text(payload, 'code') ?? 'SCAN_FAILED',
      error:
        text(payload, 'error') ??
        text(payload, 'message') ??
        SCAN_FAILED_MESSAGE,
    };
  }

  const sessionId = text(payload, 'sessionId');
  const previewPath = text(payload, 'previewPath');
  const releaseToken = text(payload, 'releaseToken');
  if (payload.detected === true && sessionId && previewPath && releaseToken) {
    const sides = (payload.sides ?? {}) as Record<string, unknown>;
    return {
      kind: 'sheet',
      sheet: {
        detected: true,
        sessionId,
        sides: { front: sides.front === true, back: sides.back === true },
        complete: payload.complete === true,
        previewPath,
        releaseToken,
        warnings: readWarnings(payload.warnings),
      },
    };
  }

  return {
    kind: 'scan-failed',
    sessionId,
    code: text(payload, 'code') ?? 'SCAN_FAILED',
    error: text(payload, 'error') ?? SCAN_FAILED_MESSAGE,
  };
}

export function createIdCaptureClient(deps: {
  fetch: FetchWithTimeout;
  timeoutMs: number;
}): IdCaptureClient {
  async function post(
    url: string,
    body: unknown,
    label: string,
  ): Promise<IdCaptureResult> {
    let response: Response;
    try {
      response = await deps.fetch(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        deps.timeoutMs,
        label,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out')) {
        return { kind: 'error', code: 'SCANNER_TIMEOUT', error: error.message };
      }
      return { kind: 'error', code: 'SCANNER_OFFLINE', error: OFFLINE_MESSAGE };
    }

    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed === 'object' && parsed !== null) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON: the status alone decides the result.
    }
    return readResult(response.status, response.ok, payload);
  }

  return {
    scanSide: (input) =>
      post(
        '/api/scan/id-copy/side',
        {
          sessionId: input.sessionId,
          side: input.side,
          paperSize: input.paperSize,
        },
        input.side === 'front' ? 'Front scan' : 'Back scan',
      ),
    compose: (input) =>
      post(
        '/api/scan/id-copy/compose',
        {
          sessionId: input.sessionId,
          paperSize: input.paperSize,
          rotations: input.rotations,
        },
        'ID sheet',
      ),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/public/copy/id-capture.spec.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Lint and commit**

Run: `pnpm lint`
Expected: no errors.

```bash
git add src/public/copy/id-capture.ts src/public/copy/id-capture.spec.ts
git commit -m "feat(copy): add ID capture client"
```

---

### Task 10: `/copy` markup and styles

**Files:**

- Modify: `src/public/copy/index.html`
- Modify: `src/public/copy/styles.css`

**Interfaces:**

- Consumes: the `/config` layout classes in `src/public/config/styles.css` (`config-layout`, `preview-col`, `preview-panel__header`, `preview-panel__eyebrow`, `preview-status`, `paper-viewport`, `paper-sheet`, `paper-canvas`, `paper-placeholder`, `paper-placeholder__text`, `settings-col`, `settings-scroll`, `option-group`, `option-group--primary`, `option-label`, `option-grid`, `option-grid--3`, `option-card`, `option-card__icon`, `option-card__label`, `option-card__radio`, `copies-control`, `copies-btn`, `copies-input`, `config-pane-footer`, `config-continue-btn`, `hidden`, `sr-only`) and its id rules for `#paperSizeGroup` and `#copiesGroup`.
- Produces the element ids Task 11 reads. Kept ids: `scanOverlay`, `copyLoadingAnimation`, `copyLoadingCanvas`, `copyOverlaySub`, `previewStatusText`, `previewCanvas`, `copyPlaceholderLabel`, `copyStep1Desc`, `checkDocBtn`, `continueBtn`, `errorBanner`, `errorText`, `retryBtn`, `copySeeStepsBtn`, `copyTroubleshootingPanel`, `copyTroubleshootCauses`, `copyTroubleshootSteps`, every modal id, `idleWarningModal`. New ids: `copyLayout`, `copyOverlayTitle`, `paperViewport`, `paperSheet`, `paperPlaceholder`, `backSlotOverlay`, `copyPreviewActions`, `scanAgainBtn`, `retakeFrontBtn`, `rotateFrontBtn`, `retakeBackBtn`, `rotateBackBtn`, `captureStage`, `copyTypeGroup`, `documentSizeGroup`, `idCaptureGroup`, `idStepFront`, `idStepFrontState`, `idStepBack`, `idStepBackState`, `flipPrompt`, `flipScanBackBtn`, `flipRetakeFrontBtn`, `startOverBtn`, `settingsStage`, `copyTypeSummary`, `changeCopyTypeBtn`, `paperSizeGroup`, `colorModeGroup`, `qualityGroup`, `copiesGroup`, `copiesDec`, `copies`, `copiesInc`, `scanSideBtn`, `scanSideLabel`, `idWarningDialog`, `idWarningText`, `idWarningKeepBtn`, `idWarningRetakeBtn`. Radio names: `copyType`, `copySourcePaperSize`, `paperSize`, `colorMode`, `printQuality`.
- Removed ids: `previewSection`, `previewPaper`, `previewImageStage`, `previewImage`, `previewPlaceholder`, `clearRescanBtn`, `copySourceSizeGroup`, `copySourceSizeHint`, `copyFooterNote`.

Visibility contract: `#copyLayout` carries `data-copy-type="document" | "id"`. Any element with `data-for="id"` is hidden while the type is `document`, and the reverse. Stage panes and buttons are shown and hidden with the `hidden` class.

This task leaves the page unwired until Task 11; do not open `/copy` in between. `pnpm build` still passes because `app.ts` null-checks every element.

- [ ] **Step 1: Link the `/config` stylesheet**

In `src/public/copy/index.html`, replace the head stylesheet lines:

```html
<link rel="stylesheet" href="/globals.css" />
<link rel="stylesheet" href="/shared/kiosk-transition.css" />
<title>Copy · PrintBit</title>
<link rel="stylesheet" href="/copy/styles.css" />
<link rel="stylesheet" href="/shared/loading-animation.css" />
```

with:

```html
<link rel="stylesheet" href="/globals.css" />
<link rel="stylesheet" href="/shared/kiosk-transition.css" />
<title>Copy · PrintBit</title>
<link rel="stylesheet" href="/config/styles.css" />
<link rel="stylesheet" href="/copy/styles.css" />
<link rel="stylesheet" href="/shared/loading-animation.css" />
```

- [ ] **Step 2: Give the overlay title an id**

Replace:

```html
<p class="scan-overlay__title">Scanning document…</p>
```

with:

```html
<p class="scan-overlay__title" id="copyOverlayTitle">Scanning…</p>
```

- [ ] **Step 3: Replace the two-column body**

Replace everything from `<main class="copy-layout" role="main">` through its closing `</main>` (the left preview section, the error card and the right steps section) with the block below. The error card markup (from `<div id="errorBanner"` to the end of `copyTroubleshootingPanel`) is copied unchanged from the current file into the marked spot, directly after the `copy-preview-panel` div.

```html
<main
  class="config-layout"
  id="copyLayout"
  role="main"
  data-copy-type="document"
  data-copy-stage="capture"
>
  <!-- LEFT: the sheet as it will print -->
  <section class="preview-col" aria-label="Copy preview">
    <div class="copy-preview-panel">
      <div class="preview-panel__header">
        <span class="preview-panel__eyebrow">Copy Preview</span>
        <span class="preview-status" id="previewStatusText" aria-live="polite"
          >Waiting for scan</span
        >
      </div>

      <div class="paper-viewport" id="paperViewport">
        <div class="paper-sheet" id="paperSheet">
          <canvas
            id="previewCanvas"
            class="paper-canvas"
            style="display: none"
          ></canvas>

          <div
            class="copy-slot-overlay hidden"
            id="backSlotOverlay"
            aria-hidden="true"
          >
            <span>Back side not scanned yet</span>
          </div>

          <div class="paper-placeholder copy-placement" id="paperPlaceholder">
            <div
              class="copy-placement__glass"
              data-for="document"
              aria-hidden="true"
            >
              <div class="copy-placement__doc"></div>
            </div>
            <div class="copy-placement__glass" data-for="id" aria-hidden="true">
              <div class="copy-placement__corner"></div>
              <div class="copy-placement__card"></div>
            </div>
            <p class="paper-placeholder__text" id="copyPlaceholderLabel">
              Place your document face-down, then tap Check Document
            </p>
          </div>
        </div>
      </div>

      <div
        class="copy-preview-actions hidden"
        id="copyPreviewActions"
        role="toolbar"
        aria-label="Scan actions"
      >
        <button
          type="button"
          class="copy-action-btn"
          id="scanAgainBtn"
          data-for="document"
        >
          Scan Again
        </button>
        <button
          type="button"
          class="copy-action-btn"
          id="retakeFrontBtn"
          data-for="id"
        >
          Retake front
        </button>
        <button
          type="button"
          class="copy-action-btn"
          id="rotateFrontBtn"
          data-for="id"
        >
          Rotate front
        </button>
        <button
          type="button"
          class="copy-action-btn"
          id="retakeBackBtn"
          data-for="id"
        >
          Retake back
        </button>
        <button
          type="button"
          class="copy-action-btn"
          id="rotateBackBtn"
          data-for="id"
        >
          Rotate back
        </button>
      </div>
    </div>

    <!-- PASTE the unchanged errorBanner card here -->
  </section>

  <!-- RIGHT: capture stage, then settings stage -->
  <section class="settings-col" aria-label="Copy options">
    <div class="settings-scroll" id="captureStage">
      <fieldset class="option-group option-group--primary" id="copyTypeGroup">
        <legend class="option-label">What are you copying?</legend>
        <div class="option-grid">
          <label class="option-card">
            <input
              type="radio"
              name="copyType"
              value="document"
              checked
              class="sr-only"
            />
            <div class="option-card__icon" aria-hidden="true">
              <svg viewBox="0 0 36 36" fill="none">
                <rect
                  x="9"
                  y="4"
                  width="18"
                  height="28"
                  rx="2.5"
                  stroke="currentColor"
                  stroke-width="2"
                  fill="currentColor"
                  opacity=".12"
                />
                <rect
                  x="13"
                  y="11"
                  width="10"
                  height="2"
                  rx="1"
                  fill="currentColor"
                  opacity=".6"
                />
                <rect
                  x="13"
                  y="16"
                  width="10"
                  height="2"
                  rx="1"
                  fill="currentColor"
                  opacity=".45"
                />
                <rect
                  x="13"
                  y="21"
                  width="7"
                  height="2"
                  rx="1"
                  fill="currentColor"
                  opacity=".35"
                />
              </svg>
            </div>
            <span class="option-card__label">Document</span>
            <span class="option-card__radio" aria-hidden="true"></span>
          </label>
          <label class="option-card">
            <input type="radio" name="copyType" value="id" class="sr-only" />
            <div class="option-card__icon" aria-hidden="true">
              <svg viewBox="0 0 36 36" fill="none">
                <rect
                  x="3"
                  y="8"
                  width="30"
                  height="20"
                  rx="3"
                  stroke="currentColor"
                  stroke-width="2"
                  fill="currentColor"
                  opacity=".12"
                />
                <circle
                  cx="12"
                  cy="16"
                  r="3.5"
                  fill="currentColor"
                  opacity=".6"
                />
                <rect
                  x="7"
                  y="22"
                  width="10"
                  height="2"
                  rx="1"
                  fill="currentColor"
                  opacity=".45"
                />
                <rect
                  x="20"
                  y="14"
                  width="9"
                  height="2"
                  rx="1"
                  fill="currentColor"
                  opacity=".6"
                />
                <rect
                  x="20"
                  y="19"
                  width="7"
                  height="2"
                  rx="1"
                  fill="currentColor"
                  opacity=".45"
                />
              </svg>
            </div>
            <span class="option-card__label">ID Card</span>
            <span class="option-card__radio" aria-hidden="true"></span>
          </label>
        </div>
      </fieldset>

      <fieldset
        class="option-group option-group--primary"
        id="documentSizeGroup"
        data-for="document"
      >
        <legend class="option-label">Document Size</legend>
        <div class="option-grid option-grid--3">
          <label class="option-card">
            <input
              type="radio"
              name="copySourcePaperSize"
              value="A4"
              checked
              class="sr-only"
            />
            <span class="option-card__label">A4 Bond</span>
            <span class="option-card__radio" aria-hidden="true"></span>
          </label>
          <label class="option-card">
            <input
              type="radio"
              name="copySourcePaperSize"
              value="Short"
              class="sr-only"
            />
            <span class="option-card__label">Short Bond</span>
            <span class="option-card__radio" aria-hidden="true"></span>
          </label>
          <label class="option-card">
            <input
              type="radio"
              name="copySourcePaperSize"
              value="Long"
              class="sr-only"
            />
            <span class="option-card__label">Long Bond</span>
            <span class="option-card__radio" aria-hidden="true"></span>
          </label>
        </div>
        <p class="copy-hint" id="copyStep1Desc">
          Align the paper face-down on the glass scanner
        </p>
      </fieldset>

      <div
        class="option-group option-group--primary"
        id="idCaptureGroup"
        data-for="id"
      >
        <span class="option-label">Scan both sides</span>
        <ol class="copy-id-steps">
          <li class="copy-id-step" id="idStepFront" data-state="waiting">
            <span class="copy-id-step__num" aria-hidden="true">1</span>
            <span class="copy-id-step__name">Front side</span>
            <span class="copy-id-step__state" id="idStepFrontState"
              >Waiting</span
            >
          </li>
          <li class="copy-id-step" id="idStepBack" data-state="waiting">
            <span class="copy-id-step__num" aria-hidden="true">2</span>
            <span class="copy-id-step__name">Back side</span>
            <span class="copy-id-step__state" id="idStepBackState"
              >Waiting</span
            >
          </li>
        </ol>
        <p class="copy-hint">
          Place your ID face-down on the marked corner of the glass.
        </p>

        <div class="copy-flip-prompt hidden" id="flipPrompt" role="status">
          <svg
            class="copy-flip-prompt__icon"
            viewBox="0 0 96 64"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="4"
              y="18"
              width="34"
              height="22"
              rx="3"
              stroke="currentColor"
              stroke-width="2.5"
              fill="currentColor"
              opacity=".18"
            />
            <rect
              x="58"
              y="18"
              width="34"
              height="22"
              rx="3"
              stroke="currentColor"
              stroke-width="2.5"
            />
            <path
              d="M24 12 C 38 0, 58 0, 72 12"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
            />
            <path
              d="M66 6 L72 12 L64 15"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <p class="copy-flip-prompt__text">
            Front captured. Turn your ID over, place it on the same corner, then
            tap Scan Back.
          </p>
          <div class="copy-flip-prompt__actions">
            <button
              type="button"
              class="copy-action-btn copy-action-btn--primary"
              id="flipScanBackBtn"
            >
              Scan Back
            </button>
            <button
              type="button"
              class="copy-action-btn"
              id="flipRetakeFrontBtn"
            >
              Retake front
            </button>
          </div>
        </div>

        <button type="button" class="copy-link-btn hidden" id="startOverBtn">
          Start over
        </button>
      </div>
    </div>

    <div class="settings-scroll hidden" id="settingsStage">
      <div class="option-group option-group--primary copy-type-summary">
        <span class="option-label">Copy type</span>
        <div class="copy-type-summary__row">
          <span id="copyTypeSummary">Document</span>
          <button type="button" class="copy-link-btn" id="changeCopyTypeBtn">
            Change type
          </button>
        </div>
      </div>

      <!-- PASTE the #paperSizeGroup fieldset from src/public/config/index.html here, unchanged -->

      <!-- PASTE the #colorModeGroup fieldset from src/public/config/index.html here, unchanged -->

      <!-- PASTE the #qualityGroup fieldset from src/public/config/index.html here, unchanged -->

      <!-- PASTE the #copiesGroup div from src/public/config/index.html here, unchanged -->
    </div>

    <div class="config-pane-footer">
      <button
        id="checkDocBtn"
        type="button"
        class="config-continue-btn"
        data-for="document"
      >
        <span>Check Document</span>
      </button>
      <button
        id="scanSideBtn"
        type="button"
        class="config-continue-btn"
        data-for="id"
      >
        <span id="scanSideLabel">Scan Front</span>
      </button>
      <button
        id="continueBtn"
        type="button"
        class="config-continue-btn hidden"
        disabled
        aria-disabled="true"
      >
        <span>Continue to Payment</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  </section>
</main>
```

Resolve each `PASTE` comment and delete the comment:

1. The error card: the current `/copy` markup from `<div id="errorBanner"` through the `</div>` that closes the error card (it contains `copyTroubleshootingPanel`).
2. Four blocks from `src/public/config/index.html`, each copied whole: `<fieldset ... id="paperSizeGroup">` to its `</fieldset>`, `<fieldset ... id="colorModeGroup">` to its `</fieldset>`, `<fieldset ... id="qualityGroup">` to its `</fieldset>` (stop before the `<aside class="detection-evidence"`), and `<div class="option-group option-group--primary" id="copiesGroup">` to its closing `</div>`. In the pasted `qualityGroup`, change `option-group--advanced` to `option-group--primary`.

- [ ] **Step 4: Remove the old footer and add the warning dialog**

Delete the `<!-- Footer -->` comment and the whole `<footer class="copy-footer">` element. Continue now lives in the right pane footer.

Directly before the `<!-- Idle Warning Overlay` comment, add:

```html
<dialog
  class="copy-warning-dialog"
  id="idWarningDialog"
  aria-labelledby="idWarningTitle"
  aria-describedby="idWarningText"
>
  <h2 class="copy-warning-dialog__title" id="idWarningTitle">
    Check your scan
  </h2>
  <p class="copy-warning-dialog__text" id="idWarningText"></p>
  <div class="copy-warning-dialog__actions">
    <button
      type="button"
      class="copy-action-btn copy-action-btn--primary"
      id="idWarningRetakeBtn"
    >
      Retake
    </button>
    <button type="button" class="copy-action-btn" id="idWarningKeepBtn">
      Keep anyway
    </button>
  </div>
</dialog>
```

After the idle overlay's closing `</div>`, the current file has two stray `</div>` lines before the `<script>` tags. They close nothing. Delete both.

- [ ] **Step 5: Check the markup**

Run each command from the repo root:

```bash
grep -c 'id="' src/public/copy/index.html
grep -o 'id="[^"]*"' src/public/copy/index.html | sort | uniq -d
grep -nE 'id="(previewSection|previewPaper|previewImageStage|previewImage|previewPlaceholder|clearRescanBtn|copySourceSizeGroup|copyFooterNote)"' src/public/copy/index.html
grep -nE 'id="(paperSizeGroup|colorModeGroup|qualityGroup|copiesGroup|errorBanner|idWarningDialog|captureStage|settingsStage)"' src/public/copy/index.html
```

Expected: the first prints a count; the second prints nothing (no duplicate ids); the third prints nothing; the fourth prints eight lines.

- [ ] **Step 6: Remove copy styles that now come from `/config` or are dead**

In `src/public/copy/styles.css`, delete every rule whose selector starts with one of these classes, including rules inside `@media` blocks. Remove any `@media` block left empty.

- Now styled by `/config/styles.css`: `.kiosk-bg`, `.bg-circle` (all variants), `.page-shell`, `.topbar` (also `.topbar-actions`), `.back-btn`, `.page-title-block`, `.page-title-icon`, `.preview-col`, `.preview-panel__header`, `.preview-panel__eyebrow`.
- No longer in the markup: `.copy-layout`, `.controls-col`, `.source-size-card` (all elements), `.source-size-option` (all), `.source-size-options`, `.steps-panel` (all), `.steps`, `.step` (all elements), `.preview-panel`, `.preview-panel__status`, `.preview-placeholder`, `.placeholder-label`, `.scan-bed` (all), `.check-btn`, `.preview-result` (all), `.clear-rescan-btn`, `.rescan-btn`, `.copy-footer` (all), `.continue-btn`.

Keep these exceptions: `.back-btn.back-btn--disabled`, and every `.preview-col.has-error ...` rule except `.preview-col.has-error .preview-panel`, which is deleted.

- [ ] **Step 7: Add the copy styles**

Append to `src/public/copy/styles.css`:

```css
/* ══ /copy on the /config layout ═════════════════════════════
   Layout classes come from /config/styles.css. Only /copy-specific
   pieces live here. */

#copyLayout[data-copy-type='document'] [data-for='id'],
#copyLayout[data-copy-type='id'] [data-for='document'] {
  display: none !important;
}

#copyTypeGroup,
#documentSizeGroup,
#idCaptureGroup,
.copy-type-summary {
  grid-column: 1 / -1;
}

.copy-preview-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 10px;
}

.preview-col.has-error .copy-preview-panel {
  display: none;
}

.copy-hint {
  margin: 8px 2px 0;
  font-size: 13px;
  line-height: 1.4;
  color: var(--lavender);
  opacity: 0.75;
}

/* ── Placement diagrams on the empty sheet ── */
.copy-placement__glass {
  position: relative;
  width: 160px;
  height: 200px;
  border: 2px solid rgba(105, 111, 199, 0.45);
  border-radius: 8px;
  background: rgba(105, 111, 199, 0.06);
}

.copy-placement__doc {
  position: absolute;
  inset: 14px;
  border-radius: 4px;
  background: rgba(105, 111, 199, 0.18);
}

.copy-placement__corner {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 24px;
  height: 24px;
  border-top: 4px solid #f59e0b;
  border-left: 4px solid #f59e0b;
  border-radius: 4px 0 0 0;
}

.copy-placement__card {
  position: absolute;
  top: 10px;
  left: 10px;
  width: 68px;
  height: 43px;
  border: 2px solid rgba(105, 111, 199, 0.7);
  border-radius: 6px;
  background: rgba(105, 111, 199, 0.3);
}

/* ── Dashed slot for the back side (positioned by app.ts) ── */
.copy-slot-overlay {
  position: absolute;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  border: 3px dashed rgba(105, 111, 199, 0.75);
  border-radius: 6px;
  background: rgba(105, 111, 199, 0.06);
  color: #4b4f9a;
  font-size: 13px;
  font-weight: 700;
  text-align: center;
  pointer-events: none;
}

/* ── Buttons ── */
.copy-preview-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  padding: 4px 0 2px;
}

.copy-action-btn {
  min-height: 56px;
  padding: 0 20px;
  border: 1px solid rgba(167, 170, 225, 0.3);
  border-radius: 14px;
  background: rgba(167, 170, 225, 0.08);
  color: inherit;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
}

.copy-action-btn:active {
  transform: scale(0.97);
}

.copy-action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none;
}

.copy-action-btn--primary {
  border-color: transparent;
  background: #696fc7;
  color: #fff;
}

.copy-link-btn {
  min-height: 48px;
  padding: 0 16px;
  border: 1px solid rgba(167, 170, 225, 0.3);
  border-radius: 12px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.copy-link-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

#startOverBtn {
  margin-top: 12px;
}

/* ── ID capture steps ── */
.copy-id-steps {
  display: grid;
  gap: 8px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.copy-id-step {
  display: grid;
  grid-template-columns: 36px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid rgba(167, 170, 225, 0.18);
  border-radius: 14px;
  background: rgba(167, 170, 225, 0.05);
}

.copy-id-step__num {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(167, 170, 225, 0.12);
  font-weight: 800;
}

.copy-id-step__name {
  font-size: 16px;
  font-weight: 700;
}

.copy-id-step__state {
  font-size: 13px;
  font-weight: 700;
  opacity: 0.7;
}

.copy-id-step[data-state='done'] {
  border-color: rgba(74, 222, 128, 0.45);
}

.copy-id-step[data-state='done'] .copy-id-step__num {
  background: rgba(74, 222, 128, 0.2);
  color: #4ade80;
}

.copy-id-step[data-state='scanning'] {
  border-color: rgba(245, 158, 11, 0.55);
}

/* ── Flip prompt ── */
.copy-flip-prompt {
  display: grid;
  justify-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 16px;
  border: 1px solid rgba(245, 158, 11, 0.5);
  border-radius: 16px;
  background: rgba(245, 158, 11, 0.08);
  text-align: center;
}

.copy-flip-prompt__icon {
  width: 96px;
  height: 64px;
  color: #f59e0b;
}

.copy-flip-prompt__text {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.4;
}

.copy-flip-prompt__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}

/* ── Settings stage summary ── */
.copy-type-summary__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid rgba(167, 170, 225, 0.18);
  border-radius: 14px;
  background: rgba(167, 170, 225, 0.05);
  font-size: 17px;
  font-weight: 800;
}

/* ── Scan warning dialog ── */
.copy-warning-dialog {
  width: calc(100% - 32px);
  max-width: 520px;
  padding: 28px;
  border: 1px solid rgba(245, 158, 11, 0.5);
  border-radius: 22px;
  background: #141738;
  color: #fff;
  text-align: center;
}

.copy-warning-dialog::backdrop {
  background: rgba(5, 6, 20, 0.7);
}

.copy-warning-dialog__title {
  margin: 0 0 10px;
  font-size: 22px;
}

.copy-warning-dialog__text {
  margin: 0 0 22px;
  font-size: 18px;
  line-height: 1.45;
}

.copy-warning-dialog__actions {
  display: flex;
  justify-content: center;
  gap: 16px;
}

.copy-warning-dialog__actions .copy-action-btn {
  min-width: 160px;
  min-height: 64px;
}
```

- [ ] **Step 8: Check the stylesheet**

```bash
grep -nE '\.(copy-layout|controls-col|source-size|steps|step[^a-z-]|scan-bed|check-btn|preview-result|clear-rescan-btn|rescan-btn|copy-footer|continue-btn|placeholder-label|preview-placeholder|preview-panel|kiosk-bg|bg-circle|page-shell|topbar|page-title)' src/public/copy/styles.css
grep -n '\.back-btn' src/public/copy/styles.css
grep -n '^\.preview-col' src/public/copy/styles.css
git diff --stat -- src/public/config/styles.css
```

Expected: the first prints nothing. The second prints only `.back-btn.back-btn--disabled`. Every line of the third contains `has-error`. The fourth prints nothing.

- [ ] **Step 9: Commit**

```bash
git add src/public/copy/index.html src/public/copy/styles.css
git commit -m "feat(copy): move /copy onto the /config layout"
```

---

### Task 11: Wire `/copy`

**Files:**

- Modify: `src/public/copy/app.ts` (rebuilt from kept blocks plus new code)

**Interfaces:**

- Consumes: everything from Tasks 2, 5, 7, 8 and 9; the element ids and the visibility contract from Task 10; `fetchWithTimeout`; `computeSheetRender`, `defaultCopyLayout`, `fitSheetInBox`, `paintPageOnSheet` from `src/public/shared/print-preview-sheet.ts`; `detectPaperSizeFromDimensions`.
- Produces, for `/confirm`: `sessionStorage['printbit.config']` from `buildCopyConfig`, `printbit.mode = 'copy'`. For a return from `/confirm`: `printbit.copyFlow`, `printbit.copySettings`, `printbit.copyIdSessionId`, `printbit.copyPreviewPath`, `printbit.copyPreviewReleaseToken`, `printbit.copySourcePaperSize`.
- Keeps: the constant `COPY_PREVIEW_REQUEST_TIMEOUT_MS = 110_000` in this file, because `src/services/scan-timeout-alignment.spec.ts` reads it from here. The ID client uses the same value.

How the page behaves (the code below implements exactly this):

- One `flow` value from the Task 7 reducer drives `render()`. Every change goes through `dispatch()`, which also writes the session keys.
- A scan disables every scan button (`flow.scanning`), shows the overlay with "Scanning…", "Scanning front…" or "Scanning back…", and locks Back.
- A failed ID scan keeps the stored sides and the server session id. The error card hides the preview until Retry.
- Retry repeats the last failed action: the same scan, the same compose, or the same preview load.
- In the settings stage, paper size (ID only) and rotation rebuild the sheet through `/compose`. Color, quality and copies change no file.
- A 409 `ID_SESSION_EXPIRED` resets the page to an empty ID capture and shows "scan again".
- Back, Start over, Change type, Scan Again, idle timeout and the printer "go home" socket events release the current scan with `/api/scanner/release`.

- [ ] **Step 1: Find the kept blocks**

Line numbers in this task refer to the file on `main`, which Tasks 1 to 10 do not change. Print any range with, for example:

```bash
git show main:src/public/copy/app.ts | sed -n '147,232p'
```

Check that line 147 is `const backBtn = document.querySelector<HTMLAnchorElement>('a.back-btn');`, line 336 starts `function sanitizeUserFacingError`, and line 443 starts `async function releaseCopyPreviewFile(`. If any differs, find the block by that first line instead.

- [ ] **Step 2: Rebuild `src/public/copy/app.ts` in this order**

Write the new file from these ten parts, top to bottom. "Keep" parts are copied byte for byte from `main`.

**Part A (new): imports.**

```ts
import {
  initializePageIdleTimeout,
  setupPageIdleWarningButton,
} from '@/services/idle-timeout';
import { initKioskLocalization } from '../shared/kiosk-i18n';
import { navigateWithKioskMotion } from '../shared/kiosk-navigation';
import { mountLoadingAnimation } from '../shared/loading-animation';
import {
  destroyPdfLoadingTask,
  type PdfLoadingTask,
} from '../shared/pdfjs-loading-task-cleanup';
import {
  getCopyTroubleshootingGuide,
  getCopyTroubleshootingGuideForCode,
} from './troubleshooting';
import {
  PAPER_POINTS,
  type Orientation,
  type PaperSize,
} from '../../shared/print-configuration';
import { slotFractions, type IdSide } from '../../shared/id-card-layout';
import {
  ID_SESSION_EXPIRED_CODE,
  type IdScanWarningCode,
} from '../../shared/id-copy-contract';
import { detectPaperSizeFromDimensions } from '../config/geometry-detection';
import { fetchWithTimeout } from '../shared/fetch-with-timeout';
import {
  computeSheetRender,
  defaultCopyLayout,
  fitSheetInBox,
  paintPageOnSheet,
} from '../shared/print-preview-sheet';
import { attachUiBlockingOverlay } from '../shared/ui-blocking-overlay';
import { buildCopyConfig } from '../shared/copy-config';
import { initPrinterGuard } from '@/guards/printer-guard';
import {
  canContinue,
  createCopyFlowState,
  isCopyTypeLocked,
  isSheetComplete,
  nextIdScanTarget,
  parseSnapshot,
  reduceCopyFlow,
  toSnapshot,
  type CopyFlowEvent,
  type CopyFlowState,
  type ScanTarget,
} from './copy-flow-state';
import {
  COPY_SETTINGS_STORAGE_KEY,
  DEFAULT_COPY_SETTINGS,
  copiesLimits,
  parseCopySettings,
  parsePaperSize,
  serializeCopySettings,
  stepCopies,
  type CopySettings,
} from './copy-settings';
import { createIdCaptureClient, type IdCaptureResult } from './id-capture';
```

**Part B (keep): lines 28–44.** The `declare const io`, `copySocket`, `export {};`, and the three start-up calls (`initKioskLocalization`, `attachUiBlockingOverlay`, `initPrinterGuard`).

**Part C (new): storage, state and idle timeout.**

```ts
// ── Session keys and page state ─────────────────────────────────────────────

const STORAGE_KEYS = {
  previewPath: 'printbit.copyPreviewPath',
  releaseToken: 'printbit.copyPreviewReleaseToken',
  sourcePaperSize: 'printbit.copySourcePaperSize',
  flow: 'printbit.copyFlow',
  idSession: 'printbit.copyIdSessionId',
  settings: COPY_SETTINGS_STORAGE_KEY,
} as const;

function setOrRemove(key: string, value: string | null): void {
  if (value) sessionStorage.setItem(key, value);
  else sessionStorage.removeItem(key);
}

function clearCopyStorage(): void {
  for (const key of Object.values(STORAGE_KEYS)) sessionStorage.removeItem(key);
  sessionStorage.removeItem('printbit.config');
  sessionStorage.removeItem('printbit.sessionId');
}

let flow: CopyFlowState = createCopyFlowState();
let settings: CopySettings = { ...DEFAULT_COPY_SETTINGS };
/** Document size chosen in the capture stage. Sets scan area and source. */
let documentSize: PaperSize = 'A4';
let previewPath: string | null = null;
let previewReleaseToken: string | null = null;
let idSessionId: string | null = null;
/** Paper and orientation of the scanned document, from the preview render. */
let documentLayout: { paperSize: PaperSize; orientation: Orientation } | null =
  null;
let previewRendered = false;
let previewRequestId = 0;
let composing = false;
let errorShown = false;
/** What the Retry button repeats. Null after a success. */
let retryAction: (() => Promise<void>) | null = null;

// ── Idle timeout ────────────────────────────────────────────────────────────

void setupPageIdleWarningButton();
void initializePageIdleTimeout({
  showWarningModal: true,
  onTimeout: () => {
    console.log('[PAGE IDLE] Copy page timeout reached, redirecting to home');
    leaveForHome('copy_idle_timeout');
  },
});
```

**Part D (keep): lines 67–90.** The `PdfjsLib`, `PDFDocumentProxy`, `PDFPageProxy` and `PDFViewport` types.

**Part E (new): elements.**

```ts
// ── Elements ────────────────────────────────────────────────────────────────

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function radios(name: string): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`),
  );
}

const copyLayout = byId('copyLayout');
const captureStage = byId('captureStage');
const settingsStage = byId('settingsStage');
const paperViewport = byId('paperViewport');
const paperSheet = byId('paperSheet');
const previewCanvas = byId<HTMLCanvasElement>('previewCanvas');
const paperPlaceholder = byId('paperPlaceholder');
const copyPlaceholderLabel = byId('copyPlaceholderLabel');
const backSlotOverlay = byId('backSlotOverlay');
const previewStatusText = byId('previewStatusText');
const copyPreviewActions = byId('copyPreviewActions');
const scanAgainBtn = byId<HTMLButtonElement>('scanAgainBtn');
const retakeFrontBtn = byId<HTMLButtonElement>('retakeFrontBtn');
const rotateFrontBtn = byId<HTMLButtonElement>('rotateFrontBtn');
const retakeBackBtn = byId<HTMLButtonElement>('retakeBackBtn');
const rotateBackBtn = byId<HTMLButtonElement>('rotateBackBtn');
const copyStep1Desc = byId('copyStep1Desc');
const idStepFront = byId('idStepFront');
const idStepFrontState = byId('idStepFrontState');
const idStepBack = byId('idStepBack');
const idStepBackState = byId('idStepBackState');
const flipPrompt = byId('flipPrompt');
const flipScanBackBtn = byId<HTMLButtonElement>('flipScanBackBtn');
const flipRetakeFrontBtn = byId<HTMLButtonElement>('flipRetakeFrontBtn');
const startOverBtn = byId<HTMLButtonElement>('startOverBtn');
const copyTypeSummary = byId('copyTypeSummary');
const changeCopyTypeBtn = byId<HTMLButtonElement>('changeCopyTypeBtn');
const copiesInput = byId<HTMLInputElement>('copies');
const copiesDec = byId<HTMLButtonElement>('copiesDec');
const copiesInc = byId<HTMLButtonElement>('copiesInc');
const checkDocBtn = byId<HTMLButtonElement>('checkDocBtn');
const scanSideBtn = byId<HTMLButtonElement>('scanSideBtn');
const scanSideLabel = byId('scanSideLabel');
const continueBtn = byId<HTMLButtonElement>('continueBtn');
const scanOverlay = byId('scanOverlay');
const copyOverlayTitle = byId('copyOverlayTitle');
const copyOverlaySub = byId('copyOverlaySub');
const copyLoadingAnimation = byId('copyLoadingAnimation');
const copyLoadingCanvas = byId<HTMLCanvasElement>('copyLoadingCanvas');
const errorBanner = byId('errorBanner');
const errorText = byId('errorText');
const retryBtn = byId<HTMLButtonElement>('retryBtn');
const copyTroubleshootingPanel = byId('copyTroubleshootingPanel');
const copyTroubleshootCauses = byId<HTMLUListElement>('copyTroubleshootCauses');
const copyTroubleshootSteps = byId<HTMLOListElement>('copyTroubleshootSteps');
const warningDialog = byId<HTMLDialogElement>('idWarningDialog');
const warningText = byId('idWarningText');
const warningKeepBtn = byId<HTMLButtonElement>('idWarningKeepBtn');
const warningRetakeBtn = byId<HTMLButtonElement>('idWarningRetakeBtn');
const copyTypeRadios = radios('copyType');
const documentSizeRadios = radios('copySourcePaperSize');
const paperSizeRadios = radios('paperSize');
const colorModeRadios = radios('colorMode');
const qualityRadios = radios('printQuality');
```

**Part F (keep): lines 147–232**, the `backBtn` constant, the document-care, ADF and printer-panel modals, the See Steps handler and the Escape handler. In this block, change both `void checkForDocument();` lines (in the `copyAdfModalCloseBtn` and `copyPrinterPanelCloseBtn` handlers) to `void retryLastScan();`.

**Part G (new): loading animation and timeouts.**

```ts
const copyLoadingController =
  copyLoadingAnimation && copyLoadingCanvas
    ? mountLoadingAnimation({
        root: copyLoadingAnimation,
        canvas: copyLoadingCanvas,
        mode: 'scan',
      })
    : null;

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) copyLoadingController?.destroy();
});

const RELEASE_TIMEOUT_MS = 1_500;
// Must stay above Node's SCAN_COMMAND_TIMEOUT_MS (100 s) so the server's more
// specific error normally wins. Guarded by scan-timeout-alignment.spec.ts.
const COPY_PREVIEW_REQUEST_TIMEOUT_MS = 110_000;

const idCapture = createIdCaptureClient({
  fetch: fetchWithTimeout,
  timeoutMs: COPY_PREVIEW_REQUEST_TIMEOUT_MS,
});
```

**Part H (keep): lines 336–441**, `sanitizeUserFacingError`, `replaceListItems`, `hideCopyTroubleshooting`, `showCopyTroubleshooting`, `setBackNavigationLocked` and the `backBtn` click guard.

**Part I (keep): lines 443–482**, `releaseCopyPreviewFile`.

**Part J (new): everything else.**

```ts
// ── Small DOM helpers ───────────────────────────────────────────────────────

function setHidden(element: Element | null, hidden: boolean): void {
  element?.classList.toggle('hidden', hidden);
}

function setDisabled(
  button: HTMLButtonElement | null,
  disabled: boolean,
): void {
  if (!button) return;
  button.disabled = disabled;
  button.setAttribute('aria-disabled', String(disabled));
}

function lockCard(input: HTMLInputElement, locked: boolean): void {
  input.closest('.option-card')?.setAttribute('data-locked', String(locked));
}

// ── Release and leave ───────────────────────────────────────────────────────

function releaseCurrentPreview(reason: string): void {
  if (previewReleaseToken) {
    void releaseCopyPreviewFile(previewReleaseToken, reason);
  }
}

function leaveForHome(reason: string): void {
  releaseCurrentPreview(reason);
  clearCopyStorage();
  navigateWithKioskMotion('/', 'replace');
}

// ── Scan overlay ────────────────────────────────────────────────────────────

const OVERLAY_TITLES: Record<ScanTarget, string> = {
  document: 'Scanning…',
  front: 'Scanning front…',
  back: 'Scanning back…',
};

function overlaySubtitle(target: ScanTarget): string {
  if (target !== 'document') {
    return 'Keep the lid closed and your ID on the marked corner.';
  }
  return documentSize === 'Long'
    ? 'Please keep the document straight in the feeder.'
    : 'Please keep the document flat on the glass.';
}

function showOverlay(target: ScanTarget | null): void {
  if (!scanOverlay) return;
  copyLoadingController?.setActive(target !== null);
  if (target) {
    if (copyOverlayTitle) copyOverlayTitle.textContent = OVERLAY_TITLES[target];
    if (copyOverlaySub) copyOverlaySub.textContent = overlaySubtitle(target);
  }
  scanOverlay.classList.toggle('is-visible', target !== null);
  scanOverlay.setAttribute('aria-hidden', target ? 'false' : 'true');
}

// ── Error card ──────────────────────────────────────────────────────────────

function setPreviewBlockedByError(blocked: boolean): void {
  errorBanner?.closest('.preview-col')?.classList.toggle('has-error', blocked);
}

function showError(message: string, usesAdf = false, code?: string): void {
  const safeMessage = showCopyTroubleshooting(message, usesAdf, code);
  errorShown = true;
  setPreviewBlockedByError(true);
  if (errorBanner) errorBanner.style.display = '';
  if (errorText) errorText.textContent = safeMessage;
  render();
}

function hideError(): void {
  errorShown = false;
  setPreviewBlockedByError(false);
  if (errorBanner) errorBanner.style.display = 'none';
  hideCopyTroubleshooting();
}

function clearSimulatedError(): void {
  hideError();
  closeCopyAdfModal();
  closeCopyPrinterPanelModal();
  render();
  if (previewPath && !previewRendered) void showPreview(previewPath);
}

// ── Printer sockets ─────────────────────────────────────────────────────────

const ADF_ERROR_MESSAGE =
  'Printer ADF Error Detected. Clear the printer ADF error or paper jam, then proceed with scanning.';

function setupCopySocket(): void {
  if (!copySocket) return;

  copySocket.on('scan:adf-error', (payload: unknown) => {
    const errorMsg =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : ADF_ERROR_MESSAGE;
    showError(errorMsg, true);
  });

  copySocket.on('printer:simulation-state', (payload: unknown) => {
    const p = payload as { activeError?: string | null } | null;
    if (p?.activeError === 'adf_error') {
      showError(ADF_ERROR_MESSAGE, true);
    } else if (!p?.activeError) {
      clearSimulatedError();
    }
  });

  copySocket.on('printer:simulation-cleared', (payload: unknown) => {
    const p = payload as { redirectHome?: boolean } | null;
    if (p?.redirectHome) {
      leaveForHome('copy_simulation_cleared');
      return;
    }
    clearSimulatedError();
  });

  copySocket.on('printer:paper-jam-cleared', () => {
    leaveForHome('copy_paper_jam_cleared');
  });

  copySocket.on('printerStatusRestored', () => clearSimulatedError());
  copySocket.on('printerRecovered', () => clearSimulatedError());
}

// ── Sheet preview ───────────────────────────────────────────────────────────

function sizePaperSheet(
  paperSize: PaperSize,
  orientation: Orientation,
): { width: number; height: number } {
  const [width, height] = PAPER_POINTS[paperSize];
  const [paperWidth, paperHeight] =
    orientation === 'landscape' ? [height, width] : [width, height];
  const boxWidth = Math.max((paperViewport?.clientWidth ?? 840) - 24, 240);
  const boxHeight = Math.max((paperViewport?.clientHeight ?? 1188) - 24, 320);
  const sheet = fitSheetInBox(paperWidth, paperHeight, boxWidth, boxHeight);
  if (paperSheet) {
    paperSheet.style.width = `${sheet.width}px`;
    paperSheet.style.height = `${sheet.height}px`;
  }
  return sheet;
}

function emptySheetPaperSize(): PaperSize {
  return flow.copyType === 'document' ? documentSize : settings.paperSize;
}

/** Places the dashed back slot where the back will print. */
function positionBackSlot(): void {
  if (!backSlotOverlay) return;
  const slot = slotFractions(settings.paperSize, 'back');
  backSlotOverlay.style.left = `${slot.left * 100}%`;
  backSlotOverlay.style.top = `${slot.top * 100}%`;
  backSlotOverlay.style.width = `${slot.width * 100}%`;
  backSlotOverlay.style.height = `${slot.height * 100}%`;
}

async function renderPdfPreview(
  buf: ArrayBuffer,
  paperSizeHint: PaperSize,
): Promise<{ paperSize: PaperSize; orientation: Orientation }> {
  if (!previewCanvas) throw new Error('Preview canvas not found');

  const dynImport = new Function('u', 'return import(u)') as (
    u: string,
  ) => Promise<Record<string, unknown>>;
  const mod = await dynImport('/libs/pdfjs/pdf.min.mjs');
  const pdfjs = (mod.default ?? mod) as PdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = `${window.location.origin}/libs/pdfjs/pdf.worker.min.mjs`;

  const loadingTask = pdfjs.getDocument({ data: buf });
  const pdfDoc = await loadingTask.promise;
  try {
    const firstPage = await pdfDoc.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });

    // Same sheet layout as the printed page: the page sits inside the print
    // margins, not stretched edge to edge.
    const layoutConfig = defaultCopyLayout(
      detectPaperSizeFromDimensions(baseViewport.width, baseViewport.height) ??
        paperSizeHint,
      baseViewport.width,
      baseViewport.height,
    );
    const sheet = sizePaperSheet(
      layoutConfig.paperSize,
      layoutConfig.orientation,
    );
    const sheetRender = computeSheetRender(
      baseViewport.width,
      baseViewport.height,
      layoutConfig,
      sheet.width,
      sheet.height,
      window.devicePixelRatio || 1,
    );
    const viewport = firstPage.getViewport({ scale: sheetRender.renderScale });

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = Math.max(1, Math.ceil(viewport.width));
    sourceCanvas.height = Math.max(1, Math.ceil(viewport.height));
    const sourceCtx = sourceCanvas.getContext('2d');
    const ctx = previewCanvas.getContext('2d');
    if (!sourceCtx || !ctx) throw new Error('Canvas context unavailable');
    await firstPage.render({ canvasContext: sourceCtx, viewport }).promise;

    previewCanvas.width = sheetRender.canvasWidth;
    previewCanvas.height = sheetRender.canvasHeight;
    paintPageOnSheet(
      ctx,
      previewCanvas,
      sourceCanvas,
      viewport.width,
      viewport.height,
      sheetRender.rotationRad,
    );
    return {
      paperSize: layoutConfig.paperSize,
      orientation: layoutConfig.orientation,
    };
  } finally {
    await destroyPdfLoadingTask(loadingTask);
  }
}

async function showPreview(filename: string): Promise<void> {
  const requestId = ++previewRequestId;
  previewRendered = false;
  render();
  try {
    const response = await fetch(
      `/api/scan/preview/${encodeURIComponent(filename)}`,
    );
    if (!response.ok) {
      throw new Error(`Preview request failed (${response.status})`);
    }
    const buf = await response.arrayBuffer();
    if (requestId !== previewRequestId) return;
    const layout = await renderPdfPreview(
      buf,
      flow.copyType === 'id' ? settings.paperSize : documentSize,
    );
    if (requestId !== previewRequestId) return;
    if (flow.copyType === 'document') documentLayout = layout;
    previewRendered = true;
  } catch (error) {
    if (requestId !== previewRequestId) return;
    console.error('[COPY PREVIEW] Failed to render preview.', error);
    retryAction = async () => {
      hideError();
      await showPreview(filename);
    };
    showError('Could not render scanned preview. Please retry.');
    return;
  }
  render();
}

// ── Render ──────────────────────────────────────────────────────────────────

const WARNING_TEXT: Record<IdScanWarningCode, string> = {
  side_blank:
    'This side looks empty. Is your ID on the marked corner, face-down?',
  sides_identical: 'Front and back look the same. Did you flip your ID?',
};

function outputPaperSize(): PaperSize {
  return flow.copyType === 'document'
    ? (documentLayout?.paperSize ?? documentSize)
    : settings.paperSize;
}

function placeholderText(): string {
  if (flow.copyType === 'id') {
    return 'Place your ID face-down on the marked corner, then tap Scan Front';
  }
  return documentSize === 'Long'
    ? 'Insert document face-up in the ADF, then tap Check Document'
    : 'Place your document face-down, then tap Check Document';
}

function statusText(): { text: string; status: 'loading' | 'ready' | null } {
  if (composing) return { text: 'Updating preview…', status: 'loading' };
  if (previewPath && !previewRendered) {
    return { text: 'Loading preview…', status: 'loading' };
  }
  if (flow.copyType === 'id' && flow.front && !flow.back) {
    return { text: 'Waiting for back side', status: null };
  }
  if (previewRendered && isSheetComplete(flow)) {
    return { text: 'Ready to copy', status: 'ready' };
  }
  return { text: 'Waiting for scan', status: null };
}

function renderStep(
  step: HTMLElement | null,
  label: HTMLElement | null,
  side: IdSide,
): void {
  const state =
    flow.scanning === side ? 'scanning' : flow[side] ? 'done' : 'waiting';
  step?.setAttribute('data-state', state);
  if (label) {
    label.textContent =
      state === 'scanning' ? 'Scanning' : state === 'done' ? 'Done' : 'Waiting';
  }
}

function renderSettingsControls(busy: boolean): void {
  const paper = outputPaperSize();
  const paperLocked = flow.copyType === 'document';
  for (const radio of paperSizeRadios) {
    radio.checked = radio.value === paper;
    radio.disabled = paperLocked || busy;
    lockCard(radio, paperLocked && !radio.checked);
  }
  for (const radio of colorModeRadios) {
    radio.checked = radio.value === settings.colorMode;
  }
  for (const radio of qualityRadios) {
    radio.checked = radio.value === settings.quality;
  }
  if (copiesInput) copiesInput.value = String(settings.copies);
  const limits = copiesLimits(settings.copies);
  setDisabled(copiesDec, !limits.canDecrease);
  setDisabled(copiesInc, !limits.canIncrease);
}

function renderWarningDialog(): void {
  if (!warningDialog) return;
  const warning = flow.scanning === null ? flow.pendingWarnings[0] : undefined;
  if (!warning) {
    if (warningDialog.open) warningDialog.close();
    return;
  }
  if (warningText) warningText.textContent = WARNING_TEXT[warning.code];
  if (!warningDialog.open) warningDialog.showModal();
}

function render(): void {
  const busy = flow.scanning !== null || composing;
  const locked = isCopyTypeLocked(flow);
  const inCapture = flow.stage === 'capture';
  const idTarget = nextIdScanTarget(flow);
  const awaitingAnswer = flow.pendingWarnings.length > 0;
  const hasPreview = Boolean(previewPath) && previewRendered;

  if (copyLayout) {
    copyLayout.dataset.copyType = flow.copyType;
    copyLayout.dataset.copyStage = flow.stage;
  }
  setHidden(captureStage, !inCapture);
  setHidden(settingsStage, inCapture);

  for (const radio of copyTypeRadios) {
    radio.checked = radio.value === flow.copyType;
    radio.disabled = locked;
    lockCard(radio, locked && !radio.checked);
  }
  for (const radio of documentSizeRadios) {
    radio.checked = radio.value === documentSize;
    radio.disabled = locked;
    lockCard(radio, locked && !radio.checked);
  }
  if (copyStep1Desc) {
    copyStep1Desc.textContent =
      documentSize === 'Long'
        ? 'Insert document face-up into the ADF, short edge first'
        : 'Align the paper face-down on the glass scanner';
  }

  renderStep(idStepFront, idStepFrontState, 'front');
  renderStep(idStepBack, idStepBackState, 'back');
  setHidden(
    flipPrompt,
    !(flow.copyType === 'id' && flow.front && !flow.back && !awaitingAnswer),
  );
  setDisabled(flipScanBackBtn, busy);
  setDisabled(flipRetakeFrontBtn, busy);
  setHidden(
    startOverBtn,
    !(flow.copyType === 'id' && (flow.front || flow.back)),
  );
  setDisabled(startOverBtn, busy);

  setHidden(checkDocBtn, !inCapture);
  setDisabled(checkDocBtn, busy);
  setHidden(scanSideBtn, !inCapture || idTarget === null);
  setDisabled(scanSideBtn, busy || awaitingAnswer);
  if (scanSideLabel) {
    scanSideLabel.textContent =
      idTarget === 'back' ? 'Scan Back' : 'Scan Front';
  }

  if (copyTypeSummary) {
    copyTypeSummary.textContent =
      flow.copyType === 'id' ? 'ID Card' : 'Document';
  }
  setDisabled(changeCopyTypeBtn, busy);
  renderSettingsControls(busy);

  setHidden(copyPreviewActions, inCapture);
  setDisabled(scanAgainBtn, busy);
  setDisabled(retakeFrontBtn, busy);
  setDisabled(retakeBackBtn, busy);
  setDisabled(rotateFrontBtn, busy || !flow.front);
  setDisabled(rotateBackBtn, busy || !flow.back);

  setHidden(paperPlaceholder, hasPreview);
  if (previewCanvas)
    previewCanvas.style.display = hasPreview ? 'block' : 'none';
  if (copyPlaceholderLabel)
    copyPlaceholderLabel.textContent = placeholderText();
  setHidden(
    backSlotOverlay,
    !(hasPreview && flow.copyType === 'id' && flow.front && !flow.back),
  );
  if (!hasPreview) sizePaperSheet(emptySheetPaperSize(), 'portrait');
  paperSheet?.toggleAttribute('data-gray', settings.colorMode === 'grayscale');

  const status = statusText();
  if (previewStatusText) {
    previewStatusText.textContent = status.text;
    if (status.status)
      previewStatusText.setAttribute('data-status', status.status);
    else previewStatusText.removeAttribute('data-status');
  }

  setHidden(continueBtn, inCapture);
  setDisabled(
    continueBtn,
    !canContinue(flow) || !hasPreview || errorShown || composing,
  );

  renderWarningDialog();
}

// ── State changes ───────────────────────────────────────────────────────────

function persist(): void {
  sessionStorage.setItem(STORAGE_KEYS.flow, JSON.stringify(toSnapshot(flow)));
  sessionStorage.setItem(
    STORAGE_KEYS.settings,
    serializeCopySettings(settings),
  );
  sessionStorage.setItem(STORAGE_KEYS.sourcePaperSize, documentSize);
  setOrRemove(STORAGE_KEYS.previewPath, previewPath);
  setOrRemove(STORAGE_KEYS.releaseToken, previewReleaseToken);
  setOrRemove(STORAGE_KEYS.idSession, idSessionId);
}

function dispatch(event: CopyFlowEvent): void {
  flow = reduceCopyFlow(flow, event);
  persist();
  render();
}

/** Starts a scan. False when the reducer refused it (busy or wrong type). */
function beginScan(target: ScanTarget): boolean {
  const next = reduceCopyFlow(flow, { type: 'scan-started', target });
  if (next === flow) return false;
  hideError();
  setBackNavigationLocked(true);
  showOverlay(target);
  flow = next;
  persist();
  render();
  return true;
}

function endScan(): void {
  showOverlay(null);
  setBackNavigationLocked(false);
}

/**
 * Takes a new preview file. A replaced document scan is released here; an ID
 * sheet is not, because the server already retired its old token and a
 * release by token would delete the whole ID session.
 */
function adoptPreview(path: string, token: string): void {
  if (
    flow.copyType === 'document' &&
    previewReleaseToken &&
    previewReleaseToken !== token
  ) {
    void releaseCopyPreviewFile(previewReleaseToken, 'copy_preview_replaced');
  }
  previewPath = path;
  previewReleaseToken = token;
  previewRendered = false;
}

function startOver(): void {
  if (flow.scanning !== null || composing) return;
  releaseCurrentPreview('copy_start_over');
  previewRequestId += 1;
  previewPath = null;
  previewReleaseToken = null;
  idSessionId = null;
  documentLayout = null;
  previewRendered = false;
  retryAction = null;
  hideError();
  dispatch({ type: 'start-over' });
}

function resetAfterExpiry(message: string): void {
  previewRequestId += 1;
  previewPath = null;
  previewReleaseToken = null;
  idSessionId = null;
  previewRendered = false;
  flow = createCopyFlowState('id');
  retryAction = () => scanIdSide('front');
  persist();
  showError(message, false, ID_SESSION_EXPIRED_CODE);
}

// ── Scans ───────────────────────────────────────────────────────────────────

async function checkForDocument(): Promise<void> {
  if (!beginScan('document')) return;
  retryAction = checkForDocument;

  try {
    const res = await fetchWithTimeout(
      '/api/scan/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paperSize: documentSize }),
      },
      COPY_PREVIEW_REQUEST_TIMEOUT_MS,
      'Document check',
    );
    const data = (await res.json()) as {
      detected?: boolean;
      previewPath?: string;
      releaseToken?: string;
      code?: string;
      error?: string;
    };
    endScan();

    if (data.detected && data.previewPath && data.releaseToken) {
      adoptPreview(data.previewPath, data.releaseToken);
      documentLayout = null;
      retryAction = null;
      dispatch({ type: 'document-scanned' });
      await showPreview(data.previewPath);
      return;
    }

    dispatch({ type: 'scan-failed' });
    const usesAdf =
      documentSize === 'Long' || /adf|feeder/i.test(data.error ?? '');
    // No "No document detected" default: a response without an error text
    // is a server-side failure, not an empty scanner.
    showError(
      data.error ?? 'Could not complete scanner check. Please try again.',
      usesAdf,
      data.code ?? (data.error ? undefined : 'SCAN_FAILED'),
    );
  } catch (error) {
    endScan();
    dispatch({ type: 'scan-failed' });
    const timedOut =
      error instanceof Error && error.message.includes('timed out');
    showError(
      timedOut
        ? error.message
        : 'Could not reach the scanner. Please try again.',
      documentSize === 'Long',
      timedOut ? 'SCANNER_TIMEOUT' : 'SCANNER_OFFLINE',
    );
  }
}

function handleIdFailure(
  result: Exclude<IdCaptureResult, { kind: 'sheet' }>,
): void {
  if (result.kind === 'expired') {
    resetAfterExpiry(result.error);
    return;
  }
  if (result.kind === 'scan-failed' && result.sessionId) {
    idSessionId = result.sessionId;
    persist();
  }
  showError(result.error, false, result.code);
}

async function scanIdSide(side: IdSide): Promise<void> {
  if (!beginScan(side)) return;
  retryAction = () => scanIdSide(side);

  const result = await idCapture.scanSide({
    sessionId: idSessionId,
    side,
    paperSize: settings.paperSize,
  });
  endScan();

  if (result.kind === 'sheet') {
    idSessionId = result.sheet.sessionId;
    adoptPreview(result.sheet.previewPath, result.sheet.releaseToken);
    retryAction = null;
    dispatch({ type: 'side-scanned', side, warnings: result.sheet.warnings });
    await showPreview(result.sheet.previewPath);
    return;
  }

  dispatch({ type: 'scan-failed' });
  handleIdFailure(result);
}

/** Rebuilds the ID sheet for the current paper size and rotations. */
async function recompose(): Promise<void> {
  if (!idSessionId || composing || flow.scanning !== null) return;
  retryAction = async () => {
    hideError();
    await recompose();
  };
  composing = true;
  render();

  const result = await idCapture.compose({
    sessionId: idSessionId,
    paperSize: settings.paperSize,
    rotations: flow.rotations,
  });
  composing = false;

  if (result.kind === 'sheet') {
    adoptPreview(result.sheet.previewPath, result.sheet.releaseToken);
    retryAction = null;
    persist();
    await showPreview(result.sheet.previewPath);
    return;
  }
  if (result.kind === 'expired') {
    resetAfterExpiry(result.error);
    return;
  }
  showError(result.error, false, result.code);
}

function rotateSide(side: IdSide): void {
  if (composing) return;
  const before = flow;
  dispatch({ type: 'side-rotated', side });
  if (flow !== before) void recompose();
}

async function retryLastScan(): Promise<void> {
  if (retryAction) {
    await retryAction();
    return;
  }
  hideError();
  render();
  if (previewPath && !previewRendered) {
    await showPreview(previewPath);
    return;
  }
  if (flow.stage !== 'capture') return;
  if (flow.copyType === 'document') {
    await checkForDocument();
    return;
  }
  const side = nextIdScanTarget(flow);
  if (side) await scanIdSide(side);
}

// ── Events ──────────────────────────────────────────────────────────────────

for (const radio of copyTypeRadios) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    dispatch({
      type: 'copy-type-selected',
      copyType: radio.value === 'id' ? 'id' : 'document',
    });
  });
}

for (const radio of documentSizeRadios) {
  radio.addEventListener('change', () => {
    const size = parsePaperSize(radio.value);
    if (!radio.checked || !size || isCopyTypeLocked(flow)) return;
    documentSize = size;
    persist();
    render();
  });
}

for (const radio of paperSizeRadios) {
  radio.addEventListener('change', () => {
    const size = parsePaperSize(radio.value);
    if (!radio.checked || !size || flow.copyType !== 'id') return;
    if (size === settings.paperSize) return;
    settings = { ...settings, paperSize: size };
    positionBackSlot();
    persist();
    void recompose();
  });
}

for (const radio of colorModeRadios) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    settings = {
      ...settings,
      colorMode: radio.value === 'grayscale' ? 'grayscale' : 'colored',
    };
    persist();
    render();
  });
}

for (const radio of qualityRadios) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    settings = {
      ...settings,
      quality: radio.value === 'high' ? 'high' : 'standard',
    };
    persist();
    render();
  });
}

copiesDec?.addEventListener('click', () => {
  settings = { ...settings, copies: stepCopies(settings.copies, -1) };
  persist();
  render();
});
copiesInc?.addEventListener('click', () => {
  settings = { ...settings, copies: stepCopies(settings.copies, 1) };
  persist();
  render();
});

checkDocBtn?.addEventListener('click', () => void checkForDocument());
scanSideBtn?.addEventListener('click', () => {
  const side = nextIdScanTarget(flow);
  if (side) void scanIdSide(side);
});
flipScanBackBtn?.addEventListener('click', () => void scanIdSide('back'));
flipRetakeFrontBtn?.addEventListener('click', () => void scanIdSide('front'));
startOverBtn?.addEventListener('click', startOver);
changeCopyTypeBtn?.addEventListener('click', startOver);
scanAgainBtn?.addEventListener('click', startOver);
retakeFrontBtn?.addEventListener('click', () => void scanIdSide('front'));
retakeBackBtn?.addEventListener('click', () => void scanIdSide('back'));
rotateFrontBtn?.addEventListener('click', () => rotateSide('front'));
rotateBackBtn?.addEventListener('click', () => rotateSide('back'));
retryBtn?.addEventListener('click', () => void retryLastScan());

warningDialog?.addEventListener('cancel', (event) => event.preventDefault());
warningKeepBtn?.addEventListener('click', () => {
  dispatch({ type: 'warning-kept' });
});
warningRetakeBtn?.addEventListener('click', () => {
  const side = flow.pendingWarnings[0]?.side;
  dispatch({ type: 'warning-retake' });
  if (side) void scanIdSide(side);
});

backBtn?.addEventListener('click', () => {
  if (backBtn.getAttribute('aria-disabled') === 'true') return;
  releaseCurrentPreview('copy_back_home');
  clearCopyStorage();
});

continueBtn?.addEventListener('click', () => {
  if (!canContinue(flow) || !previewPath || !previewRendered) return;
  if (errorShown || composing) return;
  const orientation: Orientation =
    flow.copyType === 'document'
      ? (documentLayout?.orientation ?? 'portrait')
      : 'portrait';
  const config = buildCopyConfig({
    previewPath,
    releaseToken: previewReleaseToken,
    paperSize: outputPaperSize(),
    orientation,
    colorMode: settings.colorMode,
    quality: settings.quality,
    copies: settings.copies,
  });
  persist();
  sessionStorage.setItem('printbit.mode', 'copy');
  sessionStorage.removeItem('printbit.sessionId');
  sessionStorage.removeItem('printbit.uploadedFile');
  sessionStorage.setItem('printbit.config', JSON.stringify(config));
  navigateWithKioskMotion('/confirm');
});

let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (previewPath && previewRendered) void showPreview(previewPath);
    else render();
  }, 150);
});

// ── Start ───────────────────────────────────────────────────────────────────

async function initializeCopyPage(): Promise<void> {
  setupCopySocket();

  void fetch('/api/printer/simulation-status')
    .then((res) => (res.ok ? res.json() : null))
    .then(
      (
        data: {
          activeError?: string | null;
          simulation?: { activeError?: string | null };
        } | null,
      ) => {
        const activeError = data?.activeError ?? data?.simulation?.activeError;
        if (activeError === 'adf_error') showError(ADF_ERROR_MESSAGE, true);
      },
    )
    .catch(() => {});

  documentSize =
    parsePaperSize(sessionStorage.getItem(STORAGE_KEYS.sourcePaperSize)) ??
    'A4';
  previewPath = sessionStorage.getItem(STORAGE_KEYS.previewPath);
  previewReleaseToken = sessionStorage.getItem(STORAGE_KEYS.releaseToken);
  idSessionId = sessionStorage.getItem(STORAGE_KEYS.idSession);
  const snapshot = parseSnapshot(sessionStorage.getItem(STORAGE_KEYS.flow));

  if (
    previewPath &&
    snapshot &&
    (snapshot.copyType === 'document' || idSessionId)
  ) {
    // Back from /confirm, or a reload: restore scans, rotations and settings.
    settings = parseCopySettings(sessionStorage.getItem(STORAGE_KEYS.settings));
    flow = reduceCopyFlow(flow, { type: 'restored', snapshot });
  } else if (previewPath && !snapshot) {
    // A preview saved by the page before this change: a document scan.
    flow = reduceCopyFlow(flow, { type: 'document-scanned' });
  } else {
    // Nothing usable. Settings never carry over to a new customer.
    releaseCurrentPreview('copy_restore_discarded');
    previewPath = null;
    previewReleaseToken = null;
    idSessionId = null;
  }

  positionBackSlot();
  persist();
  render();
  if (previewPath) await showPreview(previewPath);
}

void initializeCopyPage();
```

- [ ] **Step 3: Type-check, lint, test and build**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `pnpm lint`
Expected: no errors.

Run: `pnpm exec jest src/public src/services/scan-timeout-alignment.spec.ts`
Expected: PASS. The alignment spec still finds `COPY_PREVIEW_REQUEST_TIMEOUT_MS` in `src/public/copy/app.ts`.

Run: `pnpm build`
Expected: completes; `src/public/copy/app.js` is regenerated (it is git-ignored).

- [ ] **Step 4: Check the page in a browser with the stub scanner**

With no scanner attached, run the worker with stub fallback on (`Scanner:EnableStubFallback = true` in your local, uncommitted `appsettings.Development.json`), then `pnpm worker:dev` and `pnpm dev` in two terminals. Open `/copy`.

Check each line and note the result:

1. Document: the right pane shows "What are you copying?", Document Size and Check Document. No print settings, no Continue.
2. Check Document: overlay says "Scanning…". Then the stage switches to settings, Document Size shows as the locked paper size, and the preview sits inside the print margins as before.
3. Grayscale turns the preview gray. Copies stop at 1 and 30.
4. Continue to Payment opens `/confirm` with the right price, paper, color and copies. Back on `/confirm` returns to `/copy` in the settings stage with the same settings.
5. Change type returns to the capture stage, unlocked, with the placement diagram.
6. ID Card: the diagram shows the marked corner. Scan Front: overlay says "Scanning front…"; then the flip prompt appears, step 1 says Done and the dashed slot sits where the back will print.
7. Scan Back from the flip prompt: overlay says "Scanning back…"; the settings stage opens with both cards stacked.
8. Rotate front twice, then Retake front: the front comes back upright, the back keeps its rotation.
9. Paper size Short then Long: the sheet is rebuilt each time with no rescan.
10. Stop the worker, tap Retake back: the error card shows; start the worker, tap Retry: the back is scanned again and the front is still there.
11. Restart `pnpm dev` (Node only), then Rotate back: the page shows the expired message and resets to an empty ID capture.
12. Wait for the idle timeout on `/copy` with an ID in progress: the page goes home and the `id-side-*` and `id-copy-*` files are gone from `uploads/scans`.

The stub alternates two shades, so the scan warnings stay quiet here. Warnings are checked on hardware in Task 13.

- [ ] **Step 5: Commit**

```bash
git add src/public/copy/app.ts
git commit -m "feat(copy): wire ID card copy and merged settings into /copy"
```

---

### Task 12: "Copying n/N", `/config` redirect, translations

**Files:**

- Modify: `src/public/confirm/printing-stage.ts`
- Create: `src/public/confirm/printing-stage.spec.ts`
- Modify: `src/public/confirm/app.ts` (`renderPrintProgress`)
- Modify: `src/public/config/index.html` (`<head>`)
- Modify: `src/locales/en/translation.json`, `src/locales/fil/translation.json`

**Interfaces:**

- Consumes: `PrintConfig.mode` (`'print' | 'copy' | 'scan'`) already parsed into `config` at the top of `src/public/confirm/app.ts`.
- Produces: `PrintingStageInput.mode?: 'print' | 'copy' | 'scan'`. Copy jobs get the label `Copying ${n}/${N}`; every other mode keeps `Printing page ${n} of ${N}`. The "Preparing your print job…" labels do not change.

- [ ] **Step 1: Write the failing test**

Create `src/public/confirm/printing-stage.spec.ts`:

```ts
import { getPrintingStage } from './printing-stage';

describe('getPrintingStage', () => {
  it('words print progress as before', () => {
    expect(getPrintingStage({ pagesPrinted: 2, totalPages: 5 })).toEqual({
      label: 'Printing page 2 of 5',
      progress: 40,
    });
  });

  it('words copy progress like the printer panel', () => {
    expect(
      getPrintingStage({ pagesPrinted: 2, totalPages: 5, mode: 'copy' }),
    ).toEqual({ label: 'Copying 2/5', progress: 40 });
  });

  it('never counts past the total', () => {
    expect(
      getPrintingStage({ pagesPrinted: 7, totalPages: 5, mode: 'copy' }).label,
    ).toBe('Copying 5/5');
  });

  it('prepares before the first copy page', () => {
    expect(
      getPrintingStage({ pagesPrinted: 0, totalPages: 5, mode: 'copy' }),
    ).toEqual({ label: 'Preparing your print job…', progress: 0 });
  });

  it('prepares while the total is unknown', () => {
    expect(
      getPrintingStage({ pagesPrinted: 3, totalPages: null, mode: 'copy' }),
    ).toEqual({ label: 'Preparing your print job…', progress: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/public/confirm/printing-stage.spec.ts`
Expected: FAIL with a type error that `mode` does not exist in type `PrintingStageInput`.

- [ ] **Step 3: Add the copy wording**

In `src/public/confirm/printing-stage.ts`, replace the interface:

```ts
export interface PrintingStageInput {
  pagesPrinted: number;
  totalPages: number | null;
}
```

with:

```ts
export interface PrintingStageInput {
  pagesPrinted: number;
  totalPages: number | null;
  /** Copy jobs mirror the printer's own "Copying n/N" wording. */
  mode?: 'print' | 'copy' | 'scan';
}
```

In `getPrintingStage`, replace:

```ts
    label: `Printing page ${currentPage} of ${input.totalPages}`,
```

with:

```ts
    label:
      input.mode === 'copy'
        ? `Copying ${currentPage}/${input.totalPages}`
        : `Printing page ${currentPage} of ${input.totalPages}`,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/public/confirm/printing-stage.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Pass the mode from `/confirm`**

In `src/public/confirm/app.ts`, inside `renderPrintProgress`, replace:

```ts
const stage = getPrintingStage({ pagesPrinted: currentPage, totalPages });
```

with:

```ts
const stage = getPrintingStage({
  pagesPrinted: currentPage,
  totalPages,
  mode: config.mode,
});
```

- [ ] **Step 6: Redirect `/config?mode=copy`**

In `src/public/config/index.html`, directly after `<meta charset="UTF-8" />`, add:

```html
<script>
  // Copy settings live on /copy now. Only the query decides: a stale
  // printbit.mode in session storage must not move a print customer.
  if (new URLSearchParams(window.location.search).get('mode') === 'copy') {
    window.location.replace('/copy');
  }
</script>
```

- [ ] **Step 7: Add the translations**

Add each pair below to `src/locales/fil/translation.json`, and the same key with itself as the value to `src/locales/en/translation.json`. Both files are sorted by key; insert each entry at its sorted position and keep the commas valid.

| Key (English)                                                                       | Filipino                                                                                                   |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Back side                                                                           | Likod                                                                                                      |
| Back side not scanned yet                                                           | Hindi pa na-scan ang likod                                                                                 |
| Change type                                                                         | Palitan ang uri                                                                                            |
| Check your scan                                                                     | Suriin ang iyong scan                                                                                      |
| Continue to Payment                                                                 | Magpatuloy sa Pagbabayad                                                                                   |
| Copy Preview                                                                        | Preview ng Kopya                                                                                           |
| Copy type                                                                           | Uri ng kopya                                                                                               |
| Front and back look the same. Did you flip your ID?                                 | Mukhang pareho ang harap at likod. Binaligtad mo ba ang iyong ID?                                          |
| Front captured. Turn your ID over, place it on the same corner, then tap Scan Back. | Na-scan na ang harap. Baligtarin ang iyong ID, ilagay sa parehong sulok, at pindutin ang I-scan ang Likod. |
| Front side                                                                          | Harap                                                                                                      |
| ID Card                                                                             | ID Card                                                                                                    |
| Insert document face-up in the ADF, then tap Check Document                         | Ipasok ang dokumento nang nakaharap pataas sa ADF, at pindutin ang Suriin ang Dokumento                    |
| Insert document face-up into the ADF, short edge first                              | Ipasok ang dokumento nang nakaharap pataas sa ADF, maikling gilid muna                                     |
| Keep anyway                                                                         | Ituloy pa rin                                                                                              |
| Keep the lid closed and your ID on the marked corner.                               | Panatilihing nakasara ang takip at ang ID sa may markang sulok.                                            |
| Place your ID face-down on the marked corner of the glass.                          | Ilagay ang iyong ID nang nakataob sa may markang sulok ng salamin.                                         |
| Place your ID face-down on the marked corner, then tap Scan Front                   | Ilagay ang iyong ID nang nakataob sa may markang sulok, at pindutin ang I-scan ang Harap                   |
| Place your document face-down, then tap Check Document                              | Ilagay ang dokumento nang nakataob, at pindutin ang Suriin ang Dokumento                                   |
| Please keep the document straight in the feeder.                                    | Panatilihing tuwid ang dokumento sa feeder.                                                                |
| Retake                                                                              | Ulitin                                                                                                     |
| Retake back                                                                         | Ulitin ang likod                                                                                           |
| Retake front                                                                        | Ulitin ang harap                                                                                           |
| Rotate back                                                                         | Iikot ang likod                                                                                            |
| Rotate front                                                                        | Iikot ang harap                                                                                            |
| Scan Again                                                                          | I-scan Muli                                                                                                |
| Scan Back                                                                           | I-scan ang Likod                                                                                           |
| Scan Front                                                                          | I-scan ang Harap                                                                                           |
| Scan both sides                                                                     | I-scan ang magkabilang panig                                                                               |
| Scanning back…                                                                      | Ini-scan ang likod…                                                                                        |
| Scanning front…                                                                     | Ini-scan ang harap…                                                                                        |
| Scanning…                                                                           | Ini-scan…                                                                                                  |
| Start over                                                                          | Magsimula muli                                                                                             |
| This side looks empty. Is your ID on the marked corner, face-down?                  | Mukhang walang laman ang panig na ito. Nasa may markang sulok ba ang iyong ID, nakataob?                   |
| Updating preview…                                                                   | Ina-update ang preview…                                                                                    |
| Waiting for back side                                                               | Hinihintay ang likod                                                                                       |
| What are you copying?                                                               | Ano ang kokopyahin mo?                                                                                     |
| Your ID scan session expired. Please scan your ID again.                            | Nag-expire ang iyong ID scan session. Pakiscan muli ang iyong ID.                                          |

The "…" in keys is the single character U+2026, as in the existing "Scanning document…" key. Strings already in both files are reused, not added: Document, Document Size, A4 Bond, Short Bond, Long Bond, Color, Grayscale, Standard, High Quality, Print Quality, Color Mode, Paper Size, Copies, Check Document, Waiting, Scanning, Done, Ready to copy, Loading preview…, Waiting for scan, Retry, Please keep the document flat on the glass., Align the paper face-down on the glass scanner. "Change" is deliberately not reused: its Filipino entry means money change ("Sukli").

- [ ] **Step 8: Check the translations**

Run:

```bash
node -e "
const en = require('./src/locales/en/translation.json');
const fil = require('./src/locales/fil/translation.json');
const keys = ['Back side','Back side not scanned yet','Change type','Check your scan','Continue to Payment','Copy Preview','Copy type','Front and back look the same. Did you flip your ID?','Front captured. Turn your ID over, place it on the same corner, then tap Scan Back.','Front side','ID Card','Insert document face-up in the ADF, then tap Check Document','Insert document face-up into the ADF, short edge first','Keep anyway','Keep the lid closed and your ID on the marked corner.','Place your ID face-down on the marked corner of the glass.','Place your ID face-down on the marked corner, then tap Scan Front','Place your document face-down, then tap Check Document','Please keep the document straight in the feeder.','Retake','Retake back','Retake front','Rotate back','Rotate front','Scan Again','Scan Back','Scan Front','Scan both sides','Scanning back…','Scanning front…','Scanning…','Start over','This side looks empty. Is your ID on the marked corner, face-down?','Updating preview…','Waiting for back side','What are you copying?','Your ID scan session expired. Please scan your ID again.'];
const bad = keys.filter((k) => en[k] !== k || typeof fil[k] !== 'string' || !fil[k]);
console.log(keys.length, bad.length ? bad : 'ok');
"
```

Expected: `37 ok`. A JSON syntax error here means a comma is wrong in one of the files.

- [ ] **Step 9: Type-check, lint, test, build**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`, then `pnpm lint`, then `pnpm exec jest`, then `pnpm build`.
Expected: no errors; every spec passes.

Open `/config?mode=copy` in the dev server: it lands on `/copy`. Open `/config` from the print flow: it behaves as before.

- [ ] **Step 10: Commit**

```bash
git add src/public/confirm/printing-stage.ts src/public/confirm/printing-stage.spec.ts src/public/confirm/app.ts src/public/config/index.html src/locales/en/translation.json src/locales/fil/translation.json
git commit -m "feat(copy): copy progress wording, /config redirect and translations"
```

---

### Task 13: Hardware check on the kiosk

**Files:**

- Possibly modify: `worker/src/PrintBit.Infrastructure.Windows/Scanning/Naps2ScannerService.cs` (scan origin), `src/shared/id-card-layout.ts` (corner assumption), `src/modules/scanner/id-copy-scan-checks.ts` (thresholds)

This task needs the real scanner and printer. Run the release build on the kiosk (`pnpm build`, then the worker in Release) with stub fallback off. Keep a ruler and three different ID cards, one of them mostly white.

- [ ] **Step 1: Scan origin**

Put a card in the corner marked on the glass sticker. Scan Front. Expected: the whole card is visible in the front slot, at the top-left of its slot. If the card is cut or sits in another corner, the NAPS2 alignment from Task 1 is wrong for this driver: change `PageAlign` (or the fallback named in Task 1) until a scan of the marked corner shows the full card, then re-run `dotnet test worker/tests/PrintBit.Tests`.

- [ ] **Step 2: Real size**

Print one ID sheet on each of A4, Short and Long. Measure each printed card. Expected: 85.6 x 54 mm, within 1 mm. A consistent error on all three points to the fit margin (`PRINT_MARGIN_POINTS`) differing from the printer driver's; stop and report it, do not patch the layout by guesswork.

- [ ] **Step 3: Settings reach the printer**

Print one sheet in grayscale at standard quality and one in color at high quality with 2 copies. Expected: grayscale is gray, the copy count is right, and `/confirm` shows "Copying 1/2" then "Copying 2/2".

- [ ] **Step 4: Retake, rotate and failure**

Rotate each side through all four turns: the preview follows each tap and the print matches the last preview. Retake the front after rotating it: the front comes back upright. Unplug the scanner USB, tap Retake back: the error card shows and the front stays. Plug it back, Retry: the back is scanned.

- [ ] **Step 5: Walk away**

Scan the front and leave the kiosk. Expected: the idle timeout returns home, and `uploads/scans` has no `id-side-*` or `id-copy-*` file left.

- [ ] **Step 6: Scan warnings and thresholds**

For each of the three IDs, record what `/copy` shows for:

1. Scan Front with the glass empty: expected "This side looks empty".
2. Front, then the same front again as the back: expected "Front and back look the same".
3. A real front, then the real back: expected no warning.

If case 1 is missed, raise `ID_BLANK_STDDEV_THRESHOLD`; if the white ID's real front is flagged as empty, lower it. If case 2 is missed, raise `ID_IDENTICAL_MEAN_DIFF_THRESHOLD`; if case 3 is flagged, lower it. Change one constant at a time in `src/modules/scanner/id-copy-scan-checks.ts`, re-run `pnpm exec jest src/modules/scanner/id-copy-scan-checks.spec.ts` (update a spec expectation only if it pinned the old number), rebuild and repeat the three cases. Record the final values and the readings in the commit message.

- [ ] **Step 7: Nothing else changed**

Run one document copy end to end from `/copy` (Check Document, settings, pay, print). Run one print job through `/print` and `/config`. Expected: both behave as before; `/config` looks unchanged.

- [ ] **Step 8: Commit any hardware fix**

Only if Step 1, 2 or 6 changed a file:

```bash
git add <each changed file by path>
git commit -m "fix(copy): tune ID scan for kiosk hardware"
```

Write the measured values in the commit body.

- [ ] **Step 9: Refresh the code graph**

Run: `graphify update .`
Expected: completes. If `graphify` is not on the PATH, note it in the hand-off and skip; do not commit `graphify-out/` changes unless the repo already tracks them.
