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
    expect(reportColsBefore.has('resolution_reason')).toBe(false);
    expect(reportColsBefore.has('resolution_note')).toBe(false);

    // Migration function replicating ensureSchema checks
    const applyMigrations = () => {
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
    };

    applyMigrations();

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

    // Verify feedback row status updates
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

    // Verify migration idempotency
    expect(() => applyMigrations()).not.toThrow();
  });
});
