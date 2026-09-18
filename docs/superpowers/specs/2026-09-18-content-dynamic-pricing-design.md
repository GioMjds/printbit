# Dynamic Content & Image-Aware Pricing Specification

## 1. Executive Summary

PrintBit currently calculates printing costs using a binary model (`color` vs `bw`) based entirely on the customer's selected mode, ignoring per-page ink saturation. Furthermore, high-toner photo/image prints—whether uploaded directly as images (which the backend converts to PDF for CUPS printing) or uploaded as PDFs containing dominant photos—are billed at the same flat rate as a simple document with a single colored header.

This specification defines a **4-tier dynamic pricing architecture** that introduces:
1. **Per-page content grading** within Color mode (Blank/BW, Light Color, Full Document Color, and Photo/Image).
2. **Dedicated Image/Photo pricing** (`baseImagePrice`) per paper size, configurable in the Admin Settings.
3. **Cross-conversion image tracking**, ensuring image uploads converted to PDF and native PDFs with dominant raster photos are both accurately classified and quoted.
4. **Transparent kiosk quote breakdowns**, showing itemized lines for Photo/Image, Color, and B&W pages.

---

## 2. Current Architecture vs. The Gap

### Current Billing Mechanism (`src/services/print-quote.ts` & `src/modules/admin/admin.service.ts`)
```text
price = (colorPages × baseColorPrice + bwPages × baseBwPrice + totalPages × HQSurcharge) × copies
```
- In `print-quote.ts`, `billableColorPages = colorMode === 'colored' ? selectedCount : 0`. When Color mode is selected, every page is billed at the full color rate regardless of ink usage.
- In `document-analysis.ts`, per-page color coverage (`coverage`) and classification (`blank | bw | partial | full_color`) are calculated but not wired into the billing engine.
- Converted image files (`.jpg`, `.png`, `.webp`) are converted to PDF via `resolveCanonicalPdfPath` and analyzed with `contentType: 'application/pdf'`, losing their original image identity.
- In `analyzePdfFile`, any PDF page with an image operator is forced into `hasColor = true` and `classification = 'full_color'`, even for grayscale scans.

### Constraints
1. **Deterministic Pre-Payment Quoting**: Kiosk quotes must be exact and displayed before coins/payment are accepted.
2. **Whole-Peso Rounding**: The coin hopper dispenses only 1-peso coins; all base rates and final amounts must be non-negative whole-peso integers.
3. **Transparent Explainability**: Kiosk walk-in customers require a legible rate card, not an opaque continuous formula.
4. **Mode vs. Content Separation**:
   - **B&W Mode**: The printer driver forces grayscale output (zero color ink). All pages bill at `baseBwPrice`.
   - **Color Mode**: Pages are graded per-page based on analyzed content.

---

## 3. Four-Tier Dynamic Pricing Model

Within **Color Mode**, each selected page is evaluated into one of four pricing tiers:

| Tier | Condition | Default A4 Price | Description |
| :--- | :--- | :--- | :--- |
| **1. Blank / B&W** | No visible content or coverage $< 5\%$ | `baseBwPrice` (₱3) | Driver uses only black ink / paper fee |
| **2. Light Color** | $5\% \le \text{coverage} < 35\%$ | `baseBwPrice + lightColorSurcharge` (₱3 + ₱7 = ₱10) | Headings, small logos, colored charts |
| **3. Full Color Doc** | Document coverage $\ge 35\%$, text/vector | `baseColorPrice` (₱18) | Heavy diagrams, multi-color brochures |
| **4. Photo / Image** | Converted image file OR raster image area $> 50\%$ | `baseImagePrice` (₱25) | Full photos, graphic arts, photo scans |

*Note: If the customer selects **B&W Mode**, all pages bill at `baseBwPrice` (₱3).*

---

## 4. Admin Configuration Schema

Configurable via Admin Dashboard (`/admin/settings`) and stored in `db.data.settings.pricingEngine`.

### Paper Profile Extension (`src/core/database/models/admin.model.ts`)
```typescript
export interface PricingEnginePaperProfile {
  baseBwPrice: number;       // Default: A4 ₱3, Short ₱3, Long ₱4
  baseColorPrice: number;    // Default: A4 ₱18, Short ₱18, Long ₱20
  baseImagePrice: number;    // Default: A4 ₱25, Short ₱25, Long ₱30 [NEW]
}

export interface PricingEngineSettings {
  paperProfiles: {
    a4: PricingEnginePaperProfile;
    shortBond: PricingEnginePaperProfile;
    longBond: PricingEnginePaperProfile;
  };
  lightColorSurcharge: number;        // Default: ₱7
  partialColorThreshold: number;      // Default: 0.35 (5% to 35%)
  imageCoverageThreshold: number;     // Default: 0.50 (Raster image area > 50%)
  bulkDiscountTiers: PricingEngineBulkDiscountTier[];
  rounding: PricingEngineRoundingMode;
  highQualitySurcharge: number;
}
```

### Admin Validation Rules (`src/modules/admin/admin.controller.ts`)
- `baseImagePrice` must be a non-negative finite whole-peso integer (`isWholePeso(val)`).
- Hierarchy enforcement: `baseImagePrice >= baseColorPrice >= baseBwPrice`.
- `imageCoverageThreshold` must be a float between `0.10` and `0.95`.
- `lightColorSurcharge` must be a non-negative whole-peso integer.

---

## 5. Detection Pipeline & Document Analysis

### 1. Cross-Conversion Image Preservation
When an image is uploaded in `wireless-session.service.ts`:
1. `resolveFileType(target.contentType, target.filename)` identifies `'image'`.
2. Even after converting to PDF via `resolveCanonicalPdfPath`, `analyzeDocument` is invoked with `originalFileType: 'image'`.
3. In `analyzeDocumentDirect`, when `originalFileType === 'image'`:
   - All pages in the converted PDF are assigned `isImagePage: true` and `imageCoverage: 1.0`.
   - If the image has color pixels, `classification = 'image'`.
   - If pure grayscale, `classification = 'bw'` (billed at `baseBwPrice`).

### 2. Native PDF Raster Image Geometry Calculation
In `analyzePdfFile` within `src/services/document-analysis.ts`:
- Track PDF raster image operators: `paintImageXObject`, `paintInlineImageXObject`, `paintJpegXObject`.
- Extract Current Transformation Matrix (CTM) scaling factors to calculate rendered bounding box area on the page viewport.
- Page raster coverage ratio:
  $$\text{imageCoverage} = \min\left(1.0, \frac{\sum \text{Rendered Image Area}}{\text{Page Width} \times \text{Page Height}}\right)$$
- If $\text{imageCoverage} \ge \text{imageCoverageThreshold}$ (default 0.50), mark `isImagePage = true`.

### 3. Classification Precedence
```typescript
if (isBlank) {
  classification = 'blank';
} else if (!hasColor) {
  classification = 'bw';
} else if (isImagePage) {
  classification = 'image';
} else if (coverage >= partialColorThreshold) {
  classification = 'full_color';
} else {
  classification = 'partial';
}
```

---

## 6. Calculation Engine & Quoting Service

### `calculateJobAmount` (`src/modules/admin/admin.service.ts`)
```typescript
export interface JobPageCounts {
  bwPages: number;
  lightColorPages?: number;
  fullColorPages?: number;
  imagePages?: number;
  colorPages?: number; // Legacy fallback
}

// Subtotal calculation inside calculateJobAmount:
const subtotal =
  bw * profile.baseBwPrice +
  lightColor * (profile.baseBwPrice + lightSurcharge) +
  fullColor * profile.baseColorPrice +
  image * profile.baseImagePrice +
  totalPages * hqSurcharge;

const total = Math.ceil(subtotal * safeCopies);
```

### Quoting Logic (`src/services/print-quote.ts`)
- **B&W Mode**:
  `billableBwPages = selectedCount`, all color and image billable counts set to 0.
- **Color Mode**:
  Maps each selected page from `analysis.pages`:
  - `classification === 'image'` $\rightarrow$ `billableImagePages += 1`
  - `classification === 'full_color'` $\rightarrow$ `billableFullColorPages += 1`
  - `classification === 'partial'` $\rightarrow$ `billableLightColorPages += 1`
  - `classification === 'bw' | 'blank'` $\rightarrow$ `billableBwPages += 1`
- **Fallback Guard**:
  If `analysis.confidence === 'low'` or fallback assumptions were required, bill binary color/BW to prevent speculative photo surcharges.

---

## 7. Customer Experience & Kiosk Transparency

### Rate Table (Pricing Guide)
Displayed on the kiosk guide screen:
- **B&W Document**: ₱3 / page
- **Color (Text / Logo)**: ₱10 / page
- **Color (Full Document)**: ₱18 / page
- **Photo / Image Print**: ₱25 / page

### Quote Breakdown
Before inserting coins, the customer sees an itemized quote:
```text
Photo / Image:  1 page  × ₱25 = ₱25
Color (Text):   1 page  × ₱10 = ₱10
B&W Document:   2 pages × ₱3  = ₱6
-----------------------------------
Total to Pay:                   ₱41
```

---

## 8. Phased Implementation Plan

### Phase 1: Admin-Side Image/Photo Pricing Configuration (Immediate Step)
1. **Schema & DB Migration**:
   - Update `PricingEnginePaperProfile` in `admin.model.ts` to include `baseImagePrice`.
   - Update default runtime DB values in `src/core/database/db.ts` (A4: ₱25, Short: ₱25, Long: ₱30).
2. **Admin Controller & Validation**:
   - Update `admin.controller.ts` to validate `baseImagePrice` (whole-peso checks, hierarchy `baseImagePrice >= baseColorPrice >= baseBwPrice`).
3. **Admin Settings UI**:
   - Add Photo/Image input fields under each paper profile in the settings view.
4. **Backend Calculation Extension**:
   - Extend `calculateJobAmount` signature to accept `imagePages` and compute with `baseImagePrice`.

### Phase 2: Document Analysis & Detection Pipeline
1. **Conversion Metadata Forwarding**:
   - Update `wireless-session.service.ts` to pass `originalFileType` into `analyzeDocument`.
2. **PDF Operator Scanning**:
   - Update `analyzePdfFile` in `document-analysis.ts` to compute rendered image area and flag `isImagePage` / `imageCoverage`.
3. **Classification & Algorithm Bump**:
   - Add `'image'` to `PageClassification`.
   - Bump `ANALYSIS_ALGORITHM_VERSION` to invalidate stale cache rows.

### Phase 3: Quoting & Kiosk UI Integration
1. **Print Quote Update**:
   - Update `buildPrintQuote` in `print-quote.ts` to count billable image pages.
2. **Kiosk Checkout Breakdown**:
   - Expose `billableImagePages` and line items to the kiosk frontend quote component.

---

## 9. Testing & Verification

1. **Unit Tests**:
   - `tests/document-analysis.spec.ts`: Test converted JPG/PNG, native PDF with full photo, native PDF with logo, and grayscale photos.
   - `tests/print-quote.spec.ts`: Test quoting under B&W vs Color mode across all four page tiers.
   - `tests/admin.controller.spec.ts`: Verify admin API validation of `baseImagePrice`.
2. **Integration Verification**:
   - Upload sample photo via wireless session; verify `analysis.pages[0].classification === 'image'` and quote calculates at `baseImagePrice`.
   - Upload multi-page document with 1 text page and 1 photo; verify breakdown line items and total amount.
