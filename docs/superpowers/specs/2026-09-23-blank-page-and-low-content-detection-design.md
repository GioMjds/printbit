# Blank Page Detection and Low Content Warning Specification

**Date:** 2026-09-23  
**Status:** Approved  
**Topic:** Blank Page Detection, 100% Blank File Rejection, Mixed Document Reminders, and Low Content Pricing Disclaimers across Upload and Print surfaces

---

## 1. Executive Summary

This specification defines the architecture, data contracts, and user interactions for two interrelated features in the PrintBit wireless upload and print workflow:

1. **Blank Page Detection & Auto-Rejection:**
   - **100% Blank Documents:** When an uploaded document contains exclusively blank pages (e.g. 0 printable pages), the server automatically purges it from the active session, deletes the staged files from disk, and emits a real-time `DocumentRejected` event. On the mobile upload page ([`src/public/upload`](file:///D:/giomj/Projects/printbit/src/public/upload/app.ts)), the file item is marked with a red rejection badge and an alert reminding customers that blank documents must not be sent. If the customer attempts to re-upload the same blank file, the upload client reminds and blocks them immediately.
   - **Mixed Documents (Partial Blank Pages):** Documents with both content and blank pages are retained. Customers are alerted with a clear warning listing the specific blank page numbers, reminding them that blank pages will still count towards their billable page total if printed. The kiosk screen allows users to customize their page range to exclude them if desired.

2. **Low Content Detection & Transparent Pricing Disclaimer:**
   - Pages with minimal non-white content coverage ($< 2\%$, such as header-only, date-stamp only, or single-line pages) are identified as **Low Content**.
   - Because customers may mistakenly expect a discount or lower rate for sparse content, a prominent disclaimer is displayed on both the upload screen ([`src/public/upload`](file:///D:/giomj/Projects/printbit/src/public/upload/app.ts)) and kiosk screens ([`src/public/print`](file:///D:/giomj/Projects/printbit/src/public/print/app.ts) & [`src/public/config`](file:///D:/giomj/Projects/printbit/src/public/config/app.ts)):
     > *Pricing is calculated per page based on kiosk price configurations (standard Black & White / Color rates), and does not adjust for low content density or ink coverage.*

---

## 2. Architecture & Data Contracts

### 2.1 Configuration Thresholds
In [`src/config/document-analysis.config.ts`](file:///D:/giomj/Projects/printbit/src/config/document-analysis.config.ts):

```typescript
export const COLOR_SATURATION_THRESHOLD = 0.05;
export const COLOR_PAGE_COVERAGE_THRESHOLD = 0.05;
export const FULL_COLOR_PAGE_COVERAGE_THRESHOLD = 0.95;
export const MIN_CONTENT_COVERAGE_THRESHOLD = 0.001; // Defines blank page boundary (0.1% non-white content)
export const LOW_CONTENT_COVERAGE_THRESHOLD = 0.02;  // Defines low-content boundary (2.0% non-white content)
export const PDF_RENDER_SCALE = 0.35;
export const MAX_PIXELS_TO_SAMPLE = 200_000;
```

### 2.2 Analysis Engine & Schema Updates
In [`src/services/document-analysis.ts`](file:///D:/giomj/Projects/printbit/src/services/document-analysis.ts) and [`src/services/session.ts`](file:///D:/giomj/Projects/printbit/src/services/session.ts):

- **Algorithm Version:** Bump `ANALYSIS_ALGORITHM_VERSION` from `4` to `5` to invalidate stale cached results.
- **Data Model Extensions:**

```typescript
export interface DocumentAnalysisResult {
  fileType: AnalyzedFileType;
  pageCount: number;
  pages: PageAnalysis[];
  colorPages: number;
  bwPages: number;
  totalPages: number;
  confidence?: AnalysisConfidence;
  analysisVersion: number;
  // Blank & Low Content Summary:
  blankPages: number[];         // 1-indexed list of blank page numbers, e.g. [2, 4]
  blankPageCount: number;       // blankPages.length
  isEntirelyBlank: boolean;     // true when blankPageCount === totalPages && totalPages > 0
  lowContentPages: number[];    // 1-indexed list of non-blank pages below LOW_CONTENT_COVERAGE_THRESHOLD
  lowContentPageCount: number;  // lowContentPages.length
  hasLowContent: boolean;       // true when lowContentPageCount > 0
}
```

### 2.3 Real-Time Socket Events
Wireless session sockets emit the following events to the session room:

1. **`DocumentRejected` (New Event):**
   ```typescript
   {
     sessionId: string;
     documentId: string;
     filename: string;
     reason: 'ALL_PAGES_BLANK';
     message: 'This file cannot be sent because all pages are blank.';
   }
   ```
2. **`AnalysisCompleted` (Enriched Payload):**
   ```typescript
   {
     documentId: string;
     filename: string;
     analysis: DocumentAnalysisResult;
   }
   ```

---

## 3. Backend Processing & Auto-Rejection Lifecycle

### 3.1 Analysis Execution in `wireless-session.service.ts`
Inside `processQueuedAnalysisJob`:
1. Execute `analyzeAndStoreDocument`.
2. Inspect `analyzed.analysis.isEntirelyBlank`:
   - **Case A: `isEntirelyBlank === true` (100% Blank Document)**
     - Delete the document from session state: `this.deps.sessionStore.deleteDocument(sessionId, documentId)`.
     - Remove physical files from disk (the uploaded file and any converted preview PDF).
     - Audit log: `adminService.appendAdminLog('document_rejected_blank', ...)`.
     - Emit `DocumentRejected` to the session room.
     - Terminate job early (do not emit `AnalysisCompleted`).
   - **Case B: `isEntirelyBlank === false` (Valid Document with Content)**
     - Store analysis in session state.
     - Emit `AnalysisCompleted` with enriched metadata.

### 3.2 Kiosk Session Query Guard
When the kiosk requests `GET /api/wireless/sessions/:sessionId`, `session.documents` only contains non-deleted, accepted documents. Rejected 100% blank files will never appear on the kiosk.

---

## 4. Customer Upload UI Experience (`src/public/upload`)

### 4.1 Rejection of 100% Blank Files
In [`src/public/upload/app.ts`](file:///D:/giomj/Projects/printbit/src/public/upload/app.ts):
- On receiving `DocumentRejected` with `reason: 'ALL_PAGES_BLANK'`:
  - Locate queue item: update status badge to `error` with text `"Rejected: Blank File"`.
  - Set status banner:
    > ⛔ **"${filename}" was rejected:** All pages are blank. Blank documents cannot be sent to the kiosk.
  - Store content hash in local `rejectedBlankFileHashes` set.
- **Repeated Blank Upload Prevention:**
  - If the customer attempts to upload a file whose SHA-256 hash exists in `rejectedBlankFileHashes`:
    - Refuse addition to the upload queue.
    - Display reminder alert: *"Reminder: This file contains only blank pages and must not be sent. Please upload a document with printable content."*

### 4.2 Mixed Documents (Some Blank Pages)
- On `AnalysisCompleted` where `analysis.blankPageCount > 0`:
  - Show warning badge on the queue item: `⚠ Blank: p. ${analysis.blankPages.join(', ')}`.
  - Display alert in the status box:
    > ⚠ **"${filename}" contains ${analysis.blankPageCount} blank page(s) (Page ${analysis.blankPages.join(', ')}):** Blank pages will still count towards your billed page count if printed.

### 4.3 Low Content Disclaimer
- On `AnalysisCompleted` where `analysis.hasLowContent === true`:
  - Display disclaimer in the upload status box:
    > ℹ **Low Content Notice for "${filename}":** Low ink/text content detected on Page ${analysis.lowContentPages.join(', ')}. PrintBit charges per page based on kiosk price settings, not content density or ink usage.

---

## 5. Kiosk UI Experience & Pricing Disclaimers

### 5.1 Kiosk File Selection Screen ([`src/public/print`](file:///D:/giomj/Projects/printbit/src/public/print/app.ts))
- **File List Items ([`createFileItem`](file:///D:/giomj/Projects/printbit/src/public/print/app.ts#L640-L670)):**
  - For files with blank pages (`blankPageCount > 0`), render yellow warning pill:
    `<span class="file-item__blank-badge">⚠ ${blankPageCount} Blank Page(s)</span>`
  - For files with low content (`hasLowContent === true`), render blue info pill:
    `<span class="file-item__low-badge">ℹ Low Content</span>`
- **Selection Footer Hint ([`updateSelectionFooterHint`](file:///D:/giomj/Projects/printbit/src/public/print/app.ts#L152-L165)):**
  - If selected file has blank pages: append note: *"Contains ${blankPageCount} blank page(s) (p. ${blankPages.join(', ')}). You can customize your page range on the next step."*
  - If selected file has low content: append pricing disclaimer: *"Pricing is based on kiosk price configurations and not page content density."*
- **Real-Time Rejection Socket Handling:**
  - If `DocumentRejected` is received by the kiosk socket, ensure the file is removed from `currentUploadedFiles` and the file list updates immediately.

### 5.2 Kiosk Configuration & Payment Screen ([`src/public/config`](file:///D:/giomj/Projects/printbit/src/public/config/app.ts))
- **Thumbnail / Page Selector:**
  - Indicate blank pages with a distinct `Blank` marker in page previews so customers can easily uncheck/exclude them from their custom page range.
- **Price Quote Callout:**
  - When the selected document has low content or blank pages, render a dedicated callout near the total quote:
    > ℹ **Pricing Disclaimer:** Kiosk pricing is determined by kiosk configuration (per-page Black & White / Color rate) and does not adjust for low ink or content density.

---

## 6. Error Handling & Edge Cases

| Scenario | Behavior |
|---|---|
| Corrupt or unparseable document | Document analysis emits `AnalysisFailed`. The file is retained with standard fallback pricing rather than being falsely rejected. |
| Page with faint watermark or header | Content coverage is $> 0.001$ so it is not classified as blank. If $< 0.02$, it is safely classified as Low Content with transparent disclaimers. |
| Non-PDF Office document (DOCX/XLSX/PPTX) | The document is converted to PDF preview first. Blank and low content detection run against the generated PDF preview, providing identical behavior. |
| Client disconnects before analysis completes | Server completes auto-rejection and file deletion independently. When client reconnects or polls session, the blank file is absent. |

---

## 7. Verification & Testing Strategy

### 7.1 Unit Tests ([`tests/unit/document-analysis.test.ts`](file:///D:/giomj/Projects/printbit/tests/unit/))
- **100% Blank PDF:** Returns `isEntirelyBlank: true`, `blankPages: [1]`, `blankPageCount: 1`.
- **Mixed PDF:** Returns `isEntirelyBlank: false`, `blankPages: [2]`, `blankPageCount: 1`.
- **Low Content PDF (< 2% coverage):** Returns `hasLowContent: true`, `lowContentPages: [1]`.
- **Standard Content PDF (> 2% coverage):** Returns `hasLowContent: false`, `isEntirelyBlank: false`.

### 7.2 Integration Tests ([`tests/integration/wireless-session.test.ts`](file:///D:/giomj/Projects/printbit/tests/integration/))
- Test upload of 100% blank file: confirm `DocumentRejected` socket event is emitted, file is deleted from `sessionStore`, and disk files are pruned.
- Test upload of mixed file: confirm `AnalysisCompleted` socket event includes `blankPages` and file is retained in session.

### 7.3 Manual E2E Verification
- Upload 100% blank PDF via mobile upload: verify rejection badge, alert banner, and blocked re-upload.
- Upload mixed PDF via mobile upload: verify warning badge with page numbers and print billing reminder.
- Verify kiosk file list badges (`⚠ Blank Page(s)`, `ℹ Low Content`) and footer notes.
- Verify kiosk configuration page disclaimer callout.
