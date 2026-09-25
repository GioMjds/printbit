# PrintBit Dynamic Pricing Engine Design Specification

**Date:** 2026-09-25  
**Topic:** PrintBit Output-Metered Dynamic Pricing Engine  
**Status:** Approved Design  
**Reference:** `PRICING_CONFIGURATION_FIX.md`  

---

## 1. Problem Statement & Motivation

Previously, PrintBit determined whether a page was billed as a standard document page or an expensive "photo/image" page based on the source file format (`fileType === 'image'` or `isImagePage` derived from image uploads).

This had fundamental flaws:
1. **Format Spoofing / Exploits:** An image converted or renamed into a `.docx` or `.pdf` was billed as a standard document (e.g., ₱18 instead of ₱25/₱30), despite consuming identical color ink on paper.
2. **Reverse Penalty:** A user uploading a black-and-white text document as a `.jpg` or `.png` (such as a phone scan or receipt) was billed at the high photo rate (₱10/₱25) instead of the standard B&W document rate (₱3).
3. **No Duplex Cost Reflection:** 2-sided (duplex) printing consumes half the physical paper sheets of 1-sided printing, but quotes did not decouple physical paper sheet costs from printed page costs.
4. **No Continuous Ink Metering:** Pages with 2% ink coverage were charged the same as pages with 95% full-coverage ink.

---

## 2. Core Architecture: Output-Metered Pricing

PrintBit pricing operates as **"print output metering"**. The uploaded source format disappears from the pricing calculation.

```
Uploaded File (PDF, DOCX, XLSX, PPTX, JPG, PNG)
      ↓
Normalized / Rendered to Printable Pages
      ↓
Low-DPI Canvas / Frame Pixel Sampling (~36–50 DPI)
      ↓
Page Metrics:
  - isBlank (< 0.1% ink)
  - isColor (> 2% color ink)
  - contentCoverage (0.0 to 1.0)
  - coverageTier: 'low' | 'medium' | 'high' | 'very_high'
      ↓
Quote Engine:
  - Paper Cost = physicalSheets × paperPricePerSheet
  - Print Cost = sum(pagePrintCost[tier, colorMode])
  - Surcharges = qualitySurcharges
  - Duplex Savings = (selectedPages - physicalSheets) × paperPricePerSheet
      ↓
Tamper-Proof Quote (quoteHash, fileHash, optionsHash)
```

---

## 3. Database Schema & Data Models

### 3.1 Types in `src/core/database/models/admin.model.ts` and `src/core/database/db.ts`

```ts
export type CoverageTier = 'low' | 'medium' | 'high' | 'very_high';

export interface CoverageTierRates {
  low: number;       // 0% – 10% ink coverage
  medium: number;    // >10% – 40% ink coverage
  high: number;      // >40% – 70% ink coverage
  very_high: number; // >70% – 100% ink coverage
}

export interface PaperPricingProfile {
  paperCost: number;             // Cost per physical sheet (e.g. ₱1)
  bwPrint: CoverageTierRates;    // Print cost per printed side (B&W)
  colorPrint: CoverageTierRates; // Print cost per printed side (Color)
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

### 3.2 Calibrated Default Rates (Whole Pesos)

| Profile | Paper Cost (sheet) | B&W Low (0-10%) | B&W Med (10-40%) | B&W High (40-70%) | B&W Very High (70-100%) | Color Low (0-10%) | Color Med (10-40%) | Color High (40-70%) | Color Very High (70-100%) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A4** | ₱1 | ₱2 *(Total ₱3)* | ₱3 *(Total ₱4)* | ₱6 *(Total ₱7)* | ₱9 *(Total ₱10)* | ₱17 *(Total ₱18)* | ₱19 *(Total ₱20)* | ₱24 *(Total ₱25)* | ₱29 *(Total ₱30)* |
| **Short** | ₱1 | ₱2 *(Total ₱3)* | ₱3 *(Total ₱4)* | ₱6 *(Total ₱7)* | ₱9 *(Total ₱10)* | ₱17 *(Total ₱18)* | ₱19 *(Total ₱20)* | ₱24 *(Total ₱25)* | ₱29 *(Total ₱30)* |
| **Long** | ₱1 | ₱3 *(Total ₱4)* | ₱4 *(Total ₱5)* | ₱8 *(Total ₱9)* | ₱11 *(Total ₱12)* | ₱19 *(Total ₱20)* | ₱22 *(Total ₱23)* | ₱29 *(Total ₱30)* | ₱34 *(Total ₱35)* |

*High Quality Surcharge:* ₱2 per printed side (unchanged).

### 3.3 Seamless In-Memory Database Normalization
When loading older databases with legacy fields (`baseBwPrice`, `baseColorPrice`, `baseImagePrice`, `baseImageBwPrice`), `normalizePricingEngine` in `src/core/database/db.ts` automatically populates the new schema without data loss or downtime:
- `paperCost`: 1
- `bwPrint`: `{ low: baseBwPrice - 1, medium: baseBwPrice, high: Math.round((baseBwPrice + baseImageBwPrice) / 2) - 1, very_high: baseImageBwPrice - 1 }`
- `colorPrint`: `{ low: baseColorPrice - 1, medium: baseColorPrice + 1, high: baseImagePrice - 1, very_high: baseImagePrice + 4 }`

---

## 4. Document Analysis & Metering (`src/services/document-analysis.ts`)

### 4.1 Pixel-Level Ink Metering (`computeFrameMetrics`)
- Rendered pages or image frames are sampled down to ~50,000 pixels (scale ~36–50 DPI).
- **Ink Pixel Detection:** Alpha > 10 and $(R < 245 \lor G < 245 \lor B < 245)$.
- **Color Pixel Detection:** $\max(R,G,B) - \min(R,G,B) > \text{COLOR\_SATURATION\_THRESHOLD}$.
- **Metrics Calculated:**
  - `contentCoverage`: $\frac{\text{inkPixels}}{\text{totalSampledPixels}}$
  - `colorCoverage`: $\frac{\text{colorPixels}}{\text{totalSampledPixels}}$
  - `isBlank`: `contentCoverage < 0.001`
  - `isColor`: `!isBlank && colorCoverage > 0.02`

### 4.2 Coverage Tier Resolution
```ts
export function resolveCoverageTier(contentCoverage: number): CoverageTier {
  if (contentCoverage <= 0.10) return 'low';
  if (contentCoverage <= 0.40) return 'medium';
  if (contentCoverage <= 0.70) return 'high';
  return 'very_high';
}
```

### 4.3 Rendering Pipeline
- **PDF & Converted Office Files:** Rendered page-by-page via `pdfjs-dist` to an in-memory `node-canvas` at scale 0.5. `getImageData` passes to `computeFrameMetrics`. Operator list analysis remains as a secondary fallback.
- **Uploaded Images:** Decoded and resized via `sharp` to a 400px bounding box, passed directly to `computeFrameMetrics`.
- **Algorithm Version:** Monotonically bumped from `8` to `9` (`ANALYSIS_ALGORITHM_VERSION = 9`), forcing stale cache entries in `pricingAnalysisCacheStore` to recompute automatically.

### 4.4 Updated `PageAnalysis`
```ts
export interface PageAnalysis {
  index: number;
  isColor: boolean;
  coverage: number;             // contentCoverage (0.0 to 1.0)
  colorCoverage: number;        // colorCoverage (0.0 to 1.0)
  coverageTier: CoverageTier;   // 'low' | 'medium' | 'high' | 'very_high'
  isBlank: boolean;
  classification: 'blank' | 'bw' | 'color';
  fallbackReasonFlags?: string[];
}
```
*(Removed: `isImagePage` and `imageCoverage`.)*

---

## 5. Quote Calculation Engine (`src/services/print-quote.ts`)

### 5.1 Pricing Math
1. **Selected Pages:** Parsed from range (e.g. `all` or `1-5`). Let $N = |\text{selectedPages}|$.
2. **Physical Sheets:**
   - Simplex: $S = N \times \text{copies}$
   - Duplex: $S = \lceil\frac{N}{2}\rceil \times \text{copies}$
3. **Paper Subtotal:**
   $$\text{paperSubtotal} = S \times \text{profile.paperCost}$$
4. **Duplex Paper Savings:**
   $$\text{duplexSavings} = (N \times \text{copies} - S) \times \text{profile.paperCost}$$
5. **Print Subtotal:**
   - If user selected `colored` mode, but 0 selected pages contain color, `effectiveColorMode` auto-downgrades to `grayscale`.
   - For each selected page $p$:
     - If $p$ has color and `effectiveColorMode === 'colored'`: $\text{rate}(p) = \text{profile.colorPrint}[p\text{.coverageTier}]$
     - Otherwise: $\text{rate}(p) = \text{profile.bwPrint}[p\text{.coverageTier}]$
   - $\text{printSubtotal} = \sum_{p} \text{rate}(p) \times \text{copies}$
6. **Quality & Bulk Surcharges:**
   - $\text{qualitySubtotal} = (quality === 'high' ? \text{highQualitySurcharge} : 0) \times N \times \text{copies}$
   - $\text{requiredAmount} = \text{paperSubtotal} + \text{printSubtotal} + \text{qualitySubtotal} - \text{bulkDiscounts}$

### 5.2 Quote Output Structure
Includes itemized per-page breakdown and tamper-proof hash:
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

---

## 6. Admin Settings, Public Guide & Client UI Flow

### 6.1 Admin API & Settings Dashboard
- `PUT /api/admin/settings` validates `paperProfiles`:
  - `paperCost >= 0`
  - Tier monotonicity: $\text{low} \le \text{medium} \le \text{high} \le \text{very\_high}$
  - Color parity: $\text{bwPrint}[\text{tier}] \le \text{colorPrint}[\text{tier}]$
- Admin UI tab displays editable whole-peso inputs for Paper Sheet Cost and each coverage tier.

### 6.2 Public Pricing Guide (`/api/pricing-config` & `pricing-guide.ts`)
- Returns the updated public pricing schema with `paperProfiles` containing `paperCost`, `bwPrint`, and `colorPrint`.
- Renders an informative breakdown explaining coverage tiers (Low: text, Med: logos/charts, High: heavy graphics, Very High: full photos) and highlighting Duplex Paper Savings.

### 6.3 Customer Kiosk Flow
- **Config Screen (`src/public/config/app.ts`):** Toggling Duplex immediately reflects reduced physical sheets and displays a green savings badge (e.g., *"Saved ₱5 on paper"*).
- **Confirm Screen (`src/public/confirm/app.ts`):** Itemizes paper cost vs. print cost and submits the signed `quoteHash` to guarantee pricing integrity.

---

## 7. Verification & Testing Strategy

1. **Unit Tests for Database Normalization (`tests/services/pricing-engine-db.spec.ts`):**
   - Verify legacy profile auto-migration.
   - Verify whole-peso validation and monotonicity checks.
2. **Unit Tests for Document Analysis (`tests/services/document-analysis.spec.ts`):**
   - Verify identical coverage tier assignment for JPG vs. PDF vs. DOCX with the same visual content.
   - Verify blank page detection remains rock solid.
3. **Unit Tests for Quote Engine (`tests/services/print-quote.spec.ts`):**
   - Verify simplex vs. duplex physical sheet calculation.
   - Verify duplex paper savings calculation.
   - Verify auto-downgrade to grayscale when color mode is selected for pure B&W pages.
   - Verify quote immutability hash verification.
4. **Integration Tests for Admin API (`tests/modules/admin/admin.spec.ts`):**
   - Verify updating and persisting coverage tier rates.
