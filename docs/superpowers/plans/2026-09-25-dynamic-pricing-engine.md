# PrintBit Dynamic Pricing Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement output-metered dynamic pricing for PrintBit based on actual printable page ink coverage and physical paper consumption, eliminating file-format pricing bias, supporting duplex paper savings, and ensuring tamper-proof quotes.

**Architecture:** Render all uploaded files (PDF, Office docs, images) into canonical printable pages and sample pixel data at low DPI (~36–50 DPI) to determine exact ink coverage (`low`, `medium`, `high`, `very_high`) and color presence without relying on file extensions. Compute quotes by separating physical paper sheet cost (duplex-aware: $\lceil \text{pages}/2 \rceil$) from per-page print ink rates, providing transparent receipts and tamper-proof quote validation.

**Tech Stack:** TypeScript, Node.js, Express, `canvas`, `pdfjs-dist`, `sharp`, Jest, SQLite.

**Spec:** [`docs/superpowers/specs/2026-09-25-dynamic-pricing-engine-design.md`](file:///D:/giomj/Projects/printbit/docs/superpowers/specs/2026-09-25-dynamic-pricing-engine-design.md)

## Global Constraints

- All prices and surcharges are stored and computed as whole pesos ($\ge 0$, no decimal cents) to match kiosk cash/coin payment mechanisms.
- Zero new external dependencies — reuse already-installed `canvas`, `sharp`, and `pdfjs-dist`.
- Existing SQLite databases must automatically normalize without manual migration scripts on kiosk boot.
- All tasks must adhere to Test-Driven Development (TDD): failing test first, minimal implementation, passing test, commit.

---

### Task 1: Core Database Schema, Paper Profile Migration & Normalization

**Files:**

- Modify: `src/core/database/models/admin.model.ts:20-45`
- Modify: `src/core/database/db.ts:260-310`, `540-620`
- Test: `tests/services/pricing-engine-db.spec.ts`

**Interfaces:**

- Consumes: Existing `db.ts` settings initialization and SQLite storage.
- Produces:

  ```ts
  export type CoverageTier = 'low' | 'medium' | 'high' | 'very_high';
  export interface CoverageTierRates {
    low: number;
    medium: number;
    high: number;
    very_high: number;
  }
  export interface PaperPricingProfile {
    paperCost: number;
    bwPrint: CoverageTierRates;
    colorPrint: CoverageTierRates;
  }
  export interface PricingEngineSettings {
    paperProfiles: {
      a4: PaperPricingProfile;
      shortBond: PaperPricingProfile;
      longBond: PaperPricingProfile;
    };
    bulkDiscountTiers: PricingEngineBulkDiscountTier[];
    rounding: PricingEngineRoundingMode;
    highQualitySurcharge: number;
  }
  ```

- [ ] **Step 1: Update unit tests in `tests/services/pricing-engine-db.spec.ts` for new schema and migration**

```ts
import { db, defaultPricingEngine } from '../../src/core/database/db';

describe('Pricing Engine Database Schema & Defaults', () => {
  it('defines default paper profiles with paperCost, bwPrint, and colorPrint tiers', () => {
    expect(defaultPricingEngine.paperProfiles.a4.paperCost).toBe(1);
    expect(defaultPricingEngine.paperProfiles.a4.bwPrint.low).toBe(2);
    expect(defaultPricingEngine.paperProfiles.a4.bwPrint.very_high).toBe(9);
    expect(defaultPricingEngine.paperProfiles.a4.colorPrint.low).toBe(17);
    expect(defaultPricingEngine.paperProfiles.a4.colorPrint.high).toBe(24);
  });

  it('normalizes legacy paper profiles into new tiered format without data loss', () => {
    const rawLegacy = {
      paperProfiles: {
        a4: {
          baseBwPrice: 3,
          baseColorPrice: 18,
          baseImagePrice: 25,
          baseImageBwPrice: 10,
        },
        shortBond: {
          baseBwPrice: 3,
          baseColorPrice: 18,
          baseImagePrice: 25,
          baseImageBwPrice: 10,
        },
        longBond: {
          baseBwPrice: 4,
          baseColorPrice: 20,
          baseImagePrice: 30,
          baseImageBwPrice: 12,
        },
      },
    };
    const normalized =
      (db as any).normalizePricingEngine?.(rawLegacy) ?? rawLegacy;
    expect(normalized.paperProfiles.a4.paperCost).toBe(1);
    expect(normalized.paperProfiles.a4.bwPrint.low).toBe(2);
    expect(normalized.paperProfiles.a4.bwPrint.very_high).toBe(9);
    expect(normalized.paperProfiles.a4.colorPrint.low).toBe(17);
    expect(normalized.paperProfiles.a4.colorPrint.high).toBe(24);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/services/pricing-engine-db.spec.ts`  
Expected: FAIL with property mismatches.

- [ ] **Step 3: Update `admin.model.ts` and `db.ts` implementation**

In `src/core/database/models/admin.model.ts`:
Define `CoverageTier`, `CoverageTierRates`, and updated `PaperPricingProfile`.

In `src/core/database/db.ts`:
Update `defaultPricingEngine` with calibrated defaults:

- A4/Short: `paperCost: 1`, `bwPrint: { low: 2, medium: 3, high: 6, very_high: 9 }`, `colorPrint: { low: 17, medium: 19, high: 24, very_high: 29 }`.
- Long: `paperCost: 1`, `bwPrint: { low: 3, medium: 4, high: 8, very_high: 11 }`, `colorPrint: { low: 19, medium: 22, high: 29, very_high: 34 }`.

Update `normalizePricingEngine` to detect and migrate legacy `baseBwPrice`, `baseColorPrice`, `baseImagePrice`, `baseImageBwPrice`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/services/pricing-engine-db.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/database/models/admin.model.ts src/core/database/db.ts tests/services/pricing-engine-db.spec.ts
git commit -m "feat(pricing): update database schema for tiered coverage and paper profiles"
```

---

### Task 2: Uniform Canvas Pixel Coverage Metering in Document Analysis

**Files:**

- Modify: `src/services/document-analysis.ts`
- Modify: `src/services/session.ts:30-55`
- Test: `tests/services/document-analysis.spec.ts`
- Test: `tests/services/direct-image-analysis.spec.ts`

**Interfaces:**

- Consumes: `pdfjs-dist/legacy/build/pdf.mjs`, `canvas`, `sharp`.
- Produces:

  ```ts
  export function resolveCoverageTier(contentCoverage: number): CoverageTier;
  export interface PageAnalysis {
    index: number;
    isColor: boolean;
    coverage: number; // contentCoverage (0.0 to 1.0)
    colorCoverage: number; // colorCoverage (0.0 to 1.0)
    coverageTier: CoverageTier; // 'low' | 'medium' | 'high' | 'very_high'
    isBlank: boolean;
    classification: 'blank' | 'bw' | 'color';
    fallbackReasonFlags?: string[];
  }
  ```

- [ ] **Step 1: Write failing tests for uniform coverage tier assignment**

In `tests/services/document-analysis.spec.ts`:
Add test verifying that a full-page photo (whether analyzed as PDF page or image) is classified as `coverageTier: 'very_high'` and `isColor: true`, while a standard text document page is classified as `coverageTier: 'low'`. Verify `resolveCoverageTier` boundaries.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/services/document-analysis.spec.ts`  
Expected: FAIL with missing `coverageTier` and `resolveCoverageTier`.

- [ ] **Step 3: Implement canvas rendering and uniform metering**

In `src/services/document-analysis.ts`:

- Bump `ANALYSIS_ALGORITHM_VERSION = 9`.
- Export `resolveCoverageTier(contentCoverage: number): CoverageTier`:
  - `contentCoverage <= 0.10` $\rightarrow$ `'low'`
  - `contentCoverage <= 0.40` $\rightarrow$ `'medium'`
  - `contentCoverage <= 0.70` $\rightarrow$ `'high'`
  - `> 0.70` $\rightarrow$ `'very_high'`
- In `analyzePdfFile`:
  - For each page, render to an in-memory `node-canvas` via `createCanvas(viewport.width, viewport.height)` with viewport scale 0.5.
  - Call `computeFrameMetrics({ data: ctx.getImageData(...).data, width, height })`.
  - Assign `coverageTier: resolveCoverageTier(metrics.contentCoverage)`.
  - Fall back to operator scan if canvas rendering fails.
- In `analyzeImage`:
  - Process image with `sharp`, run `computeFrameMetrics`, assign `coverageTier: resolveCoverageTier(metrics.contentCoverage)`.
  - Remove `isImagePage` flag and format-based biasing.
- In `src/services/session.ts`:
  - Update `PageAnalysis` interface to match.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/services/document-analysis.spec.ts tests/services/direct-image-analysis.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/document-analysis.ts src/services/session.ts tests/services/document-analysis.spec.ts tests/services/direct-image-analysis.spec.ts
git commit -m "feat(analysis): implement uniform low-dpi canvas coverage metering for pages"
```

---

### Task 3: Dynamic Output-Metered Quote Engine & Duplex Math

**Files:**

- Modify: `src/services/print-quote.ts`
- Modify: `src/services/admin.ts:60-140`
- Modify: `src/modules/admin/admin.service.ts:170-240`
- Test: `tests/services/print-quote.spec.ts`
- Test: `tests/services/print-quote-image-pricing.spec.ts`
- Test: `tests/services/admin-pricing-calculation.spec.ts`

**Interfaces:**

- Consumes: `PaperPricingProfile` from Task 1, `PageAnalysis` from Task 2.
- Produces:

  ```ts
  export interface PrintPageQuoteBreakdown {
    pageNumber: number;
    isColor: boolean;
    coverage: number;
    coverageTier: CoverageTier;
    printCost: number;
  }
  export interface PrintQuoteResult {
    requiredAmount: number;
    copies: number;
    duplex: boolean;
    paperSize: 'A4' | 'Short' | 'Long';
    selectedPages: number;
    totalPages: number;
    physicalSheets: number;
    paperCostPerSheet: number;
    paperSubtotal: number;
    printSubtotal: number;
    qualitySubtotal: number;
    duplexSavings: number;
    requestedColorMode: ColorMode;
    effectiveColorMode: ColorMode;
    quality: PrintQuality;
    pageBreakdown: PrintPageQuoteBreakdown[];
    quoteId: string;
    quoteHash: string;
    expiresAt: string;
  }
  ```

- [ ] **Step 1: Write failing tests for duplex savings and dynamic tier quotes**

In `tests/services/print-quote.spec.ts`:

- Test 10-page B&W Low document in Simplex: 10 physical sheets @ ₱1 + 10 pages @ ₱2 = ₱30.
- Test 10-page B&W Low document in Duplex: 5 physical sheets @ ₱1 + 10 pages @ ₱2 = ₱25 (saving ₱5).
- Test image file containing B&W text: bills at `low` B&W tier (₱3 simplex), not photo tier (₱10).
- Test PDF containing full-page photo: bills at `very_high` color tier (₱30 simplex), not standard document tier (₱18).
- Test `quoteHash` tamper verification.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/services/print-quote.spec.ts`  
Expected: FAIL with outdated quote logic.

- [ ] **Step 3: Implement new quote engine calculation**

In `src/services/print-quote.ts`:

- Read `profile = pricingEngine.paperProfiles[profileKey]`.
- Calculate `physicalSheets = (duplex ? Math.ceil(selectedCount / 2) : selectedCount) * safeCopies`.
- Calculate `paperSubtotal = physicalSheets * profile.paperCost`.
- Calculate `duplexSavings = ((selectedCount * safeCopies) - physicalSheets) * profile.paperCost`.
- For each selected page, lookup rate:
  - If `effectiveColorMode === 'colored' && page.isColor`: `profile.colorPrint[page.coverageTier]`
  - Else: `profile.bwPrint[page.coverageTier]`
- Sum print cost and multiply by copies.
- Compute `quoteHash = sha256(...)` sealing inputs and amount.
- Update `calculateJobAmount` / `calculateDocumentAmount` in `src/services/admin.ts` and `src/modules/admin/admin.service.ts` to use new profile structure.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/services/print-quote.spec.ts tests/services/print-quote-image-pricing.spec.ts tests/services/admin-pricing-calculation.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/print-quote.ts src/services/admin.ts src/modules/admin/admin.service.ts tests/services/print-quote.spec.ts tests/services/print-quote-image-pricing.spec.ts tests/services/admin-pricing-calculation.spec.ts
git commit -m "feat(pricing): implement duplex-aware dynamic quote engine and tamper-proof quotes"
```

---

### Task 4: Admin API Validation & Settings Dashboard Updates

**Files:**

- Modify: `src/modules/admin/admin.schema.ts:25-45`
- Modify: `src/modules/admin/admin.controller.ts:2230-2390`
- Modify: `src/public/admin/shared.ts:220-235`
- Modify: `src/public/admin/settings/app.ts:430-500`, `930-960`
- Test: `tests/modules/admin/admin.spec.ts` (or admin settings test)

**Interfaces:**

- Consumes: `PaperPricingProfile` from Task 1.
- Produces: Updated `PUT /api/admin/settings` handler validating `paperCost`, `bwPrint`, and `colorPrint` tables.

- [ ] **Step 1: Write failing test for admin settings schema validation**

Test that updating pricing engine rejects negative values, non-monotonic tier rates (e.g. `bwPrint.high < bwPrint.medium`), or decimal cents.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/modules/admin/admin.spec.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement admin validation and dashboard UI**

In `src/modules/admin/admin.schema.ts` and `admin.controller.ts`:

- Validate `paperCost`, `bwPrint`, and `colorPrint` for `a4`, `shortBond`, `longBond`.
- Enforce whole-peso values and monotonicity checks.
  In `src/public/admin/settings/app.ts`:
- Update Pricing Engine settings form with table inputs for Paper Sheet Cost, B&W Tiers, and Color Tiers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/modules/admin/admin.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/admin.schema.ts src/modules/admin/admin.controller.ts src/public/admin/shared.ts src/public/admin/settings/app.ts
git commit -m "feat(admin): update admin pricing settings validation and dashboard UI"
```

---

### Task 5: Public Pricing Guide & Client UI Flow

**Files:**

- Modify: `src/public/shared/pricing-guide.ts`
- Modify: `src/public/config/app.ts:110-160`, `450-520`
- Modify: `src/public/confirm/app.ts:100-160`
- Test: `tests/public/pricing-guide.spec.ts`

**Interfaces:**

- Consumes: `/api/pricing-config` returning `PublicPricingConfig` with paper profiles and tiers.
- Produces: Customer UI with live duplex paper savings badge and transparent itemized receipt.

- [ ] **Step 1: Update unit test for pricing guide table formatting**

In `tests/public/pricing-guide.spec.ts`:
Update test to verify `formatPricingGuide` renders paper cost, B&W tiers, Color tiers, and duplex savings note.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/public/pricing-guide.spec.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement public pricing guide and client preview/confirm UI**

In `src/public/shared/pricing-guide.ts`:

- Update `formatPricingGuide` to display paper cost and tier rates.
  In `src/public/config/app.ts`:
- Display duplex savings badge when 2-sided printing is enabled.
  In `src/public/confirm/app.ts`:
- Itemize paper cost vs. print cost in confirmation breakdown.
- Transmit `quoteHash` to `/print` endpoint.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/public/pricing-guide.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/public/shared/pricing-guide.ts src/public/config/app.ts src/public/confirm/app.ts tests/public/pricing-guide.spec.ts
git commit -m "feat(ui): update public pricing guide and customer quote confirmation breakdown"
```

---

### Task 6: End-to-End Test Suite & Verification

**Files:**

- Create: `tests/e2e/dynamic-pricing-flow.spec.ts`
- Modify: `tests/services/financial.spec.ts` (if applicable)

**Interfaces:**

- Consumes: Full stack (Analysis $\rightarrow$ Quote $\rightarrow$ Confirm).
- Produces: Automated verification suite covering all requirements in `PRICING_CONFIGURATION_FIX.md`.

- [ ] **Step 1: Create E2E test suite `tests/e2e/dynamic-pricing-flow.spec.ts`**

Cover:

1. JPG photo vs. DOCX containing full-page photo $\rightarrow$ both get priced identically at `very_high` color tier.
2. JPG scan of black-and-white text $\rightarrow$ priced at `low` B&W tier (₱3 simplex).
3. 10-page duplex print $\rightarrow$ verifies 5 physical sheets charged and ₱5 duplex savings.
4. Tamper verification $\rightarrow$ altering options without recalculating quote fails.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`  
Expected: All tests PASS.

- [ ] **Step 3: Run linter and typecheck**

Run: `pnpm run lint && npx tsc --noEmit`  
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dynamic-pricing-flow.spec.ts
git commit -m "test(pricing): add comprehensive end-to-end dynamic pricing tests"
```
