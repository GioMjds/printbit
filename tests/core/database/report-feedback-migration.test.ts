import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '@/core/database/sqlite-storage';

describe('Report and Feedback Schema Migration', () => {
  it('adds missing columns, creates indexes, and migrates row statuses on existing legacy tables', () => {
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

    // Verify before migration
    const reportColsBefore = new Set(
      (db.prepare('PRAGMA table_info(report_issue_entries)').all() as any[]).map((r) => r.name)
    );
    expect(reportColsBefore.has('transaction_ref')).toBe(false);
    expect(reportColsBefore.has('resolution_reason')).toBe(false);
    expect(reportColsBefore.has('resolution_note')).toBe(false);

    const feedbackColsBefore = new Set(
      (db.prepare('PRAGMA table_info(feedback_entries)').all() as any[]).map((r) => r.name)
    );
    expect(feedbackColsBefore.has('transaction_ref')).toBe(false);
    expect(feedbackColsBefore.has('needs_action')).toBe(false);
    expect(feedbackColsBefore.has('archived_at')).toBe(false);

    // Call production ensureSchema
    ensureSchema(db);

    // Verify report_issue_entries columns
    const reportColsAfter = new Set(
      (db.prepare('PRAGMA table_info(report_issue_entries)').all() as any[]).map((r) => r.name)
    );
    expect(reportColsAfter.has('transaction_ref')).toBe(true);
    expect(reportColsAfter.has('resolution_reason')).toBe(true);
    expect(reportColsAfter.has('resolution_note')).toBe(true);

    // Verify feedback_entries columns
    const feedbackColsAfter = new Set(
      (db.prepare('PRAGMA table_info(feedback_entries)').all() as any[]).map((r) => r.name)
    );
    expect(feedbackColsAfter.has('transaction_ref')).toBe(true);
    expect(feedbackColsAfter.has('needs_action')).toBe(true);
    expect(feedbackColsAfter.has('archived_at')).toBe(true);

    // Verify feedback row status updates: open -> new, resolved -> reviewed
    const f1 = db.prepare("SELECT status, needs_action FROM feedback_entries WHERE id = 'f1'").get() as any;
    expect(f1.status).toBe('new');
    expect(f1.needs_action).toBe(0);

    const f2 = db.prepare("SELECT status FROM feedback_entries WHERE id = 'f2'").get() as any;
    expect(f2.status).toBe('reviewed');

    // Verify indexes exist
    const reportIndexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'report_issue_entries'").all() as any[]
    ).map((r) => r.name);
    expect(reportIndexes).toContain('idx_report_issue_entries_transaction_ref');

    const feedbackIndexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'feedback_entries'").all() as any[]
    ).map((r) => r.name);
    expect(feedbackIndexes).toContain('idx_feedback_entries_archived_at');

    // Verify migration idempotency by calling ensureSchema a second time
    expect(() => ensureSchema(db)).not.toThrow();

    const f1Again = db.prepare("SELECT status FROM feedback_entries WHERE id = 'f1'").get() as any;
    expect(f1Again.status).toBe('new');
    const f2Again = db.prepare("SELECT status FROM feedback_entries WHERE id = 'f2'").get() as any;
    expect(f2Again.status).toBe('reviewed');
  });

  it('creates fresh empty in-memory DB with all new columns and indexes via ensureSchema', () => {
    const db = new DatabaseSync(':memory:');
    ensureSchema(db);

    const reportCols = new Set(
      (db.prepare('PRAGMA table_info(report_issue_entries)').all() as any[]).map((r) => r.name)
    );
    expect(reportCols.has('transaction_ref')).toBe(true);
    expect(reportCols.has('resolution_reason')).toBe(true);
    expect(reportCols.has('resolution_note')).toBe(true);

    const feedbackCols = new Set(
      (db.prepare('PRAGMA table_info(feedback_entries)').all() as any[]).map((r) => r.name)
    );
    expect(feedbackCols.has('transaction_ref')).toBe(true);
    expect(feedbackCols.has('needs_action')).toBe(true);
    expect(feedbackCols.has('archived_at')).toBe(true);

    const reportIndexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'report_issue_entries'").all() as any[]
    ).map((r) => r.name);
    expect(reportIndexes).toContain('idx_report_issue_entries_transaction_ref');

    const feedbackIndexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'feedback_entries'").all() as any[]
    ).map((r) => r.name);
    expect(feedbackIndexes).toContain('idx_feedback_entries_archived_at');
  });
});
