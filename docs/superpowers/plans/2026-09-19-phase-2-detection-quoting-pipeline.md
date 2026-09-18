# Phase 2 & 3: Detection Pipeline, Dynamic Quoting, and Kiosk Transparency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable end-to-end image-aware dynamic pricing so uploaded photos (converted to PDF) and native PDFs with dominant photos bill at `baseImagePrice` (₱25 A4 default) instead of standard document color (₱18), and reflect transparently in the kiosk UI.

**Architecture:** Extend document analysis to track source file types and raster image geometry (CTM determinant vs viewport area) to classify pages as `'image'` (`isImagePage: true`); update `print-quote.ts` to count `billableImagePages` in color mode and bill through `calculateDocumentAmount`; bump `ANALYSIS_ALGORITHM_VERSION` to invalidate stale cache entries; update kiosk config breakdown UI.

**Tech Stack:** TypeScript, Node.js, pdfjs-dist, Sharp, LowDB, Express.

**Spec:** `CONTENT_DYNAMIC_PRICING.md` and `docs/superpowers/specs/2026-09-18-content-dynamic-pricing-design.md`

## Global Constraints

- **No Jest Tests**: Per user instruction, skip running or creating Jest tests. Use `pnpm exec tsc --noEmit` for syntax/type verification.
- **Whole-Peso Pricing**: All paper profile rates (`baseImagePrice`, `baseColorPrice`, `baseBwPrice`) and calculated amounts must be non-negative whole-peso integers.
- **Hierarchy Enforcement**: `baseImagePrice >= baseColorPrice >= baseBwPrice`.
- **Mode Separation**: In B&W mode, all pages (including photo pages) bill at `baseBwPrice`. In Color mode, pages are graded per-page.

---

### Task 1: Cross-Conversion Image Preservation & Cache Version Bump

**Files:**

- Modify: `src/services/document-analysis.ts:24-77, 610-642`
- Modify: `src/modules/wireless-session/wireless-session.service.ts:1320-1385`

**Interfaces:**

- Consumes: `target.contentType`, `target.filename` in `wireless-session.service.ts`
- Produces: `AnalyzeDocumentInput.originalFileType?: AnalyzedFileType`, `ANALYSIS_ALGORITHM_VERSION = 4`, `export function resolveFileType`

- [ ] **Step 1: Export `resolveFileType` and add `originalFileType` to `AnalyzeDocumentInput` in `document-analysis.ts`**

In `src/services/document-analysis.ts`:

1. Bump `ANALYSIS_ALGORITHM_VERSION` from `3` to `4`.
2. Add `export` to `function resolveFileType(contentType: string, filename: string): AnalyzedFileType`.
3. Add `originalFileType?: AnalyzedFileType;` to `interface AnalyzeDocumentInput`.
4. Add `imageCoverage?: number;` to `interface PageAnalysis`.
5. In `analyzeDocumentDirect(input)`:
   - Determine `fileType = input.originalFileType ?? resolveFileType(contentType, filename);`
   - If `fileType === 'image'`:
     - If `input.filePath` is a PDF (converted artifact), forward to `analyzePdfFile(input.filePath, fileType, colorDetectionEnabled, { isOriginalImage: true })`.
     - Else, call `analyzeImage(input.filePath, colorDetectionEnabled)`.

- [ ] **Step 2: Update `wireless-session.service.ts` to pass `originalFileType`**

In `src/modules/wireless-session/wireless-session.service.ts` around line 1377:

1. Import `resolveFileType` from `@/services/document-analysis`.
2. Compute `originalFileType = resolveFileType(target.contentType, target.filename);`.
3. In `analyzeDocument({ filePath: analysisFilePath, contentType: 'application/pdf', filename: ..., originalFileType })`, pass `originalFileType`.

- [ ] **Step 3: Verify TypeScript compilation**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/document-analysis.ts src/modules/wireless-session/wireless-session.service.ts
git commit -m "feat(pricing): forward original file type to preserve image classification across PDF conversion"
```

---

### Task 2: Native PDF Raster Image Geometry Calculation in `document-analysis.ts`

**Files:**

- Modify: `src/services/document-analysis.ts:340-607`

**Interfaces:**

- Consumes: `page.getViewport({ scale: 1 })`, `PdfOperatorList`, `ops.transform`, `ops.save`, `ops.restore`
- Produces: `PageAnalysis.isImagePage: boolean`, `PageAnalysis.imageCoverage: number`, `PageAnalysis.classification: 'image'` when `isColor && isImagePage`

- [ ] **Step 1: Implement CTM matrix tracking and image area calculation in `analyzePageOperatorList`**

In `src/services/document-analysis.ts`:

1. In `analyzePageOperatorList`:
   - Accept optional `options?: { pageWidth?: number; pageHeight?: number; isOriginalImage?: boolean; imageCoverageThreshold?: number }`.
   - If `options?.isOriginalImage` is true:
     - Treat the page as 100% image: `imageCoverage = 1.0`, `isImagePage = true`.
     - If `hasColor`, `classification = 'image'`. If not, `classification = 'bw'`.
   - Else:
     - Track Current Transformation Matrix (CTM):
       - State stack: `const matrixStack: Matrix[] = []; let ctm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };`
       - On `ops.save`: `matrixStack.push({ ...ctm });`
       - On `ops.restore`: `ctm = matrixStack.pop() ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };`
       - On `ops.transform`: Multiply current CTM by transform matrix `[a2, b2, c2, d2, e2, f2]`.
     - When `isImageOp` (`paintImageXObject`, `paintInlineImageXObject`, `paintJpegXObject`):
       - Calculate rendered area: `Math.abs(ctm.a * ctm.d - ctm.b * ctm.c)`.
       - Accumulate to `totalImageArea`.
     - After operator loop:
       - If `pageWidth > 0 && pageHeight > 0`:
         - `imageCoverage = Math.min(1.0, totalImageArea / (pageWidth * pageHeight))`.
         - Threshold defaults to `0.50`.
         - If `imageCoverage >= 0.50`: `isImagePage = true`.
       - Update classification precedence:
         ```typescript
         if (isBlank) {
           classification = 'blank';
         } else if (!hasColor) {
           classification = 'bw';
         } else if (isImagePage) {
           classification = 'image';
         } else if (estimatedCoverage > 0.8) {
           classification = 'full_color';
         } else {
           classification = 'partial';
         }
         ```
2. In `analyzePdfFile`:
   - Call `const viewport = page.getViewport({ scale: 1 });`
   - Pass `{ pageWidth: viewport.width, pageHeight: viewport.height, isOriginalImage }` into `analyzePageOperatorList`.
   - Pass `isImagePage` and `imageCoverage` into `pages.push({ ... })`.

- [ ] **Step 2: Verify TypeScript compilation**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/document-analysis.ts
git commit -m "feat(pricing): compute PDF raster image coverage and classify photo pages"
```

---

### Task 3: Quoting Engine Dynamic Pricing Integration (`src/services/print-quote.ts`)

**Files:**

- Modify: `src/services/print-quote.ts:15-40, 200-325`

**Interfaces:**

- Consumes: `input.analysis.pages` with `classification` and `isImagePage`, `input.colorMode`
- Produces: `PrintQuoteResult.billableImagePages`, `adminService.calculateDocumentAmount` call with `imagePages`

- [ ] **Step 1: Add `billableImagePages` to `PrintQuoteResult`**

In `src/services/print-quote.ts`:
Add `billableImagePages: number;` to `export interface PrintQuoteResult`.

- [ ] **Step 2: Update `buildPrintQuote` to calculate `billableImagePages`**

In `src/services/print-quote.ts`:

1. Build `pageDetailsMap = new Map<number, DocumentPageAnalysis>()` from `input.analysis.pages`.
2. In `effectiveColorMode === 'colored'`:
   - For each selected page number:
     - Look up `page = pageDetailsMap.get(pageNum)`.
     - If `page?.classification === 'image'` or (`page?.isImagePage && page?.isColor`):
       `billableImagePages += 1`
     - Else if `page?.isColor`:
       `billableColorPages += 1`
     - Else:
       `billableBwPages += 1`
3. In `effectiveColorMode === 'bw'`:
   - `billableBwPages = selectedCount`
   - `billableColorPages = 0`
   - `billableImagePages = 0`
4. If `usedFallbackAssumptions` or `input.analysis.confidence === 'low'`:
   - Guard against speculative photo pricing:
     - `billableImagePages = 0`
     - `billableColorPages = selectedColorPages`
     - `billableBwPages = selectedBwPages`
5. Call `adminService.calculateDocumentAmount`:
   ```typescript
   const requiredAmount = adminService.calculateDocumentAmount(
     'print',
     {
       colorPages: billableColorPages,
       bwPages: billableBwPages,
       imagePages: billableImagePages,
     },
     safeCopies,
     input.paperSize ?? 'A4',
     quality,
   );
   ```
6. Include `billableImagePages` in the returned `quote` object.

- [ ] **Step 3: Verify TypeScript compilation**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/print-quote.ts
git commit -m "feat(pricing): update print quote engine to bill image pages at baseImagePrice"
```

---

### Task 4: Kiosk Config UI Display Updates (`src/public/config/app.ts`)

**Files:**

- Modify: `src/public/config/app.ts:1856-1868`

**Interfaces:**

- Consumes: `currentPrintQuote.billableImagePages`, `currentPrintQuote.billableColorPages`, `currentPrintQuote.billableBwPages`
- Produces: Transparent itemized summary line in kiosk footer breakdown

- [ ] **Step 1: Enhance `updateSummary` footer breakdown to display photo/image count**

In `src/public/config/app.ts` around line 1856:
When `currentPrintQuote` is present and `currentPrintQuote.billableImagePages > 0`:
Format page count descriptor:

```typescript
const parts: string[] = [];
if (
  currentPrintQuote.billableImagePages &&
  currentPrintQuote.billableImagePages > 0
) {
  parts.push(
    `${currentPrintQuote.billableImagePages} ${currentPrintQuote.billableImagePages === 1 ? 'photo' : 'photos'}`,
  );
}
if (currentPrintQuote.billableColorPages > 0) {
  parts.push(`${currentPrintQuote.billableColorPages} color`);
}
if (currentPrintQuote.billableBwPages > 0) {
  parts.push(`${currentPrintQuote.billableBwPages} B&W`);
}
const pageDesc =
  parts.length > 0
    ? parts.join(' · ')
    : `${currentPrintQuote.selectedPages} ${currentPrintQuote.selectedPages === 1 ? 'page' : 'pages'}`;
```

Use `pageDesc` in `footerBreakdown.textContent`.

- [ ] **Step 2: Verify TypeScript compilation**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/public/config/app.ts
git commit -m "feat(kiosk): display photo and image count in kiosk print quote summary"
```

- [ ] **Step 4: Update Knowledge Graph**

Run: `graphify update .`
