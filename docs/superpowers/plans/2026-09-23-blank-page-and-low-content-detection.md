# Blank Page Detection and Low Content Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement blank page detection (hard-blocking 100% blank files, warning on mixed blank pages) and low content detection with transparent kiosk pricing disclaimers across customer upload and kiosk receiving surfaces.

**Architecture:** Extend the server-side analysis worker in `document-analysis.ts` to output `blankPages`, `blankPageCount`, `isEntirelyBlank`, `lowContentPages`, and `hasLowContent`. In `wireless-session.service.ts`, automatically purge 100% blank files from the session and emit `DocumentRejected`, while emitting enriched `AnalysisCompleted` for valid documents. Both `src/public/upload` and `src/public/print` (and `/config`) react to these events with real-time badges, reminders, and pricing disclaimers.

**Tech Stack:** Node.js, TypeScript, PDF.js (`pdfjs-dist`), Socket.IO, Jest, Express.js.

**Spec:** [`docs/superpowers/specs/2026-09-23-blank-page-and-low-content-detection-design.md`](file:///D:/giomj/Projects/printbit/docs/superpowers/specs/2026-09-23-blank-page-and-low-content-detection-design.md)

## Global Constraints

- `LOW_CONTENT_COVERAGE_THRESHOLD = 0.02` (2% non-white content coverage)
- `MIN_CONTENT_COVERAGE_THRESHOLD = 0.001` (0.1% non-white content coverage boundary for blank pages)
- `ANALYSIS_ALGORITHM_VERSION = 5`
- 100% blank files must be completely removed from active sessions and staged disk storage
- Mixed documents with blank pages must remain available, with blank page numbers explicitly listed
- Low content disclaimers must state clearly: pricing is determined by kiosk configuration per page, not by ink coverage or content density

---

### Task 1: Analysis Engine - Blank Page and Low Content Metrics

**Files:**
- Modify: `src/config/document-analysis.config.ts:1-7`
- Modify: `src/services/document-analysis.ts:20-75, 420-450, 680-720`
- Test: `tests/services/document-analysis-blank.spec.ts`

**Interfaces:**
- Produces:
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
    blankPages: number[];
    blankPageCount: number;
    isEntirelyBlank: boolean;
    lowContentPages: number[];
    lowContentPageCount: number;
    hasLowContent: boolean;
  }
  ```

- [ ] **Step 1: Write failing unit tests for blank page and low content detection**

Create `tests/services/document-analysis-blank.spec.ts`:

```typescript
import {
  ANALYSIS_ALGORITHM_VERSION,
  DocumentAnalysisResult,
  PageAnalysis,
} from '../../src/services/document-analysis';
import { LOW_CONTENT_COVERAGE_THRESHOLD } from '../../src/config/document-analysis.config';

describe('Document Analysis Blank & Low Content Metrics', () => {
  it('exposes ANALYSIS_ALGORITHM_VERSION as 5', () => {
    expect(ANALYSIS_ALGORITHM_VERSION).toBe(5);
  });

  it('exposes LOW_CONTENT_COVERAGE_THRESHOLD as 0.02', () => {
    expect(LOW_CONTENT_COVERAGE_THRESHOLD).toBe(0.02);
  });

  it('identifies 100% blank document correctly from page metrics', () => {
    const pages: PageAnalysis[] = [
      { index: 1, isColor: false, isBlank: true, coverage: 0, contentCoverage: 0, classification: 'blank' },
      { index: 2, isColor: false, isBlank: true, coverage: 0, contentCoverage: 0, classification: 'blank' },
    ];

    const blankPages = pages.filter((p) => p.isBlank).map((p) => p.index);
    const lowContentPages = pages
      .filter((p) => !p.isBlank && (p.contentCoverage ?? p.coverage ?? 0) < LOW_CONTENT_COVERAGE_THRESHOLD)
      .map((p) => p.index);

    const result: Partial<DocumentAnalysisResult> = {
      totalPages: 2,
      pages,
      blankPages,
      blankPageCount: blankPages.length,
      isEntirelyBlank: blankPages.length === pages.length && pages.length > 0,
      lowContentPages,
      lowContentPageCount: lowContentPages.length,
      hasLowContent: lowContentPages.length > 0,
    };

    expect(result.blankPages).toEqual([1, 2]);
    expect(result.blankPageCount).toBe(2);
    expect(result.isEntirelyBlank).toBe(true);
    expect(result.lowContentPages).toEqual([]);
    expect(result.hasLowContent).toBe(false);
  });

  it('identifies mixed document with blank and low content pages', () => {
    const pages: PageAnalysis[] = [
      { index: 1, isColor: false, isBlank: false, coverage: 0.15, contentCoverage: 0.15, classification: 'bw' },
      { index: 2, isColor: false, isBlank: true, coverage: 0, contentCoverage: 0, classification: 'blank' },
      { index: 3, isColor: false, isBlank: false, coverage: 0.008, contentCoverage: 0.008, classification: 'bw' },
    ];

    const blankPages = pages.filter((p) => p.isBlank).map((p) => p.index);
    const lowContentPages = pages
      .filter((p) => !p.isBlank && (p.contentCoverage ?? p.coverage ?? 0) < LOW_CONTENT_COVERAGE_THRESHOLD)
      .map((p) => p.index);

    const isEntirelyBlank = blankPages.length === pages.length && pages.length > 0;

    expect(blankPages).toEqual([2]);
    expect(isEntirelyBlank).toBe(false);
    expect(lowContentPages).toEqual([3]);
    expect(lowContentPages.length > 0).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/services/document-analysis-blank.spec.ts`  
Expected: FAIL (VERSION is 4 and LOW_CONTENT_COVERAGE_THRESHOLD is undefined).

- [ ] **Step 3: Implement metrics in config and document-analysis.ts**

In `src/config/document-analysis.config.ts`:
Add `export const LOW_CONTENT_COVERAGE_THRESHOLD = 0.02;`

In `src/services/document-analysis.ts`:
1. Bump `ANALYSIS_ALGORITHM_VERSION = 5`.
2. Import `LOW_CONTENT_COVERAGE_THRESHOLD` from `@/config/document-analysis.config`.
3. Add fields to `DocumentAnalysisResult`:
   - `blankPages: number[];`
   - `blankPageCount: number;`
   - `isEntirelyBlank: boolean;`
   - `lowContentPages: number[];`
   - `lowContentPageCount: number;`
   - `hasLowContent: boolean;`
4. In `analyzePdfFile` and `analyzeImage`, compute:
   ```typescript
   const blankPages = pages.filter((p) => p.isBlank).map((p) => p.index);
   const blankPageCount = blankPages.length;
   const isEntirelyBlank = totalPages > 0 && blankPageCount === totalPages;
   const lowContentPages = pages
     .filter(
       (p) =>
         !p.isBlank &&
         (p.contentCoverage ?? p.coverage ?? 0) < LOW_CONTENT_COVERAGE_THRESHOLD,
     )
     .map((p) => p.index);
   const lowContentPageCount = lowContentPages.length;
   const hasLowContent = lowContentPageCount > 0;
   ```
   and attach to the return object.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/services/document-analysis-blank.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/document-analysis.config.ts src/services/document-analysis.ts tests/services/document-analysis-blank.spec.ts
git commit -m "feat(analysis): add blank page and low content detection metrics"
```

---

### Task 2: Session Data Contracts & Normalization

**Files:**
- Modify: `src/services/session.ts:33-55`
- Modify: `src/modules/wireless-session/wireless-session.service.ts:1285-1315`
- Test: `tests/services/session-blank-contract.spec.ts`

**Interfaces:**
- Consumes: `DocumentAnalysisResult` from Task 1.
- Produces: `DocumentAnalysis` with `blankPages`, `blankPageCount`, `isEntirelyBlank`, `lowContentPages`, `lowContentPageCount`, `hasLowContent`.

- [ ] **Step 1: Write failing contract test**

Create `tests/services/session-blank-contract.spec.ts`:

```typescript
import { DocumentAnalysis } from '../../src/services/session';

describe('Session DocumentAnalysis Contract', () => {
  it('supports blank and low content summary properties', () => {
    const analysis: DocumentAnalysis = {
      analysisVersion: 5,
      fileType: 'pdf',
      pageCount: 3,
      pages: [
        { index: 1, isColor: false, isBlank: false, coverage: 0.1 },
        { index: 2, isColor: false, isBlank: true, coverage: 0 },
        { index: 3, isColor: false, isBlank: false, coverage: 0.01 },
      ],
      colorPages: 0,
      bwPages: 3,
      totalPages: 3,
      confidence: 'high',
      analyzedAt: new Date(),
      blankPages: [2],
      blankPageCount: 1,
      isEntirelyBlank: false,
      lowContentPages: [3],
      lowContentPageCount: 1,
      hasLowContent: true,
    };

    expect(analysis.blankPages).toEqual([2]);
    expect(analysis.isEntirelyBlank).toBe(false);
    expect(analysis.hasLowContent).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it compiles and runs**

Run: `pnpm test tests/services/session-blank-contract.spec.ts`  
Expected: FAIL or TypeScript type compilation error if `blankPages` doesn't exist on `DocumentAnalysis`.

- [ ] **Step 3: Update `DocumentAnalysis` and normalize payload**

In `src/services/session.ts`:
Extend `DocumentAnalysis`:
```typescript
export interface DocumentAnalysis {
  analysisVersion?: number;
  fileType:
    | 'pdf'
    | 'docx'
    | 'doc'
    | 'xlsx'
    | 'xls'
    | 'pptx'
    | 'ppt'
    | 'image'
    | 'unknown';
  pageCount: number;
  pages: DocumentPageAnalysis[];
  colorPages: number;
  bwPages: number;
  totalPages: number;
  confidence: 'high' | 'medium' | 'low';
  analyzedAt: Date;
  blankPages?: number[];
  blankPageCount?: number;
  isEntirelyBlank?: boolean;
  lowContentPages?: number[];
  lowContentPageCount?: number;
  hasLowContent?: boolean;
}
```

In `src/modules/wireless-session/wireless-session.service.ts`:
In `normalizeAnalysisPayload(value: unknown)`:
Extract and normalize `blankPages`, `blankPageCount`, `isEntirelyBlank`, `lowContentPages`, `lowContentPageCount`, `hasLowContent`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/services/session-blank-contract.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/session.ts src/modules/wireless-session/wireless-session.service.ts tests/services/session-blank-contract.spec.ts
git commit -m "feat(session): support blank and low content fields in DocumentAnalysis"
```

---

### Task 3: Backend Wireless Session Auto-Rejection Lifecycle

**Files:**
- Modify: `src/modules/wireless-session/wireless-session.service.ts:1108-1145`
- Test: `tests/modules/wireless-session/blank-rejection.spec.ts`

**Interfaces:**
- Emits:
  - `DocumentRejected`: `{ sessionId: string, documentId: string, filename: string, reason: 'ALL_PAGES_BLANK', message: string }`
  - `AnalysisCompleted`: includes enriched `analysis` with blank and low-content info when `isEntirelyBlank === false`.

- [ ] **Step 1: Write integration test for 100% blank rejection**

Create `tests/modules/wireless-session/blank-rejection.spec.ts`:

```typescript
describe('Wireless Session Blank Page Rejection', () => {
  it('correctly distinguishes 100% blank from mixed document handling', () => {
    const handleAnalysisResult = (analysis: {
      isEntirelyBlank?: boolean;
      blankPageCount?: number;
    }) => {
      if (analysis.isEntirelyBlank) {
        return { action: 'reject_and_delete', event: 'DocumentRejected', reason: 'ALL_PAGES_BLANK' };
      }
      return { action: 'persist_and_complete', event: 'AnalysisCompleted' };
    };

    expect(handleAnalysisResult({ isEntirelyBlank: true, blankPageCount: 1 })).toEqual({
      action: 'reject_and_delete',
      event: 'DocumentRejected',
      reason: 'ALL_PAGES_BLANK',
    });

    expect(handleAnalysisResult({ isEntirelyBlank: false, blankPageCount: 1 })).toEqual({
      action: 'persist_and_complete',
      event: 'AnalysisCompleted',
    });
  });
});
```

- [ ] **Step 2: Run test to verify initial behavior**

Run: `pnpm test tests/modules/wireless-session/blank-rejection.spec.ts`  
Expected: PASS.

- [ ] **Step 3: Update `processQueuedAnalysisJob` in `wireless-session.service.ts`**

In `src/modules/wireless-session/wireless-session.service.ts`:
Inside `processQueuedAnalysisJob`:
```typescript
if (analyzed.analysis.isEntirelyBlank) {
  // 1. Purge from session store
  this.deps.sessionStore.deleteDocument(job.sessionId, job.documentId);

  // 2. Clean up physical files from disk
  const targetLookup = this.resolveAnalysisTargetDocument(
    job.sessionId,
    this.buildInternalBaseUrl(),
    job.documentId,
  );
  if ('target' in targetLookup) {
    void fs.promises.unlink(targetLookup.target.filePath).catch(() => {});
    if (targetLookup.target.convertedPdfPath) {
      void fs.promises.unlink(targetLookup.target.convertedPdfPath).catch(() => {});
    }
  }

  // 3. Log audit event
  void adminService.appendAdminLog(
    'document_rejected_blank',
    `Document ${analyzed.fileName} rejected: all pages are blank.`,
    {
      sessionId: job.sessionId,
      documentId: job.documentId,
      filename: analyzed.fileName,
      pageCount: analyzed.analysis.pageCount,
    },
  );

  // 4. Emit rejection event
  this.emitToSession(job.sessionId, 'DocumentRejected', {
    sessionId: job.sessionId,
    documentId: job.documentId,
    filename: analyzed.fileName,
    reason: 'ALL_PAGES_BLANK',
    message: 'All pages in this file are blank. Blank documents cannot be sent to the kiosk.',
  });

  return;
}
```

- [ ] **Step 4: Run test suite**

Run: `pnpm test tests/modules/wireless-session/blank-rejection.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/wireless-session/wireless-session.service.ts tests/modules/wireless-session/blank-rejection.spec.ts
git commit -m "feat(wireless-session): auto-delete and reject 100% blank uploaded documents"
```

---

### Task 4: Customer Upload UI Experience (`src/public/upload`)

**Files:**
- Modify: `src/public/upload/app.ts:740-840, 580-640`
- Test: `tests/public/upload-blank-handling.spec.ts`

**Interfaces:**
- Consumes: `DocumentRejected` and `AnalysisCompleted` socket events.
- Features:
  - Local `rejectedBlankFileHashes` set tracking rejected SHA-256 hashes.
  - Red badge `"Rejected: Blank File"` on rejected items.
  - Alert banner in status box.
  - Prevent re-uploading known blank file with reminder message.
  - Warning tag for mixed documents (`⚠ Blank: p. X, Y`).
  - Low content pricing disclaimer.

- [ ] **Step 1: Write test for upload blank handling logic**

Create `tests/public/upload-blank-handling.spec.ts`:

```typescript
describe('Upload Blank Handling Helpers', () => {
  it('formats blank page warning message correctly', () => {
    const filename = 'document.pdf';
    const blankPages = [2, 5];
    const message = `⚠ "${filename}" contains ${blankPages.length} blank page(s) (Page ${blankPages.join(', ')}). Blank pages will still be billed if printed.`;
    expect(message).toContain('Page 2, 5');
    expect(message).toContain('will still be billed');
  });

  it('formats low content disclaimer correctly', () => {
    const filename = 'sparse.pdf';
    const lowPages = [1];
    const message = `ℹ Notice: "${filename}" has low content on Page ${lowPages.join(', ')}. Pricing is based on kiosk configurations per page, not content density or ink coverage.`;
    expect(message).toContain('Page 1');
    expect(message).toContain('not content density');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm test tests/public/upload-blank-handling.spec.ts`  
Expected: PASS.

- [ ] **Step 3: Implement UI updates in `src/public/upload/app.ts`**

In `src/public/upload/app.ts`:
1. Add state:
   ```typescript
   const rejectedBlankFileHashes = new Set<string>();
   ```
2. In `addFilesToQueue`:
   Check `contentHash`. If `rejectedBlankFileHashes.has(contentHash)`:
   ```typescript
   setStatus(
     `Reminder: "${file.name}" contains only blank pages and must not be sent. Please upload a document with printable content.`,
     'error',
   );
   continue;
   ```
3. In `attachSocket`:
   Add listener for `DocumentRejected`:
   ```typescript
   socket.on('DocumentRejected', (info: unknown) => {
     const data = info as {
       documentId?: string;
       filename?: string;
       reason?: string;
       message?: string;
     };
     const filename = data?.filename ?? 'file';
     const targetItem = queue.find((q) => q.file.name === filename);
     if (targetItem) {
       updateItemStatus(targetItem, 'error', 'Rejected: Blank File');
       if (targetItem.contentHash) {
         rejectedBlankFileHashes.add(targetItem.contentHash);
       }
     }
     setStatus(
       `⛔ "${filename}" was rejected: All pages are blank. Blank documents cannot be sent to the kiosk.`,
       'error',
     );
   });
   ```
4. In `AnalysisCompleted` listener:
   Extract `blankPages`, `blankPageCount`, `lowContentPages`, `hasLowContent`:
   ```typescript
   if (analysis?.blankPageCount && analysis.blankPageCount > 0) {
     setStatus(
       `⚠ "${filename}" contains ${analysis.blankPageCount} blank page(s) (Page ${analysis.blankPages.join(', ')}). Blank pages will still be billed if printed.`,
       'info',
     );
   } else if (analysis?.hasLowContent) {
     setStatus(
       `ℹ Notice: "${filename}" has low content on Page ${analysis.lowContentPages.join(', ')}. Pricing is based on kiosk configurations per page, not content density or ink coverage.`,
       'info',
     );
   }
   ```

- [ ] **Step 4: Run test to verify**

Run: `pnpm test tests/public/upload-blank-handling.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/public/upload/app.ts tests/public/upload-blank-handling.spec.ts
git commit -m "feat(upload): display blank rejection and low content disclaimers in upload UI"
```

---

### Task 5: Kiosk File Selection & Pricing Disclaimers (`src/public/print` & `src/public/config`)

**Files:**
- Modify: `src/public/print/app.ts:15-30, 150-170, 620-675, 1090-1125`
- Modify: `src/public/config/app.ts:1920-1950`
- Test: `tests/public/print-blank-warning.spec.ts`

**Interfaces:**
- Consumes: `DocumentRejected` and enriched `AnalysisCompleted` socket events.
- Features:
  - File badges: `⚠ ${blankPageCount} Blank Page(s)` and `ℹ Low Content`.
  - Footer notes with blank page numbers and pricing disclaimer.
  - Purge rejected file from kiosk list upon `DocumentRejected`.
  - Config pricing callout disclaimer for low content pages.

- [ ] **Step 1: Write unit test for kiosk warning formatters**

Create `tests/public/print-blank-warning.spec.ts`:

```typescript
describe('Print Kiosk Blank & Low Content Formatting', () => {
  it('formats kiosk selection footer hint with blank page warnings', () => {
    const blankPages = [2, 4];
    const hint = `Contains ${blankPages.length} blank page(s) (p. ${blankPages.join(', ')}). You can customize your page range on the next step.`;
    expect(hint).toContain('p. 2, 4');
  });

  it('formats kiosk low content disclaimer text', () => {
    const disclaimer = 'Notice: Pricing is based on kiosk price configurations and not page content density.';
    expect(disclaimer).toContain('kiosk price configurations');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm test tests/public/print-blank-warning.spec.ts`  
Expected: PASS.

- [ ] **Step 3: Update `src/public/print/app.ts` and `src/public/config/app.ts`**

In `src/public/print/app.ts`:
1. Extend `UploadedFile` interface:
   ```typescript
   analysis?: {
     pageCount?: number;
     totalPages?: number;
     blankPages?: number[];
     blankPageCount?: number;
     isEntirelyBlank?: boolean;
     lowContentPages?: number[];
     lowContentPageCount?: number;
     hasLowContent?: boolean;
   };
   ```
2. In `createFileItem`:
   Render badges for `blankPageCount > 0` and `hasLowContent`:
   ```typescript
   const blankBadge =
     file.analysis?.blankPageCount && file.analysis.blankPageCount > 0
       ? `<span class="file-item__blank-badge" style="display:inline-block;padding:2px 8px;border-radius:12px;background:rgba(234,179,8,0.15);color:#eab308;font-size:11px;font-weight:600;margin-left:6px;">⚠ ${file.analysis.blankPageCount} Blank Page${file.analysis.blankPageCount > 1 ? 's' : ''}</span>`
       : '';

   const lowContentBadge = file.analysis?.hasLowContent
     ? `<span class="file-item__low-badge" style="display:inline-block;padding:2px 8px;border-radius:12px;background:rgba(59,130,246,0.15);color:#3b82f6;font-size:11px;font-weight:600;margin-left:6px;">ℹ Low Content</span>`
     : '';
   ```
3. In `updateSelectionFooterHint`:
   If `file.analysis?.blankPageCount > 0`: append blank page notice.
   If `file.analysis?.hasLowContent`: append pricing disclaimer.
4. In socket handlers:
   Listen for `DocumentRejected`: remove document from `currentUploadedFiles` and refresh UI.

In `src/public/config/app.ts`:
Add callout disclaimer banner near price calculation if `hasLowContent === true`:
> *ℹ Pricing Disclaimer: Kiosk pricing is determined by kiosk configuration per page and does not adjust for low content density or ink coverage.*

- [ ] **Step 4: Run test to verify**

Run: `pnpm test tests/public/print-blank-warning.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/public/print/app.ts src/public/config/app.ts tests/public/print-blank-warning.spec.ts
git commit -m "feat(print,config): display blank page badges, footer hints, and pricing disclaimers"
```

---

### Task 6: Build Verification, Full Regression, and Graphify Sync

**Files:**
- Output bundles: `dist/`
- Graphify index: `graphify-out/`

- [ ] **Step 1: Run TypeScript / build verification**

Run: `pnpm run build`  
Expected: Build succeeds with 0 errors.

- [ ] **Step 2: Run all test suites**

Run: `pnpm test`  
Expected: All test suites pass.

- [ ] **Step 3: Run graphify update**

Run: `graphify update .`  
Expected: AST graph updated.

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "chore: verify build and sync graphify index"
```
