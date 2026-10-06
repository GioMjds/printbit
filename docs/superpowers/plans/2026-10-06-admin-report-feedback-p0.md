# Admin Reports & Feedback Phase P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase P0 of PrintBit Admin Reports & Feedback enhancement: non-destructive database migrations, report resolution tracking (reasons, notes, timestamps, timeline, transaction ref links), system logging, and feedback safe archive/purge protection with updated status workflows.

**Architecture:** Additive SQLite schema updates via `ensureSchema` with PRAGMA column checks; domain model and service extensions for transaction refs and resolution guardrails; Express controller endpoints with validation and admin audit logging; customer kiosk query-param auto-capture; and vanilla TypeScript/HTML admin console UI enhancements.

**Tech Stack:** TypeScript, Node.js (v22+), SQLite (`node:sqlite` DatabaseSync), Express, Vanilla DOM API.

**Spec:** [docs/superpowers/specs/2026-10-06-admin-report-feedback-p0-design.md](../../superpowers/specs/2026-10-06-admin-report-feedback-p0-design.md)

## Global Constraints

- No external migrations library or CLI; all migrations must run idempotently in `ensureSchema()` in `src/core/database/sqlite-storage.ts`.
- Non-destructive schema updates only (additive columns via `ALTER TABLE ADD COLUMN`).
- Existing SQLite table names in code: `report_issue_entries` and `feedback_entries`.
- Resolution reasons enum: `refunded`, `reprinted`, `hardware_fix`, `no_fault_found`, `duplicate`, `user_error`, `other`.
- Feedback purge requires exact confirmation string: `"PURGE"`.
- Preserve existing admin auth (`requireAdminLocalAccess`, `requireAdminPin`) on all admin endpoints.
- After code modifications, run `graphify update .` to maintain knowledge graph.

---

### Task 1: Database Schema Migrations for Reports & Feedback

**Files:**
- Modify: `src/core/database/sqlite-storage.ts:240-270` and migration section after line 500
- Test: `tests/core/database/report-feedback-migration.test.ts`

**Interfaces:**
- Produces:
  - `report_issue_entries` table with columns: `transaction_ref TEXT`, `resolution_reason TEXT`, `resolution_note TEXT`, and index `idx_report_issue_entries_transaction_ref`.
  - `feedback_entries` table with columns: `transaction_ref TEXT`, `needs_action INTEGER NOT NULL DEFAULT 0`, `archived_at TEXT`, and index `idx_feedback_entries_archived_at`.
  - Migrated feedback rows: `status = 'new'` (from `'open'`), `status = 'reviewed'` (from `'resolved'`).

- [ ] **Step 1: Write the failing test for schema migrations**

Create `tests/core/database/report-feedback-migration.test.ts`:
```typescript
import { DatabaseSync } from 'node:sqlite';

describe('Report and Feedback Schema Migration', () => {
  it('adds missing columns and indexes to report_issue_entries and feedback_entries', () => {
    const db = new DatabaseSync(':memory:');
    // Set up legacy tables
    db.exec(`
      CREATE TABLE feedback_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        comment TEXT NOT NULL,
        category TEXT,
        rating INTEGER,
        status TEXT NOT NULL,
        resolved_at TEXT,
        meta_json TEXT
      );
      CREATE TABLE report_issue_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        attachment_ids_json TEXT NOT NULL,
        acknowledged_at TEXT,
        resolved_at TEXT,
        meta_json TEXT
      );
      INSERT INTO feedback_entries (id, session_id, timestamp, comment, status)
      VALUES ('f1', 's1', '2026-10-01T00:00:00Z', 'Good job', 'open'),
             ('f2', 's2', '2026-10-02T00:00:00Z', 'Paper jam fixed', 'resolved');
    `);

    // Verify migrations apply properly
    const reportColsBefore = new Set(
      (db.prepare('PRAGMA table_info(report_issue_entries)').all() as any[]).map((r) => r.name)
    );
    expect(reportColsBefore.has('transaction_ref')).toBe(false);

    // Run migration snippet
    const reportColRows = db.prepare('PRAGMA table_info(report_issue_entries)').all() as any[];
    const reportCols = new Set(reportColRows.map((r) => r.name));
    if (!reportCols.has('transaction_ref')) {
      db.exec('ALTER TABLE report_issue_entries ADD COLUMN transaction_ref TEXT');
    }
    if (!reportCols.has('resolution_reason')) {
      db.exec('ALTER TABLE report_issue_entries ADD COLUMN resolution_reason TEXT');
    }
    if (!reportCols.has('resolution_note')) {
      db.exec('ALTER TABLE report_issue_entries ADD COLUMN resolution_note TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_report_issue_entries_transaction_ref ON report_issue_entries(transaction_ref)');

    const feedbackColRows = db.prepare('PRAGMA table_info(feedback_entries)').all() as any[];
    const feedbackCols = new Set(feedbackColRows.map((r) => r.name));
    if (!feedbackCols.has('transaction_ref')) {
      db.exec('ALTER TABLE feedback_entries ADD COLUMN transaction_ref TEXT');
    }
    if (!feedbackCols.has('needs_action')) {
      db.exec('ALTER TABLE feedback_entries ADD COLUMN needs_action INTEGER NOT NULL DEFAULT 0');
    }
    if (!feedbackCols.has('archived_at')) {
      db.exec('ALTER TABLE feedback_entries ADD COLUMN archived_at TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_entries_archived_at ON feedback_entries(archived_at)');
    db.exec("UPDATE feedback_entries SET status = 'new' WHERE status = 'open'");
    db.exec("UPDATE feedback_entries SET status = 'reviewed' WHERE status = 'resolved'");

    // Verify
    const feedbackColsAfter = new Set(
      (db.prepare('PRAGMA table_info(feedback_entries)').all() as any[]).map((r) => r.name)
    );
    expect(feedbackColsAfter.has('transaction_ref')).toBe(true);
    expect(feedbackColsAfter.has('needs_action')).toBe(true);
    expect(feedbackColsAfter.has('archived_at')).toBe(true);

    const f1 = db.prepare("SELECT status FROM feedback_entries WHERE id = 'f1'").get() as any;
    expect(f1.status).toBe('new');
    const f2 = db.prepare("SELECT status FROM feedback_entries WHERE id = 'f2'").get() as any;
    expect(f2.status).toBe('reviewed');
  });
});
```

- [ ] **Step 2: Run test to verify it passes in isolation**

Run: `npx jest tests/core/database/report-feedback-migration.test.ts`
Expected: PASS

- [ ] **Step 3: Update `src/core/database/sqlite-storage.ts`**

In `ensureSchema(db: DatabaseSync)`:
1. Update `CREATE TABLE IF NOT EXISTS report_issue_entries` statement to include new columns:
   `transaction_ref TEXT`, `resolution_reason TEXT`, `resolution_note TEXT`.
   Add `CREATE INDEX IF NOT EXISTS idx_report_issue_entries_transaction_ref ON report_issue_entries(transaction_ref);`.
2. Update `CREATE TABLE IF NOT EXISTS feedback_entries` statement to include:
   `transaction_ref TEXT`, `needs_action INTEGER NOT NULL DEFAULT 0`, `archived_at TEXT`.
   Add `CREATE INDEX IF NOT EXISTS idx_feedback_entries_archived_at ON feedback_entries(archived_at);`.
3. In migration check section (where `PRAGMA table_info` checks run):
   Add check for `report_issue_entries` columns (`transaction_ref`, `resolution_reason`, `resolution_note`).
   Add check for `feedback_entries` columns (`transaction_ref`, `needs_action`, `archived_at`).
   Run migration update for statuses:
   ```typescript
   db.exec("UPDATE feedback_entries SET status = 'new' WHERE status = 'open'");
   db.exec("UPDATE feedback_entries SET status = 'reviewed' WHERE status = 'resolved'");
   ```

- [ ] **Step 4: Commit**

```bash
git add src/core/database/sqlite-storage.ts tests/core/database/report-feedback-migration.test.ts
git commit -m "feat(db): add report resolution and feedback archive columns with status migration"
```

---

### Task 2: Update Report & Feedback Domain Models

**Files:**
- Modify: `src/core/database/models/report-issue.model.ts`
- Modify: `src/core/database/models/feedback.model.ts`
- Test: `tests/core/database/models/report-issue.model.test.ts`
- Test: `tests/core/database/models/feedback.model.test.ts`

**Interfaces:**
- Consumes: Migrated tables in SQLite.
- Produces:
  - `ReportResolutionReason` enum type.
  - `ReportIssueEntry` interface with `transactionRef`, `resolutionReason`, `resolutionNote`.
  - `updateReportIssueStatus(id, status, options)` with required `resolutionReason` when status is `resolved`.
  - `FeedbackStatus` updated to `'new' | 'reviewed' | 'archived'` (with compatibility for legacy `'open' | 'resolved'`).
  - `FeedbackEntry` interface with `transactionRef`, `needsAction`, `archivedAt`.
  - `archiveFeedback(id)`, `archiveAllReviewedFeedback()`, `setNeedsAction(id, boolean)`, `purgeFeedback(id, confirm)`, `purgeAllFeedback(confirm)`.

- [ ] **Step 1: Write unit tests for `report-issue.model.ts` resolution flow**

Add tests verifying:
- `createReportIssue` persists `transactionRef`.
- `updateReportIssueStatus(id, 'acknowledged')` sets `acknowledgedAt`.
- `updateReportIssueStatus(id, 'resolved', { resolutionReason: 'refunded', resolutionNote: 'Refunded 10 PHP' })` sets `resolvedAt`, `resolutionReason`, `resolutionNote`.
- Calling `updateReportIssueStatus(id, 'resolved')` without a valid `resolutionReason` throws an error.

- [ ] **Step 2: Update `src/core/database/models/report-issue.model.ts`**

- Add export:
  ```typescript
  export type ReportResolutionReason =
    | 'refunded'
    | 'reprinted'
    | 'hardware_fix'
    | 'no_fault_found'
    | 'duplicate'
    | 'user_error'
    | 'other';
  ```
- Update `ReportIssueEntry`:
  ```typescript
  export interface ReportIssueEntry {
    id: string;
    sessionId: string;
    timestamp: string;
    title: string;
    description: string;
    category: ReportIssueCategory;
    status: ReportIssueStatus;
    attachmentIds: string[];
    acknowledgedAt: string | null;
    resolvedAt: string | null;
    transactionRef?: string | null;
    resolutionReason?: ReportResolutionReason | null;
    resolutionNote?: string | null;
    meta?: Record<string, string | number | boolean | null>;
  }
  ```
- Update `createReportIssue` to accept optional `transactionRef?: string | null` and insert into `transaction_ref`.
- Update `updateReportIssueStatus(id: string, status: ReportIssueStatus, options?: { resolutionReason?: ReportResolutionReason; resolutionNote?: string | null })`.
  - If `status === 'resolved'` and `!options?.resolutionReason`, throw `new Error('Resolution reason is required to resolve a report.')`.
  - Update `acknowledged_at = COALESCE(acknowledged_at, ?)` when acknowledging.
  - Update `resolved_at`, `resolution_reason`, `resolution_note` when resolving.
- Map row to include `transactionRef`, `resolutionReason`, `resolutionNote`.

- [ ] **Step 3: Write unit tests for `feedback.model.ts` archive & purge flow**

Add tests verifying:
- Feedback creation with optional `transactionRef`.
- `archiveFeedback(id)` sets `status = 'archived'` and `archivedAt`.
- `archiveAllReviewedFeedback()` archives all items with status `'reviewed'`.
- `setNeedsAction(id, true)` updates `needs_action`.
- `purgeFeedback(id, 'WRONG')` throws error; `purgeFeedback(id, 'PURGE')` permanently deletes row.

- [ ] **Step 4: Update `src/core/database/models/feedback.model.ts`**

- Update `FeedbackStatus`:
  ```typescript
  export type FeedbackStatus = 'new' | 'reviewed' | 'archived' | 'open' | 'resolved';
  ```
- Update `FeedbackEntry`:
  ```typescript
  export interface FeedbackEntry {
    id: string;
    sessionId: string;
    timestamp: string;
    comment: string;
    category: FeedbackCategory | null;
    rating: number | null;
    status: FeedbackStatus;
    resolvedAt?: string | null;
    transactionRef?: string | null;
    needsAction: boolean;
    archivedAt?: string | null;
    meta?: Record<string, string | number | boolean | null>;
  }
  ```
- Implement `archiveFeedback(id: string)`, `archiveAllReviewedFeedback()`, `setNeedsAction(id: string, needsAction: boolean)`.
- Implement `purgeFeedback(id: string, confirm: string)`:
  ```typescript
  if (confirm !== 'PURGE') {
    throw new Error('Typed confirmation PURGE required for permanent deletion.');
  }
  ```
- Implement `purgeAllFeedback(confirm: string)`.
- Update `listFeedback` so view filter `'active'` includes `new`, `open`, `reviewed`, and `'archived'` includes `archived`.

- [ ] **Step 5: Run tests to verify**

Run: `npx jest tests/core/database/models/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/database/models/report-issue.model.ts src/core/database/models/feedback.model.ts tests/core/database/models/
git commit -m "feat(models): implement resolution reasons and feedback archive/purge models"
```

---

### Task 3: Backend Services, Audit Logging & Controllers

**Files:**
- Modify: `src/modules/report/report.service.ts`
- Modify: `src/modules/report/report.controller.ts`
- Modify: `src/modules/feedback/feedback.service.ts`
- Modify: `src/modules/feedback/feedback.controller.ts`
- Modify: `src/modules/admin/admin.service.ts` (or log helper)

**Interfaces:**
- Produces:
  - `POST /api/report-issues`: accepts optional `transactionRef`.
  - `PATCH /api/admin/report-issues/:id/status`: accepts `{ status, resolutionReason?, resolutionNote? }`, validates reason on resolve, logs `report_acknowledged` or `report_resolved` to `admin_logs`.
  - `PATCH /api/admin/feedback/:id/status`: accepts `{ status, needsAction? }` or `{ action: 'archive' }`.
  - `POST /api/admin/feedback/archive-reviewed`: bulk archives reviewed entries.
  - `DELETE /api/admin/feedback/:id` and `DELETE /api/admin/feedback`: checks `{ confirm: 'PURGE' }`.

- [ ] **Step 1: Write integration tests for report status patching and resolution reasons**

Create `tests/modules/report/report-resolution.test.ts`:
- Test submitting report with `transactionRef`.
- Test `PATCH /api/admin/report-issues/:id/status` with `status: 'resolved'` without `resolutionReason` returns 400.
- Test `PATCH /api/admin/report-issues/:id/status` with valid reason returns 200 and logs entry in `admin_logs`.

- [ ] **Step 2: Update `src/modules/report/report.service.ts` & `report.controller.ts`**

- In `report.service.ts`:
  - Pass `transactionRef` through `submitReportIssue` and `submitDirectReportIssue`.
  - In `updateReportStatus`: accept `resolutionReason` and `resolutionNote`.
  - When status updates, call `AdminService.appendLog` or insert into `admin_logs`:
    - `type: 'report_status_change'`
    - Message: `Report ${id} status updated to ${status}${resolutionReason ? ` (${resolutionReason})` : ''}`
- In `report.controller.ts`:
  - Update `patchAdminReportIssueStatus`:
    - Extract `status`, `resolutionReason`, `resolutionNote` from body.
    - If `status === 'resolved'` and `!resolutionReason`, return `400` with `{ error: 'resolutionReason is required when resolving a report.' }`.
    - If `resolutionReason` is provided, validate it against allowed values.

- [ ] **Step 3: Update `src/modules/feedback/feedback.service.ts` & `feedback.controller.ts`**

- In `feedback.controller.ts`:
  - `PATCH /api/admin/feedback/:id/status`:
    - Support toggling `needsAction`.
    - Support marking as `reviewed` (or `new`).
    - Support action `archive`.
  - `POST /api/admin/feedback/archive-reviewed`:
    - Call service method to archive all reviewed items.
  - `DELETE /api/admin/feedback/:id`:
    - Check `req.body?.confirm === 'PURGE'`. If not, return `400` with `{ error: 'Typed confirmation PURGE required.' }`.
  - `DELETE /api/admin/feedback`:
    - Check `req.body?.confirm === 'PURGE'`. If not, return `400` with `{ error: 'Typed confirmation PURGE required.' }`.

- [ ] **Step 4: Run module tests**

Run: `npx jest tests/modules/report/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/report/ src/modules/feedback/ tests/modules/report/
git commit -m "feat(api): add report resolution enforcement, audit logging, and feedback safe delete"
```

---

### Task 4: Kiosk Customer Report Portal Transaction Ref Capture

**Files:**
- Modify: `src/public/report/app.ts`
- Modify: `src/public/report/index.html`

**Interfaces:**
- Consumes: URL query string `?txn=...` or `?transaction_ref=...`.
- Produces: Sends `transactionRef` in POST body to `/api/report-issues/sessions/:sessionId/submit` or direct submission.

- [ ] **Step 1: Update `src/public/report/app.ts`**

- Extract URL param on init:
  ```typescript
  const urlParams = new URLSearchParams(window.location.search);
  const transactionRefFromUrl = urlParams.get('txn') || urlParams.get('transaction_ref') || null;
  ```
- If present, show a subtle banner/badge: `"Linked Transaction: PB-XXXX..."`.
- When building `payload`: include `transactionRef: transactionRefFromUrl`.

- [ ] **Step 2: Commit**

```bash
git add src/public/report/app.ts src/public/report/index.html
git commit -m "feat(report-portal): support transaction ref linking in kiosk submission"
```

---

### Task 5: Admin Report UI Enhancement (`src/public/admin/report`)

**Files:**
- Modify: `src/public/admin/report/app.ts`
- Modify: `src/public/admin/report/index.html`
- Modify: `src/public/admin/report/styles.css`

**Interfaces:**
- Consumes: Extended `ReportIssueEntry` (`transactionRef`, `resolutionReason`, `resolutionNote`, `acknowledgedAt`, `resolvedAt`).
- Produces:
  - List card displays Transaction Ref badge (or "Unlinked").
  - Detail modal displays Transaction link pointing to `/admin/transactions?q=${transactionRef}`.
  - Status timeline component in modal:
    - Submitted: `<timestamp>`
    - Acknowledged: `<timestamp>` (or Pending)
    - Resolved: `<timestamp>` with reason and notes (or Pending)
  - Resolution Dialog when clicking "Mark Resolved":
    - Dropdown: Refunded, Reprinted, Hardware Fix, No Fault Found, Duplicate, User Error, Other.
    - Notes textarea (optional).
    - Confirmation button submits to `PATCH /api/admin/report-issues/:id/status`.

- [ ] **Step 1: Update `src/public/admin/report/index.html`**

Add resolution form modal HTML:
```html
<div id="resolveModal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="resolveModalTitle">
  <div class="modal-card">
    <div class="modal-header">
      <h3 id="resolveModalTitle" class="modal-title">Resolve Report</h3>
      <button id="closeResolveModalBtn" class="modal-close-btn" type="button" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label for="resolutionReasonSelect">Resolution Reason <span class="required">*</span></label>
        <select id="resolutionReasonSelect" class="form-select" required>
          <option value="" disabled selected>Select a reason...</option>
          <option value="refunded">Refunded</option>
          <option value="reprinted">Reprinted</option>
          <option value="hardware_fix">Hardware Fix</option>
          <option value="no_fault_found">No Fault Found</option>
          <option value="duplicate">Duplicate</option>
          <option value="user_error">User Error</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div class="form-group">
        <label for="resolutionNoteInput">Resolution Note (optional)</label>
        <textarea id="resolutionNoteInput" class="form-textarea" rows="3" placeholder="Enter notes or refund details..."></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button id="cancelResolveBtn" class="btn btn-secondary" type="button">Cancel</button>
      <button id="submitResolveBtn" class="btn btn-primary" type="button">Confirm Resolution</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Update `src/public/admin/report/app.ts`**

- Update `renderCard` to display `entry.transactionRef`:
  ```typescript
  const txnBadge = entry.transactionRef
    ? `<span class="badge badge-txn" title="Transaction Ref">${escHtml(entry.transactionRef)}</span>`
    : `<span class="badge badge-muted">Unlinked</span>`;
  ```
- In detail modal:
  - Add link to Transaction Logs:
    ```typescript
    if (issue.transactionRef) {
      txnContainer.innerHTML = `<a href="/admin/transactions?q=${encodeURIComponent(issue.transactionRef)}" class="txn-link" target="_blank">${escHtml(issue.transactionRef)} &nearr;</a>`;
    } else {
      txnContainer.textContent = 'Unlinked';
    }
    ```
  - Render Timeline:
    ```typescript
    timelineContainer.innerHTML = `
      <div class="timeline-step done">
        <div class="timeline-dot"></div>
        <div class="timeline-content">
          <strong>Submitted</strong>: ${formatDate(issue.timestamp)}
        </div>
      </div>
      <div class="timeline-step ${issue.acknowledgedAt ? 'done' : 'pending'}">
        <div class="timeline-dot"></div>
        <div class="timeline-content">
          <strong>Acknowledged</strong>: ${issue.acknowledgedAt ? formatDate(issue.acknowledgedAt) : 'Pending'}
        </div>
      </div>
      <div class="timeline-step ${issue.resolvedAt ? 'done' : 'pending'}">
        <div class="timeline-dot"></div>
        <div class="timeline-content">
          <strong>Resolved</strong>: ${issue.resolvedAt ? formatDate(issue.resolvedAt) : 'Pending'}
          ${issue.resolutionReason ? `<div class="timeline-sub">Reason: ${escHtml(issue.resolutionReason)}${issue.resolutionNote ? ` — ${escHtml(issue.resolutionNote)}` : ''}</div>` : ''}
        </div>
      </div>
    `;
    ```
  - Wire "Mark Resolved" button to open `resolveModal`, validate reason selection, and send `PATCH`.

- [ ] **Step 3: Update `src/public/admin/report/styles.css`**

Add CSS rules for `.badge-txn`, `.timeline-step`, `.timeline-dot`, `.form-select`, `.form-textarea`.

- [ ] **Step 4: Commit**

```bash
git add src/public/admin/report/
git commit -m "feat(admin-report): add transaction ref display, resolution modal, and status timeline"
```

---

### Task 6: Admin Feedback UI Enhancement (`src/public/admin/feedback`)

**Files:**
- Modify: `src/public/admin/feedback/app.ts`
- Modify: `src/public/admin/feedback/index.html`
- Modify: `src/public/admin/feedback/styles.css`

**Interfaces:**
- Consumes: Extended `FeedbackEntry` (`status`, `needsAction`, `archivedAt`, `transactionRef`).
- Produces:
  - Replace row Delete with "Archive".
  - Replace "Clear All" with "Archive Reviewed".
  - "Purge All" action behind a typed confirmation modal requiring typing `"PURGE"`.
  - Status display: New / Reviewed / Archived chips and "Needs Action" toggle badge.

- [ ] **Step 1: Update `src/public/admin/feedback/index.html`**

- Replace `<button id="clearAllBtn">Clear All</button>` with:
  ```html
  <button id="archiveReviewedBtn" class="btn btn-secondary">Archive Reviewed</button>
  <button id="purgeBtn" class="btn btn-danger-outline">Purge...</button>
  ```
- Add Purge confirmation modal:
  ```html
  <div id="purgeModal" class="modal-backdrop hidden" role="dialog" aria-modal="true">
    <div class="modal-card">
      <div class="modal-header">
        <h3 class="modal-title">Confirm Permanent Purge</h3>
        <button id="closePurgeModalBtn" class="modal-close-btn" type="button">&times;</button>
      </div>
      <div class="modal-body">
        <p class="text-danger">This action permanently deletes feedback and cannot be undone.</p>
        <p>Type <strong>PURGE</strong> to confirm:</p>
        <input type="text" id="purgeConfirmInput" class="form-input" placeholder="PURGE" autocomplete="off" />
      </div>
      <div class="modal-footer">
        <button id="cancelPurgeBtn" class="btn btn-secondary" type="button">Cancel</button>
        <button id="confirmPurgeBtn" class="btn btn-danger" type="button" disabled>Permanently Delete</button>
      </div>
    </div>
  </div>
  ```

- [ ] **Step 2: Update `src/public/admin/feedback/app.ts`**

- Update table row rendering:
  - Status chip: `'new'`, `'reviewed'`, `'archived'`.
  - "Needs Action" badge if `entry.needsAction`.
  - Action buttons:
    - If `new`: "Mark Reviewed" button.
    - If `reviewed` and not `archived`: "Archive" button.
    - "Needs Action" toggle button.
- Wire `archiveReviewedBtn`: sends `POST /api/admin/feedback/archive-reviewed`.
- Wire `purgeBtn` & `purgeModal`: enable submit only when input matches `'PURGE'`. On submit, calls `DELETE /api/admin/feedback` with `{ confirm: 'PURGE' }`.

- [ ] **Step 3: Update `src/public/admin/feedback/styles.css`**

Add CSS styles for status chips (`.chip-new`, `.chip-reviewed`, `.chip-archived`, `.badge-action`).

- [ ] **Step 4: Commit**

```bash
git add src/public/admin/feedback/
git commit -m "feat(admin-feedback): add safe archive, needs-action toggle, and purge confirmation modal"
```

---

### Task 7: Build & Full Verification

**Files:**
- Client & Server build files
- Graphify graph update

- [ ] **Step 1: Run client & server build**

Run: `npm run build`
Expected: Successfully compiles client assets and server bundle with zero TypeScript errors.

- [ ] **Step 2: Run test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Update knowledge graph with graphify**

Run: `graphify update .`
Expected: Graph AST update completes successfully.

- [ ] **Step 4: Commit all final changes if any**

```bash
git status
```
