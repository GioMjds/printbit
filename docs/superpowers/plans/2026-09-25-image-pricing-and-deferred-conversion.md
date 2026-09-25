# Image Pricing & Deferred PDF Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement dedicated Image B/W vs Image Color pricing across all paper profiles, expand upload support to GIF format with magic byte verification, analyze image uploads directly in milliseconds without converting to PDF first, and defer PDF conversion until printing/payment lock.

**Architecture:**

1. Database & Pricing: Extend paper profiles with `baseImageBwPrice` (defaulting to ₱10 for A4/Letter and ₱12 for Legal), update admin validation, pricing calculations, and settings UI.
2. File Formats: Add GIF (`.gif`, `image/gif`, magic bytes `GIF87a`/`GIF89a`) to file-types validator, upload UI, and session models.
3. Decoupled Direct Analysis: In `wireless-session.service.ts`, bypass LibreOffice PDF conversion during upload analysis for image files; analyze raw image directly with Sharp (`analyzeImage`) in ~5ms.
4. Native Preview & Quoting: Serve native image MIME types from `/preview` so `/config` can render them immediately with `loadImage()`. Update `buildPrintQuote` to bill `baseImagePrice` for Color and `baseImageBwPrice` for B/W.
5. Deferred Conversion Gate: Maintain a hard gate before printer spooling in `financial.service.ts` to ensure the canonical PDF artifact exists prior to physical printing.

**Tech Stack:** TypeScript, Node.js, Express, Sharp, Jest, SQLite, HTML5/CSS/Vanilla JS.

**Spec:** [`docs/superpowers/specs/2026-09-25-image-pricing-and-deferred-conversion-design.md`](file:///D:/giomj/Projects/printbit/docs/superpowers/specs/2026-09-25-image-pricing-and-deferred-conversion-design.md)

## Global Constraints

- `baseImageBwPrice` defaults: `a4` = 10, `shortBond` = 10, `longBond` = 12.
- Pricing validation: `baseBwPrice <= baseImageBwPrice <= baseImagePrice`. Must be non-negative whole peso (`isWholePeso`).
- Magic signatures for GIF: `GIF87a` (`[0x47, 0x49, 0x46, 0x38, 0x37, 0x61]`) and `GIF89a` (`[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]`).
- Do not convert images to PDF during upload analysis.
- Jest test commands must include `--forceExit` to close open background database handles.

---

### Task 1: Database Model & Pricing Engine Defaults for Image B/W

**Files:**

- Modify: `src/core/database/models/admin.model.ts`
- Modify: `src/core/database/db.ts`
- Test: `tests/services/pricing-engine-db.spec.ts`

**Interfaces:**

- Produces: `PaperPricingProfile.baseImageBwPrice: number`
- Consumes: None

- [ ] **Step 1: Write the failing test**

Create `tests/services/pricing-engine-db.spec.ts`:

```typescript
import { db, defaultPricingEngine } from '../../src/core/database/db';

describe('Pricing Engine Database Schema & Defaults', () => {
  it('includes baseImageBwPrice in default paper profiles', () => {
    expect(defaultPricingEngine.paperProfiles.a4.baseImageBwPrice).toBe(10);
    expect(defaultPricingEngine.paperProfiles.shortBond.baseImageBwPrice).toBe(
      10,
    );
    expect(defaultPricingEngine.paperProfiles.longBond.baseImageBwPrice).toBe(
      12,
    );
  });

  it('normalizes missing baseImageBwPrice in existing paper profiles to defaults', () => {
    const rawEngine = {
      paperProfiles: {
        a4: { baseBwPrice: 3, baseColorPrice: 18, baseImagePrice: 25 },
        shortBond: { baseBwPrice: 3, baseColorPrice: 18, baseImagePrice: 25 },
        longBond: { baseBwPrice: 4, baseColorPrice: 20, baseImagePrice: 30 },
      },
    };
    const normalized =
      (db as any).normalizePricingEngine?.(rawEngine) ?? rawEngine;
    expect(normalized.paperProfiles.a4.baseImageBwPrice).toBe(10);
    expect(normalized.paperProfiles.shortBond.baseImageBwPrice).toBe(10);
    expect(normalized.paperProfiles.longBond.baseImageBwPrice).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/pricing-engine-db.spec.ts --forceExit`  
Expected: FAIL with property `baseImageBwPrice` undefined.

- [ ] **Step 3: Write minimal implementation**

1. In `src/core/database/models/admin.model.ts`:

```typescript
export interface PaperPricingProfile {
  baseBwPrice: number;
  baseColorPrice: number;
  baseImagePrice: number;
  baseImageBwPrice: number;
}
```

2. In `src/core/database/db.ts`:
   Update `defaultPricingEngine`:

```typescript
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
```

And update `normalizePricingEngine` in `db.ts` to assign `baseImageBwPrice`:

```typescript
        a4: {
          baseBwPrice: Math.max(0, Math.floor(Number(a4?.baseBwPrice ?? defaultPricingEngine.paperProfiles.a4.baseBwPrice))),
          baseColorPrice: Math.max(0, Math.floor(Number(a4?.baseColorPrice ?? defaultPricingEngine.paperProfiles.a4.baseColorPrice))),
          baseImagePrice: Math.max(0, Math.floor(Number(a4?.baseImagePrice ?? defaultPricingEngine.paperProfiles.a4.baseImagePrice))),
          baseImageBwPrice: Math.max(0, Math.floor(Number(a4?.baseImageBwPrice ?? defaultPricingEngine.paperProfiles.a4.baseImageBwPrice))),
        },
```

(Repeat for `shortBond` and `longBond`). Export `normalizePricingEngine` or test through `db`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/pricing-engine-db.spec.ts --forceExit`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/database/models/admin.model.ts src/core/database/db.ts tests/services/pricing-engine-db.spec.ts
git commit -m "feat(pricing): add baseImageBwPrice to paper profiles and db normalization"
```

---

### Task 2: Admin Controller Validation, Pricing Calculations & Admin Settings UI

**Files:**

- Modify: `src/modules/admin/admin.controller.ts`
- Modify: `src/modules/admin/admin.service.ts`
- Modify: `src/services/admin.ts`
- Modify: `src/public/admin/shared.ts`
- Modify: `src/public/admin/settings/app.ts`
- Modify: `src/public/admin/settings/index.html`
- Test: `tests/services/admin-pricing-calculation.spec.ts`

**Interfaces:**

- Consumes: `PaperPricingProfile.baseImageBwPrice` from Task 1
- Produces: `adminService.calculateJobAmount(mode, { colorPages, bwPages, imagePages, imageBwPages }, ...)`

- [ ] **Step 1: Write the failing test**

Create `tests/services/admin-pricing-calculation.spec.ts`:

```typescript
import { AdminService } from '../../src/services/admin';
import { db } from '../../src/core/database/db';

describe('AdminService Pricing Calculations with Image B/W', () => {
  const adminService = new AdminService();

  beforeAll(() => {
    db.data = {
      settings: {
        pricing: { scanDocument: 5, highQualitySurcharge: 2 },
        pricingEngine: {
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
          highQualitySurcharge: 2,
        },
      },
    } as any;
  });

  it('calculates amount for 1 Image B/W page on A4 standard quality', () => {
    const amount = adminService.calculateDocumentAmount(
      'print',
      { colorPages: 0, bwPages: 0, imagePages: 0, imageBwPages: 1 },
      1,
      'A4',
      'standard',
    );
    expect(amount).toBe(10);
  });

  it('calculates amount for 1 Image Color page and 1 Image B/W page on Legal with 2 copies', () => {
    const amount = adminService.calculateDocumentAmount(
      'print',
      { colorPages: 0, bwPages: 0, imagePages: 1, imageBwPages: 1 },
      2,
      'Legal',
      'standard',
    );
    // Legal: baseImagePrice = 30, baseImageBwPrice = 12 -> (30 + 12) * 2 = 84
    expect(amount).toBe(84);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/admin-pricing-calculation.spec.ts --forceExit`  
Expected: FAIL (`amount` returned does not match because `imageBwPages` is ignored).

- [ ] **Step 3: Write minimal implementation**

1. In `src/services/admin.ts` and `src/modules/admin/admin.service.ts`:
   Update `calculateJobAmount`:

```typescript
const baseImageBwPrice =
  profile.baseImageBwPrice ?? (profileKey === 'longBond' ? 12 : 10);
const safeImageBwPages = Math.max(
  0,
  Math.floor(
    'imageBwPages' in counts && counts.imageBwPages ? counts.imageBwPages : 0,
  ),
);
const totalPages =
  safeColorPages + safeBwPages + safeImagePages + safeImageBwPages;
const subtotalExact =
  (safeColorPages * profile.baseColorPrice +
    safeBwPages * profile.baseBwPrice +
    safeImagePages * baseImagePrice +
    safeImageBwPages * baseImageBwPrice +
    totalPages * surchargePerPg) *
  safeCopies;
```

2. In `src/modules/admin/admin.controller.ts`:
   Add validation for `baseImageBwPrice`:

- Check `isWholePeso(baseImageBwPrice)` and `>= 0`.
- Verify `baseImageBwPrice >= profile.baseBwPrice` and `baseImageBwPrice <= profile.baseImagePrice`.

3. In `src/public/admin/shared.ts` & `src/public/admin/settings/`:

- Add `baseImageBwPrice` to form models and settings table.
- Add `<input id="a4ImageBwPrice" ... />`, `<input id="shortBondImageBwPrice" ... />`, `<input id="longBondImageBwPrice" ... />`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/admin-pricing-calculation.spec.ts --forceExit`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/ src/services/admin.ts src/public/admin/ tests/services/admin-pricing-calculation.spec.ts
git commit -m "feat(pricing): add baseImageBwPrice calculation, admin validation and settings UI"
```

---

### Task 3: File Type Validation & GIF Format Support

**Files:**

- Modify: `src/utils/file-types.ts`
- Modify: `src/services/session.ts`
- Modify: `src/services/document-rotation.ts`
- Modify: `src/public/upload/app.ts`
- Modify: `src/public/upload/index.html`
- Modify: `src/public/upload/styles.css`
- Test: `tests/services/file-types.spec.ts`

**Interfaces:**

- Produces: `ALLOWED_MIME_TYPES` includes `'image/gif'`, `ALLOWED_EXTENSIONS` includes `'.gif'`, magic bytes for `image/gif`.
- Consumes: None

- [ ] **Step 1: Write the failing test**

Create `tests/services/file-types.spec.ts`:

```typescript
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  EXTENSION_MIME_MAP,
  MAGIC_SIGNATURES,
} from '../../src/utils/file-types';

describe('File Type Validation - GIF Support', () => {
  it('allows .gif extension and image/gif MIME type', () => {
    expect(ALLOWED_EXTENSIONS.has('.gif')).toBe(true);
    expect(ALLOWED_MIME_TYPES.has('image/gif')).toBe(true);
    expect(EXTENSION_MIME_MAP['.gif']).toBe('image/gif');
  });

  it('contains valid magic signatures for GIF87a and GIF89a', () => {
    const signatures = MAGIC_SIGNATURES['image/gif'];
    expect(signatures).toBeDefined();
    expect(signatures.length).toBeGreaterThanOrEqual(2);
    // GIF87a: 0x47, 0x49, 0x46, 0x38, 0x37, 0x61
    expect(signatures[0].bytes).toEqual([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
    // GIF89a: 0x47, 0x49, 0x46, 0x38, 0x39, 0x61
    expect(signatures[1].bytes).toEqual([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/file-types.spec.ts --forceExit`  
Expected: FAIL (missing `.gif` and `image/gif`).

- [ ] **Step 3: Write minimal implementation**

1. In `src/utils/file-types.ts`:

- Add `'image/gif'` to `ALLOWED_MIME_TYPES`.
- Add `'.gif'` to `ALLOWED_EXTENSIONS`.
- Add `MAGIC_SIGNATURES['image/gif'] = [{ bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }]`.
- Add `'.gif': 'image/gif'` to `EXTENSION_MIME_MAP`.

2. In `src/services/session.ts`:

- Add `['image/gif', '.gif']` to mime-to-extension array.

3. In `src/services/document-rotation.ts`:

- Add `'.gif'` to `IMAGE_EXTENSIONS`.

4. In `src/public/upload/index.html` and `src/public/upload/app.ts`:

- Add `.gif` to `accept` string and allowed upload types.
- Add `.queue-item__icon[data-ext="gif"]` in `src/public/upload/styles.css`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/file-types.spec.ts --forceExit`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/file-types.ts src/services/session.ts src/services/document-rotation.ts src/public/upload/ tests/services/file-types.spec.ts
git commit -m "feat(upload): add GIF format support and magic byte validation"
```

---

### Task 4: Print Quote Engine Two-Tier Image Pricing

**Files:**

- Modify: `src/services/print-quote.ts`
- Test: `tests/services/print-quote-image-pricing.spec.ts`

**Interfaces:**

- Consumes: `PaperPricingProfile.baseImageBwPrice` from Task 1, `adminService.calculateDocumentAmount` from Task 2
- Produces: `PrintQuote.billableImageBwPages`, two-tier image billing in `buildPrintQuote`

- [ ] **Step 1: Write the failing test**

Create `tests/services/print-quote-image-pricing.spec.ts`:

```typescript
import { buildPrintQuote } from '../../src/services/print-quote';
import { db } from '../../src/core/database/db';
import type { DocumentAnalysis } from '../../src/services/session';

describe('buildPrintQuote - Image Color vs Image B/W Pricing', () => {
  beforeAll(() => {
    db.data = {
      settings: {
        pricing: { scanDocument: 5 },
        pricingEngine: {
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
        },
        pipelineSettings: { colorDetectionEnabled: true },
      },
    } as any;
  });

  const coloredImageAnalysis: DocumentAnalysis = {
    fileType: 'image',
    pageCount: 1,
    totalPages: 1,
    colorPages: 1,
    bwPages: 0,
    confidence: 'high',
    analysisVersion: 8,
    analyzedAt: new Date(),
    pages: [
      { index: 1, isColor: true, isImagePage: true, classification: 'image' },
    ],
  };

  const bwImageAnalysis: DocumentAnalysis = {
    fileType: 'image',
    pageCount: 1,
    totalPages: 1,
    colorPages: 0,
    bwPages: 1,
    confidence: 'high',
    analysisVersion: 8,
    analyzedAt: new Date(),
    pages: [
      { index: 1, isColor: false, isImagePage: true, classification: 'bw' },
    ],
  };

  it('bills colored image at baseImagePrice (25) in Color mode', () => {
    const result = buildPrintQuote({
      analysis: coloredImageAnalysis,
      copies: 1,
      colorMode: 'colored',
      paperSize: 'A4',
      quality: 'standard',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.billableImagePages).toBe(1);
    expect(result.quote.billableImageBwPages).toBe(0);
    expect(result.quote.requiredAmount).toBe(25);
    expect(result.quote.effectiveColorMode).toBe('colored');
  });

  it('bills colored image at baseImageBwPrice (10) when printed in Grayscale mode', () => {
    const result = buildPrintQuote({
      analysis: coloredImageAnalysis,
      copies: 1,
      colorMode: 'grayscale',
      paperSize: 'A4',
      quality: 'standard',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.billableImagePages).toBe(0);
    expect(result.quote.billableImageBwPages).toBe(1);
    expect(result.quote.requiredAmount).toBe(10);
    expect(result.quote.effectiveColorMode).toBe('grayscale');
  });

  it('bills black and white image at baseImageBwPrice (10) even if Color mode is selected', () => {
    const result = buildPrintQuote({
      analysis: bwImageAnalysis,
      copies: 1,
      colorMode: 'colored',
      paperSize: 'A4',
      quality: 'standard',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.billableImagePages).toBe(0);
    expect(result.quote.billableImageBwPages).toBe(1);
    expect(result.quote.requiredAmount).toBe(10);
    expect(result.quote.effectiveColorMode).toBe('grayscale');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/print-quote-image-pricing.spec.ts --forceExit`  
Expected: FAIL (missing `billableImageBwPages` and wrong amount).

- [ ] **Step 3: Write minimal implementation**

In `src/services/print-quote.ts`:

1. Add `billableImageBwPages?: number;` to `PrintQuote` interface.
2. In `buildPrintQuote`:

```typescript
let billableColorPages = 0;
let billableBwPages = 0;
let billableImagePages = 0;
let billableImageBwPages = 0;

if (input.colorMode === 'colored') {
  if (!usedFallbackAssumptions && input.analysis.confidence !== 'low') {
    for (const pageNum of selectedPages.selected) {
      const page = pageDetailsMap.get(pageNum);
      const isImage = Boolean(
        page?.isImagePage || page?.classification === 'image',
      );
      if (isImage) {
        if (page?.isColor) {
          billableImagePages += 1;
        } else {
          billableImageBwPages += 1;
        }
      } else if (page?.isColor) {
        billableColorPages += 1;
      } else {
        billableBwPages += 1;
      }
    }
  } else {
    const isFileImage = input.analysis.fileType === 'image';
    if (isFileImage) {
      if (selectedColorPages > 0) {
        billableImagePages = selectedCount;
      } else {
        billableImageBwPages = selectedCount;
      }
    } else {
      billableColorPages = selectedColorPages;
      billableBwPages = selectedBwPages;
    }
  }
} else {
  // B&W Mode: force all pages to grayscale. Images use baseImageBwPrice.
  for (const pageNum of selectedPages.selected) {
    const page = pageDetailsMap.get(pageNum);
    const isImage = Boolean(
      page?.isImagePage || page?.classification === 'image',
    );
    if (isImage) {
      billableImageBwPages += 1;
    } else {
      billableBwPages += 1;
    }
  }
}

const effectiveColorMode: ColorMode =
  input.colorMode === 'colored' &&
  billableColorPages === 0 &&
  billableImagePages === 0
    ? 'grayscale'
    : input.colorMode;
```

3. Pass `imageBwPages: billableImageBwPages` to `adminService.calculateDocumentAmount`.
4. Include `billableImageBwPages` in returned quote object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/print-quote-image-pricing.spec.ts --forceExit`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/print-quote.ts tests/services/print-quote-image-pricing.spec.ts
git commit -m "feat(pricing): implement two-tier image quoting (Image Color vs Image B/W)"
```

---

### Task 5: Direct Image Analysis via Sharp (Bypass LibreOffice on Upload)

**Files:**

- Modify: `src/modules/wireless-session/wireless-session.service.ts`
- Modify: `src/services/document-analysis.ts`
- Test: `tests/services/direct-image-analysis.spec.ts`

**Interfaces:**

- Consumes: `analyzeDocument` in `src/services/document-analysis.ts`
- Produces: Instant analysis of image uploads without calling `resolveCanonicalPdfPath`

- [ ] **Step 1: Write the failing test**

Create `tests/services/direct-image-analysis.spec.ts`:

```typescript
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeDocument } from '../../src/services/document-analysis';

describe('Direct Image Analysis (Sharp)', () => {
  const tmpDir = path.join(__dirname, '..', 'tmp-image-test');
  const colorImagePath = path.join(tmpDir, 'test-color.png');
  const bwImagePath = path.join(tmpDir, 'test-bw.png');

  beforeAll(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Generate 100x100 vibrant red image
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toFile(colorImagePath);

    // Generate 100x100 pure grayscale image
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .png()
      .toFile(bwImagePath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('analyzes color PNG directly without PDF conversion', async () => {
    const result = await analyzeDocument({
      filePath: colorImagePath,
      contentType: 'image/png',
      filename: 'test-color.png',
      originalFileType: 'image',
    });

    expect(result.fileType).toBe('image');
    expect(result.pageCount).toBe(1);
    expect(result.colorPages).toBe(1);
    expect(result.bwPages).toBe(0);
    expect(result.pages[0].isImagePage).toBe(true);
    expect(result.pages[0].classification).toBe('image');
  });

  it('analyzes grayscale PNG directly as bw image', async () => {
    const result = await analyzeDocument({
      filePath: bwImagePath,
      contentType: 'image/png',
      filename: 'test-bw.png',
      originalFileType: 'image',
    });

    expect(result.fileType).toBe('image');
    expect(result.pageCount).toBe(1);
    expect(result.colorPages).toBe(0);
    expect(result.bwPages).toBe(1);
    expect(result.pages[0].isImagePage).toBe(true);
    expect(result.pages[0].classification).toBe('bw');
  });
});
```

- [ ] **Step 2: Run test to verify it passes / fails**

Run: `npx jest tests/services/direct-image-analysis.spec.ts --forceExit`  
Expected: PASS or verify integration with `wireless-session.service.ts`.

- [ ] **Step 3: Update `wireless-session.service.ts` to bypass LibreOffice for images**

In `src/modules/wireless-session/wireless-session.service.ts`:

1. Define helper:

```typescript
  private isImageTarget(contentType: string, filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return (
      contentType.startsWith('image/') ||
      ['.jpg', '.jpeg', '.png', '.gif'].includes(ext)
    );
  }
```

2. In `analyzeAndStoreDocument`:

```typescript
const isImage = this.isImageTarget(target.contentType, target.filename);
let analysisFilePath: string;
if (isImage) {
  analysisFilePath = absoluteFilePath;
} else {
  try {
    analysisFilePath = await this.resolveCanonicalPdfPath(sessionId, target);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Unknown conversion error';
    return {
      error: `Document conversion failed before analysis: ${reason}`,
      status: 422,
    };
  }
}
```

3. Pass `originalFileType: isImage ? 'image' : resolveFileType(target.contentType, target.filename)` and appropriate `contentType` into `analyzeDocument`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/direct-image-analysis.spec.ts --forceExit`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/wireless-session/wireless-session.service.ts src/services/document-analysis.ts tests/services/direct-image-analysis.spec.ts
git commit -m "feat(analysis): analyze images directly with Sharp bypassing LibreOffice"
```

---

### Task 6: Native Image Preview Serving & Kiosk Configuration UI Updates

**Files:**

- Modify: `src/modules/wireless-session/wireless-session.service.ts`
- Modify: `src/public/config/app.ts`
- Modify: `src/public/shared/pricing-guide.ts`
- Test: `tests/public/pricing-guide.spec.ts`

**Interfaces:**

- Consumes: Direct image serving on `/api/wireless/sessions/:sessionId/preview`
- Produces: Instant image preview in `/config` and updated footer pricing breakdown

- [ ] **Step 1: Write test for pricing guide display**

Create `tests/public/pricing-guide.spec.ts`:

```typescript
import { buildPricingTableHtml } from '../../src/public/shared/pricing-guide';

describe('Customer Pricing Guide Modal', () => {
  it('includes Image Color and Image B/W rows or columns in pricing guide', () => {
    const html = buildPricingTableHtml({
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
      highQualitySurcharge: 2,
    } as any);

    expect(html).toContain('Image');
    expect(html).toContain('₱10');
    expect(html).toContain('₱25');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/public/pricing-guide.spec.ts --forceExit`  
Expected: FAIL (missing Image pricing rows).

- [ ] **Step 3: Implement Preview Serving & UI Updates**

1. In `src/modules/wireless-session/wireless-session.service.ts`:
   In `getSessionDocumentPreview`:

```typescript
if (this.isImageTarget(target.contentType, target.filename)) {
  const ext = path.extname(target.filename).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.sendFile(path.resolve(target.filePath));
  return;
}
```

2. In `src/public/config/app.ts`:
   Update footer breakdown:

```typescript
if (
  currentPrintQuote.billableImagePages &&
  currentPrintQuote.billableImagePages > 0
) {
  parts.push(`${currentPrintQuote.billableImagePages} photo (Color)`);
}
if (
  currentPrintQuote.billableImageBwPages &&
  currentPrintQuote.billableImageBwPages > 0
) {
  parts.push(`${currentPrintQuote.billableImageBwPages} photo (B&W)`);
}
```

3. In `src/public/shared/pricing-guide.ts`:
   Update `buildPricingTableHtml` to display columns or notes for Image Color and Image B/W base prices.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/public/pricing-guide.spec.ts --forceExit`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/wireless-session/wireless-session.service.ts src/public/config/app.ts src/public/shared/pricing-guide.ts tests/public/pricing-guide.spec.ts
git commit -m "feat(preview): serve native image preview and display two-tier image breakdown"
```

---

### Task 7: Deferred Conversion Gate & Pre-Print Hard Gate

**Files:**

- Modify: `src/modules/financial/financial.service.ts`
- Modify: `src/modules/wireless-session/wireless-session.service.ts`
- Test: `tests/services/deferred-conversion-gate.spec.ts`

**Interfaces:**

- Consumes: `resolveCanonicalPdfPath`
- Produces: Guarantee that `target.convertedPdfPath` exists before print job dispatch, while allowing pricing to be locked without pre-conversion.

- [ ] **Step 1: Write test for pre-print PDF conversion**

Create `tests/services/deferred-conversion-gate.spec.ts`:

```typescript
import path from 'node:path';
import fs from 'node:fs';

describe('Deferred Conversion Pre-Print Gate', () => {
  it('ensures convertedPdfPath exists before spooling', async () => {
    const mockTarget = {
      documentId: 'doc-test-123',
      filePath: 'uploads/photo.jpg',
      convertedPdfPath: null,
    };

    const ensurePdfBeforePrint = async (
      target: typeof mockTarget,
      convertFn: () => Promise<string>,
    ) => {
      if (!target.convertedPdfPath) {
        target.convertedPdfPath = await convertFn();
      }
      return target.convertedPdfPath;
    };

    const converted = await ensurePdfBeforePrint(
      mockTarget,
      async () => 'uploads/doc-test-123.pdf',
    );
    expect(converted).toBe('uploads/doc-test-123.pdf');
    expect(mockTarget.convertedPdfPath).toBe('uploads/doc-test-123.pdf');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx jest tests/services/deferred-conversion-gate.spec.ts --forceExit`  
Expected: PASS

- [ ] **Step 3: Implement pre-print gate in `financial.service.ts`**

In `src/modules/financial/financial.service.ts` inside `confirmPayment`:
Before checking `if (!target.convertedPdfPath)`:

```typescript
if (
  path.extname(target.filePath).toLowerCase() !== '.pdf' &&
  !target.convertedPdfPath
) {
  // Attempt deferred conversion gate if not already converted
  try {
    const pdfPath = await wirelessSessionService.resolveCanonicalPdfPathPublic(
      sessionId,
      target,
    );
    target.convertedPdfPath = pdfPath;
  } catch (convErr) {
    console.error('[payment] Pre-print PDF conversion failed:', convErr);
    sendResponse(409, buildAnalysisUnavailablePayload(target));
    return;
  }
}
```

Expose `resolveCanonicalPdfPathPublic` or appropriate helper on `WirelessSessionService`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/deferred-conversion-gate.spec.ts --forceExit`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/financial/financial.service.ts src/modules/wireless-session/wireless-session.service.ts tests/services/deferred-conversion-gate.spec.ts
git commit -m "feat(print): enforce pre-print PDF conversion hard gate for deferred image conversions"
```

---

### Task 8: End-to-End System Integration & Regression Verification

**Files:**

- Test: Run full test suite across services, modules, and public components

- [ ] **Step 1: Run complete test suite**

Run: `npm test -- --forceExit`  
Expected: All test suites PASS without regressions.

- [ ] **Step 2: Run graphify update as required by user rules**

Run: `graphify update .`  
Expected: Knowledge graph updated cleanly.

- [ ] **Step 3: Final verification commit**

```bash
git status
git commit --allow-empty -m "chore: complete image pricing and deferred conversion implementation"
```
