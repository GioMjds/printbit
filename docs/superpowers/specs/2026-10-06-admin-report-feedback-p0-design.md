# Phase P0: Admin Reports & Feedback Enhancement Design

**Date:** 2026-10-06  
**Status:** Approved  
**Scope:** Phase P0 of [ADMIN_ENHANCEMENT.md](../../../ADMIN_ENHANCEMENT.md) (Reports R1-R4, Feedback F1-F3, Database migrations, and Admin UIs).

---

## 1. Overview & Goals

PrintBit kiosk admin console currently has limited report resolution tracking (no transaction links, no resolution reasons, incomplete timeline) and lacks data safety on feedback (hard deletes, destructive Clear All).

Phase P0 delivers:
1. Traceability: Link reports to transaction references (`transaction_ref`).
2. Resolution recording: Require resolution reasons (`resolution_reason`) and optional notes (`resolution_note`).
3. Auditability: Record `acknowledged_at` / `resolved_at` timestamps and log status transitions to System Logs.
4. Feedback safety: Replace hard delete with Archive (`archived_at`), provide bulk "Archive Reviewed", protect permanent deletion with typed confirmation (`"PURGE"`), and migrate feedback statuses (`new` / `reviewed` / `archived`) with `needs_action` support.

---

## 2. Database Schema Migrations (`src/core/database/sqlite-storage.ts`)

Applied non-destructively in `ensureSchema()` using SQLite PRAGMA checks and additive `ALTER TABLE`:

### 2.1 `report_issue_entries`
- `transaction_ref TEXT` (nullable)
- `resolution_reason TEXT` (nullable; enum: `refunded`, `reprinted`, `hardware_fix`, `no_fault_found`, `duplicate`, `user_error`, `other`)
- `resolution_note TEXT` (nullable)
- Index: `CREATE INDEX IF NOT EXISTS idx_report_issue_entries_transaction_ref ON report_issue_entries(transaction_ref);`

### 2.2 `feedback_entries`
- `transaction_ref TEXT` (nullable)
- `needs_action INTEGER NOT NULL DEFAULT 0`
- `archived_at TEXT` (nullable)
- Index: `CREATE INDEX IF NOT EXISTS idx_feedback_entries_archived_at ON feedback_entries(archived_at);`
- Status data migration:
  ```sql
  UPDATE feedback_entries SET status = 'new' WHERE status = 'open';
  UPDATE feedback_entries SET status = 'reviewed' WHERE status = 'resolved';
  ```

---

## 3. Data Model Changes

### 3.1 `src/core/database/models/report-issue.model.ts`
- `ReportResolutionReason = 'refunded' | 'reprinted' | 'hardware_fix' | 'no_fault_found' | 'duplicate' | 'user_error' | 'other'`
- Extend `ReportIssueEntry`:
  - `transactionRef?: string | null`
  - `resolutionReason?: ReportResolutionReason | null`
  - `resolutionNote?: string | null`
- Extend `createReportIssue`: accept optional `transactionRef`.
- Extend `updateReportIssueStatus`:
  - Set `acknowledgedAt` when transitioning to `acknowledged`.
  - When transitioning to `resolved`: require `resolutionReason`, accept optional `resolutionNote`, and set `resolvedAt`.

### 3.2 `src/core/database/models/feedback.model.ts`
- Status type: `FeedbackStatus = 'new' | 'reviewed' | 'archived'` (with compatibility mapping for `'open'` -> `'new'`, `'resolved'` -> `'reviewed'`).
- Extend `FeedbackEntry`:
  - `transactionRef?: string | null`
  - `needsAction: boolean`
  - `archivedAt?: string | null`
- Add functions:
  - `archiveFeedback(id: string)`: sets `archivedAt = new Date().toISOString()`, status = `'archived'`.
  - `archiveAllReviewedFeedback()`: sets `archivedAt` for all entries with status `'reviewed'`.
  - `setNeedsAction(id: string, needsAction: boolean)`: updates `needs_action`.
  - `purgeFeedback(id: string, confirm: string)`: deletes only when `confirm === 'PURGE'`.
  - `purgeAllFeedback(confirm: string)`: deletes only when `confirm === 'PURGE'`.

---

## 4. API Endpoints

### 4.1 Reports
- `POST /api/report-issues` & `/api/report-issues/sessions/:sessionId/submit`:
  - Accepts optional `transactionRef`.
- `PATCH /api/admin/report-issues/:id/status`:
  - Status `acknowledged`: records `acknowledgedAt`, logs to `admin_logs` (`report_acknowledged`).
  - Status `resolved`: requires valid `resolutionReason`, optional `resolutionNote`, records `resolvedAt`, logs to `admin_logs` (`report_resolved`).
- `GET /api/admin/report-issues/:id`: returns `transactionRef`, `resolutionReason`, `resolutionNote`, `acknowledgedAt`, `resolvedAt`.

### 4.2 Feedback
- `PATCH /api/admin/feedback/:id/status`:
  - Accepts `status: 'reviewed' | 'new'`, `needsAction?: boolean`, or `action: 'archive'`.
- `POST /api/admin/feedback/archive-reviewed`:
  - Bulk-archives all reviewed entries.
- `DELETE /api/admin/feedback/:id`:
  - Requires body `{ confirm: 'PURGE' }` for permanent deletion.
- `DELETE /api/admin/feedback`:
  - Requires body `{ confirm: 'PURGE' }` for bulk purge.

---

## 5. UI Implementation

### 5.1 Admin Reports (`src/public/admin/report`)
- List item shows `Transaction: PB-...` or `Unlinked`.
- Detail modal:
  - Displays `Transaction Ref` with link to `/admin/transactions?q=...`.
  - Displays timeline: Submitted -> Acknowledged -> Resolved (with timestamp and reason/note).
  - "Mark Resolved" button opens resolution form modal:
    - Mandatory reason select (`Refunded`, `Reprinted`, `Hardware Fix`, `No Fault Found`, `Duplicate`, `User Error`, `Other`).
    - Optional notes textarea.
    - Submit calls status update API.

### 5.2 Admin Feedback (`src/public/admin/feedback`)
- Row actions:
  - "Mark Reviewed" button (replaces "Mark Resolved").
  - "Archive" button (replaces row Delete).
  - "Needs Action" toggle/chip.
- Header actions:
  - "Archive Reviewed" button (replaces "Clear All").
  - "Purge Feedback" button: triggers confirmation modal requiring admin to type `"PURGE"` to permanently delete.
- Status chips: `New` (accent/attention), `Reviewed` (neutral), `Archived` (muted).

### 5.3 Kiosk Report (`src/public/report`)
- Checks URL search params (`?txn=` or `?transaction_ref=`).
- When present, passes `transactionRef` during report submission.

---

## 6. Verification & Testing Plan
- Test SQLite migrations with in-memory or test SQLite database.
- Unit/integration test for `report.service.ts`:
  - Resolving without a reason is rejected with 400.
  - Resolving with a valid reason records timestamps and resolution details.
  - Status change appends to `admin_logs`.
- Unit/integration test for `feedback.service.ts`:
  - Safe archive sets `archived_at` and status `archived`.
  - Purge without `"PURGE"` is rejected.
  - Purge with `"PURGE"` successfully deletes.
- Build test: `npm run build` passes with zero TypeScript errors.
- Visual/manual test: UI interactions render correctly and state changes update appropriately.
