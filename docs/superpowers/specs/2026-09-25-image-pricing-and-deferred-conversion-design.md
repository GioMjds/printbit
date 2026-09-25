# Image Formats Direct Pricing & Deferred PDF Conversion Design

**Date:** 2026-09-25  
**Status:** Approved  
**Author:** Antigravity & User

---

## 1. Overview & Problem Statement

Currently in PrintBit, all non-PDF uploads (including images like JPEG, PNG, JPG) are immediately sent through LibreOffice conversion to produce a canonical PDF artifact before document analysis or pricing calculation can occur. This introduces several friction points:

1. **Slow Kiosk Onboarding:** Users uploading images are blocked by a modal dialog ("Preparing your file") waiting for LibreOffice to convert images into a PDF before they can enter the configuration screen or view pricing.
2. **Coarse Image Pricing:** There is only a single `baseImagePrice` tier designed for full-color photos. Black-and-white photos or sketches fall back to standard text document B&W pricing (`baseBwPrice`), despite consuming significantly more toner/ink than regular text pages.
3. **Missing GIF Format:** GIF files (`.gif`, `image/gif`) are not accepted by the upload validation layer, even though Sharp and LibreOffice can process them.
4. **Premature PDF Conversion:** PDF conversion is coupled to upload analysis rather than being treated as a print spooler prerequisite.

### Goals

- **Differentiated Image Pricing:** Introduce a dedicated `baseImageBwPrice` alongside `baseImagePrice` (Image Color) across all paper sizes (`a4`, `shortBond`, `longBond`), configurable in the Admin Settings.
- **Format Expansion:** Support GIF (`.gif`, `image/gif`) with magic byte validation across upload, preview, analysis, and conversion.
- **Direct Pre-Conversion Image Analysis:** Bypass LibreOffice during upload analysis for all image formats. Analyze images directly using Sharp in ~5ms to instantly classify color vs. B/W and lock pricing.
- **Instant Native Preview:** Serve original image files directly with native image MIME types for preview in `/config`.
- **Deferred PDF Conversion:** Defer the generation of the PDF print artifact until after the user configures settings and locks payment, backed by opportunistic background conversion.

---

## 2. Architecture & Data Flow

```
+-----------------------------------------------------------------------------------+
| UPLOAD & PREVIEW FLOW (Instant, No LibreOffice)                                  |
|                                                                                   |
|  User uploads image (JPG/PNG/GIF)                                                 |
|          |                                                                        |
|          v                                                                        |
|  Upload Middleware (file-types.ts) ---> Validates magic bytes & MIME              |
|          |                                                                        |
|          v                                                                        |
|  Wireless Session Service                                                         |
|          |                                                                        |
|          +---> Skip resolveCanonicalPdfPath() for images                          |
|          +---> Call analyzeDocument() directly on raw image file                  |
|                     |                                                             |
|                     v                                                             |
|          Sharp computeFrameMetrics() (~5ms)                                       |
|          Detects: pageCount=1, isColor, isImagePage=true                          |
|          Classification: 'image' (Color) or 'bw' (Image B/W)                      |
|                     |                                                             |
|                     v                                                             |
|          Session Analysis Persisted & Cached                                      |
|                                                                                   |
|  Kiosk UI (/print -> /config)                                                     |
|          |                                                                        |
|          +---> /print: Immediate selection, no "Preparing your file" dialog       |
|          +---> /preview: Serves raw image file directly with image/* MIME         |
|          +---> /config: HTMLImageElement renders image preview immediately        |
|          +---> Quote: Bills baseImagePrice (Color) or baseImageBwPrice (B/W)      |
+-----------------------------------------------------------------------------------+

                                      |
                                      | Customer confirms settings & proceeds
                                      v

+-----------------------------------------------------------------------------------+
| CONVERSION & PAYMENT LOCK FLOW                                                    |
|                                                                                   |
|  /config or /confirm navigation                                                   |
|          |                                                                        |
|          +---> (Optional / Opportunistic) Background convertToPdfArtifact()       |
|                                                                                   |
|  Payment Confirmation (POST /api/confirm-payment)                                 |
|          |                                                                        |
|          v                                                                        |
|  Financial Service: Price is locked and verified against quote                    |
|          |                                                                        |
|          v                                                                        |
|  Pre-Print Hard Gate:                                                             |
|  Ensure target.convertedPdfPath exists.                                           |
|  If not yet converted -> await resolveCanonicalPdfPath()                         |
|          |                                                                        |
|          v                                                                        |
|  Print Job Spooler receives canonical PDF with locked print parameters            |
+-----------------------------------------------------------------------------------+
```

---

## 3. Detailed Component Specifications

### 3.1. Database Schema & Migration

- **File:** `src/core/database/models/admin.model.ts`
  ```typescript
  export interface PaperPricingProfile {
    baseBwPrice: number;
    baseColorPrice: number;
    baseImagePrice: number; // Image/Colored price
    baseImageBwPrice: number; // New: Image/Black & White price
  }
  ```
- **File:** `src/core/database/db.ts`
  - Default pricing configurations:
    - `a4`: `baseBwPrice: 3`, `baseColorPrice: 18`, `baseImagePrice: 25`, `baseImageBwPrice: 10`
    - `shortBond`: `baseBwPrice: 3`, `baseColorPrice: 18`, `baseImagePrice: 25`, `baseImageBwPrice: 10`
    - `longBond`: `baseBwPrice: 4`, `baseColorPrice: 20`, `baseImagePrice: 30`, `baseImageBwPrice: 12`
  - Migration / normalization: In `normalizePricingEngine`, if `baseImageBwPrice` is undefined, default it to `10` for `a4`/`shortBond` and `12` for `longBond`.

### 3.2. Admin Settings & Validation

- **File:** `src/modules/admin/admin.controller.ts`
  - Validate `incoming.paperProfiles.<size>.baseImageBwPrice`:
    - Must be a non-negative integer (`isWholePeso(val) && val >= 0`).
    - Must satisfy `val >= baseBwPrice` (cannot be cheaper than document B&W).
    - Must satisfy `val <= baseImagePrice` (cannot exceed color photo price).
- **File:** `src/modules/admin/admin.service.ts` & `src/services/admin.ts`
  - Update `calculateJobAmount` and `calculateDocumentAmount`:
    ```typescript
    export interface DocumentPageCounts {
      colorPages: number;
      bwPages: number;
      imagePages?: number; // Colored images
      imageBwPages?: number; // Black & White images
    }
    ```
  - Price formula:
    ```typescript
    const subtotalExact =
      (safeColorPages * profile.baseColorPrice +
        safeBwPages * profile.baseBwPrice +
        safeImagePages * baseImagePrice +
        safeImageBwPages *
          (profile.baseImageBwPrice ?? (profileKey === 'longBond' ? 12 : 10)) +
        totalPages * surchargePerPg) *
      safeCopies;
    ```
- **File:** `src/public/admin/settings/`
  - In `index.html`: Add an input column for `baseImageBwPrice` ("Image B/W (₱)").
  - In `app.ts` & `shared.ts`: Load, display, and submit `baseImageBwPrice`.

### 3.3. File Type & GIF Support

- **File:** `src/utils/file-types.ts`
  - Add `'image/gif'` to `ALLOWED_MIME_TYPES`.
  - Add `'.gif'` to `ALLOWED_EXTENSIONS`.
  - Add GIF magic signatures:
    - `GIF87a`: `[0x47, 0x49, 0x46, 0x38, 0x37, 0x61]`
    - `GIF89a`: `[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]`
  - Map `'.gif': 'image/gif'` in `EXTENSION_MIME_MAP`.
- **Upload UI (`src/public/upload/`):**
  - Update `index.html` file input: `accept=".pdf,.doc,.docx,.jpeg,.jpg,.png,.gif"`.
  - Update `app.ts`: Add `.gif` and `image/gif` to file type checks and preview renderers.

### 3.4. Direct Image Analysis (Sharp)

- **File:** `src/modules/wireless-session/wireless-session.service.ts`
  - Helper `isImageDocument(target)`: checks if MIME begins with `image/` or extension is in `['.jpg', '.jpeg', '.png', '.gif']`.
  - In `analyzeAndStoreDocument`:
    ```typescript
    const isImage = this.isImageDocument(target);
    let analysisFilePath: string;
    if (isImage) {
      analysisFilePath = absoluteFilePath;
    } else {
      analysisFilePath = await this.resolveCanonicalPdfPath(sessionId, target);
    }
    ```
  - Call `analyzeDocument` with `originalFileType: isImage ? 'image' : ...`.
- **File:** `src/services/document-analysis.ts`
  - In `analyzeDocumentDirect`: When `fileType === 'image'` and path is not `.pdf`, call `analyzeImage(filePath, colorDetectionEnabled)`.
  - In `analyzeImage`:
    - Load via `sharp(filePath)`. For GIFs, Sharp reads the first frame by default.
    - Run `computeFrameMetrics`.
    - Mark `isImagePage: !isBlank`.
    - Set `classification: isBlank ? 'blank' : isColor ? 'image' : 'bw'`.
    - Return high confidence result in ~5ms.

### 3.5. Native Image Preview

- **File:** `src/modules/wireless-session/wireless-session.service.ts`
  - In `getSessionDocumentPreview`:
    - If `target` is an image (`isImageDocument(target)`), serve the original image file directly with `res.sendFile(target.filePath)` and appropriate `Content-Type`.
- **File:** `src/public/config/app.ts`
  - Already contains `loadImage(blobUrl)` for `image/*` responses.
  - Preview renders immediately on canvas without initializing PDF.js.

### 3.6. Deferred Conversion & Hard Pre-Print Gate

- **Opportunistic Background Conversion:**
  - In `wireless-session.service.ts`, when `/api/wireless/sessions/:sessionId/config` or quote is accessed for an image, initiate `resolveCanonicalPdfPath(sessionId, target)` in the background (fire-and-forget promise cached in `inFlightConversions`).
- **Hard Pre-Print Gate in `src/modules/financial/financial.service.ts`:**
  - In `confirmPayment`:
    ```typescript
    if (!target.convertedPdfPath && this.isImageDocument(target)) {
      await this.resolveCanonicalPdfPath(sessionId, target);
    }
    ```
  - Ensures `printSourcePath` points to a fully generated PDF artifact before printer spooling.

### 3.7. Print Quoting & Billing Breakdown

- **File:** `src/services/print-quote.ts`
  - Update `PrintQuote` interface:
    ```typescript
    export interface PrintQuote {
      // ... existing fields
      billableImagePages?: number; // Colored photos
      billableImageBwPages?: number; // B&W photos
    }
    ```
  - In `buildPrintQuote`:
    - If `input.colorMode === 'colored'`:
      - For each page in `selectedPages`:
        - If `page.isImagePage`:
          - If `page.isColor`: `billableImagePages += 1` (Color photo tier).
          - Else: `billableImageBwPages += 1` (B&W photo tier).
        - Else: normal document color vs. B&W logic.
    - If `input.colorMode === 'grayscale'`:
      - For each page:
        - If `page.isImagePage`: `billableImageBwPages += 1` (B&W photo tier).
        - Else: `billableBwPages += 1` (Document B&W tier).
      - `billableColorPages = 0`, `billableImagePages = 0`.
    - Effective Color Mode:
      - If user requested `'colored'`, but `billableColorPages === 0` and `billableImagePages === 0`, downgrade `effectiveColorMode` to `'grayscale'`.
    - Amount calculation:
      - Pass `{ colorPages: billableColorPages, bwPages: billableBwPages, imagePages: billableImagePages, imageBwPages: billableImageBwPages }` to `adminService.calculateDocumentAmount`.
- **Kiosk UI Updates:**
  - `src/public/config/app.ts`: In `renderFooterSummary`, display photo breakdown:
    - `X photo (Color)` if `billableImagePages > 0`.
    - `X photo (B&W)` if `billableImageBwPages > 0`.
  - `src/public/shared/pricing-guide.ts`: Include Image Color and Image B/W rows in the pricing table modal.

---

## 4. Error Handling & Edge Cases

1. **Animated GIFs:** Sharp processes frame 0 by default when reading GIFs without multi-page options. Color detection and metrics evaluate frame 0. When LibreOffice converts the GIF to PDF, it renders the static frame cleanly.
2. **Corrupt / Truncated Image Files:** If Sharp fails to decode an uploaded image during `analyzeImage`, `analyzeDocument` catches the error and marks analysis status as failed with confidence `low`. The user is notified on the kiosk UI to choose another file.
3. **Pure B&W Photo in Color Mode:** If a black-and-white image is uploaded and user leaves mode on "Color", the algorithm detects `page.isColor === false` and `isImagePage === true`. It bills at `baseImageBwPrice` and sets `effectiveColorMode` to `'grayscale'`, preventing accidental overcharge and preserving color ink.
4. **Colored Photo switched to B&W:** If a user selects "Black & White / Grayscale" for a colored image, it bills at `baseImageBwPrice` and prints using pure black toner/ink.
5. **Slow / Interrupted PDF Conversion at Payment:** If the opportunistic background conversion has not finished when the user pays, the payment handler awaits completion. If conversion ultimately fails, the payment transaction fails safely before balance deduction.

---

## 5. Verification & Testing Plan

1. **Unit Tests:**
   - Test `buildPrintQuote` with Image Color vs. Image B/W under both `colored` and `grayscale` color modes.
   - Test `calculateJobAmount` with `imageBwPages`.
   - Test `file-types.ts` with valid and invalid GIF magic signatures.
   - Test `analyzeImage` on test JPEG, PNG, and GIF fixtures.
2. **Integration Tests:**
   - Upload test image (JPEG, PNG, GIF) via `/api/wireless/sessions/:sessionId/documents`.
   - Verify analysis completes in < 50ms with status `completed` without LibreOffice worker interaction.
   - Verify `/preview` returns native image binary with correct Content-Type.
   - Verify `/api/print/quote` returns expected `baseImageBwPrice` and `baseImagePrice`.
   - Verify payment confirmation produces canonical PDF artifact in spool directory.
3. **E2E / Browser Verification:**
   - Verify kiosk `/upload` accepts GIF files.
   - Verify `/print` screen navigates to `/config` immediately without "Preparing your file" dialog.
   - Verify `/config` preview displays the image immediately and updates footer price dynamically when toggling between Color and B&W.
