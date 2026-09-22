import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AdminLogEntry,
  FeedbackEntry,
  FeedbackSessionEntry,
  ReceiptAccessTokenEntry,
  ReceiptRecordEntry,
  ReportIssueAttachmentEntry,
  ReportIssueEntry,
  ReportIssueSessionEntry,
} from './db';

const SQLITE_FILE_PATH = path.resolve('printbit.sqlite');
const LOWDB_IMPORT_META_KEY = 'lowdb_import_v1';
const SCHEMA_SNAPSHOT_META_KEY = 'schema_snapshot_v1';
const RUNTIME_STATE_ROW_ID = 1;
let sqliteDb: DatabaseSync | null = null;

export interface LowDbImportSnapshot {
  logs: AdminLogEntry[];
  feedback: FeedbackEntry[];
  feedbackSessions: FeedbackSessionEntry[];
  reportIssues: ReportIssueEntry[];
  reportIssueSessions: ReportIssueSessionEntry[];
  reportIssueAttachments: ReportIssueAttachmentEntry[];
  receiptRecords: ReceiptRecordEntry[];
  receiptAccessTokens: ReceiptAccessTokenEntry[];
}

export interface LowDbImportOptions {
  force?: boolean;
}

export interface LowDbImportResult {
  skipped: boolean;
  attempted: {
    receiptRecords: number;
    receiptAccessTokens: number;
    feedbackSessions: number;
    feedback: number;
    reportIssueSessions: number;
    reportIssues: number;
    reportIssueAttachments: number;
    logs: number;
  };
  inserted: {
    receiptRecords: number;
    receiptAccessTokens: number;
    feedbackSessions: number;
    feedback: number;
    reportIssueSessions: number;
    reportIssues: number;
    reportIssueAttachments: number;
    logs: number;
  };
  skippedOrphans: {
    receiptAccessTokens: number;
    feedback: number;
    reportIssues: number;
    reportIssueAttachments: number;
  };
}

function toIsoDate(value: Date): string {
  return value.toISOString();
}

export function withTransaction<T>(handler: () => T): T {
  const db = getSqliteDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = handler();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('[SQLITE] Failed to rollback transaction.', {
        error:
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
      });
    }
    throw error;
  }
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function changesFromRun(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const candidate = result as { changes?: unknown };
  return typeof candidate.changes === 'number' ? candidate.changes : 0;
}

function openSqliteDatabase(): DatabaseSync {
  const db = new DatabaseSync(SQLITE_FILE_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

function ensureSchema(db: DatabaseSync): void {
  const appliedMigrations: string[] = [];
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wireless_sessions (
      session_id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      owner_client_id TEXT,
      owner_claimed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wireless_sessions_last_activity
      ON wireless_sessions(last_activity_at DESC);

    CREATE TABLE IF NOT EXISTS wireless_session_documents (
      document_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL,
      file_path TEXT NOT NULL,
      converted_pdf_path TEXT,
      content_hash TEXT,
      analysis_json TEXT,
      analysis_status TEXT NOT NULL DEFAULT 'pending',
      analysis_error TEXT,
      analysis_requested_at TEXT,
      FOREIGN KEY(session_id) REFERENCES wireless_sessions(session_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_wireless_session_documents_session_id
      ON wireless_session_documents(session_id);

    CREATE TABLE IF NOT EXISTS admin_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      timestamp_meta_json TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_admin_logs_timestamp
      ON admin_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_logs_type
      ON admin_logs(type);
    CREATE INDEX IF NOT EXISTS idx_admin_logs_type_timestamp
      ON admin_logs(type, timestamp DESC);

    CREATE TABLE IF NOT EXISTS print_jobs (
      job_id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_print_jobs_transaction_id
      ON print_jobs(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_state
      ON print_jobs(state);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_created_at
      ON print_jobs(created_at DESC);

    CREATE TABLE IF NOT EXISTS feedback_sessions (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      feedback_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      submitted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_sessions_token
      ON feedback_sessions(token);
    CREATE INDEX IF NOT EXISTS idx_feedback_sessions_expires_at
      ON feedback_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS feedback_entries (
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
    CREATE INDEX IF NOT EXISTS idx_feedback_entries_timestamp
      ON feedback_entries(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_entries_status
      ON feedback_entries(status);
    CREATE INDEX IF NOT EXISTS idx_feedback_entries_session_id
      ON feedback_entries(session_id);

    CREATE TABLE IF NOT EXISTS report_issue_sessions (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      report_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      submitted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_report_issue_sessions_token
      ON report_issue_sessions(token);
    CREATE INDEX IF NOT EXISTS idx_report_issue_sessions_expires_at
      ON report_issue_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS report_issue_entries (
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
    CREATE INDEX IF NOT EXISTS idx_report_issue_entries_timestamp
      ON report_issue_entries(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_report_issue_entries_status
      ON report_issue_entries(status);
    CREATE INDEX IF NOT EXISTS idx_report_issue_entries_category
      ON report_issue_entries(category);
    CREATE INDEX IF NOT EXISTS idx_report_issue_entries_session_id
      ON report_issue_entries(session_id);

    CREATE TABLE IF NOT EXISTS report_issue_attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      report_issue_id TEXT,
      timestamp TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      FOREIGN KEY(report_issue_id) REFERENCES report_issue_entries(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_issue_attachments_session_id
      ON report_issue_attachments(session_id);
    CREATE INDEX IF NOT EXISTS idx_report_issue_attachments_report_issue_id
      ON report_issue_attachments(report_issue_id);
    CREATE INDEX IF NOT EXISTS idx_report_issue_attachments_timestamp
      ON report_issue_attachments(timestamp DESC);

    CREATE TABLE IF NOT EXISTS receipt_records (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('print', 'copy')),
      charged_amount INTEGER NOT NULL,
      color_pages INTEGER,
      bw_pages INTEGER,
      status TEXT NOT NULL CHECK (
        status IN (
          'settled_pending_terminal',
          'printed',
          'failed',
          'refunded',
          'refunded_pending_review'
        )
      ),
      change_requested INTEGER NOT NULL DEFAULT 0,
      change_dispensed INTEGER NOT NULL DEFAULT 0,
      change_state TEXT NOT NULL DEFAULT 'none' CHECK (
        change_state IN ('none', 'dispensed', 'failed')
      ),
      change_attempts INTEGER NOT NULL DEFAULT 0,
      change_owed_id TEXT,
      change_message TEXT,
      details_json TEXT,
      settled_at TEXT,
      terminal_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_receipt_records_expires_at
      ON receipt_records(expires_at);
    CREATE INDEX IF NOT EXISTS idx_receipt_records_status
      ON receipt_records(status);
    CREATE INDEX IF NOT EXISTS idx_receipt_records_created_at
      ON receipt_records(created_at DESC);

    CREATE TABLE IF NOT EXISTS receipt_access_tokens (
      id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY(receipt_id) REFERENCES receipt_records(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_receipt_access_tokens_receipt_id
      ON receipt_access_tokens(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_receipt_access_tokens_expires_at
      ON receipt_access_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_receipt_access_tokens_revoked_at
      ON receipt_access_tokens(revoked_at);

    CREATE TABLE IF NOT EXISTS consumable_usage_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      copies INTEGER NOT NULL,
      duplex INTEGER NOT NULL,
      selected_pages INTEGER NOT NULL,
      billable_color_pages INTEGER NOT NULL,
      billable_bw_pages INTEGER NOT NULL,
      estimated_sheets_used INTEGER NOT NULL,
      estimated_ink_units_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL,
      billing_page_detection TEXT NOT NULL DEFAULT 'fallback-assumptions',
      analysis_confidence TEXT NOT NULL DEFAULT 'unknown'
    );
    CREATE INDEX IF NOT EXISTS idx_consumable_usage_events_timestamp
      ON consumable_usage_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_consumable_usage_events_transaction_id
      ON consumable_usage_events(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_consumable_usage_events_mode
      ON consumable_usage_events(mode);

    CREATE TABLE IF NOT EXISTS consumable_ink_snapshots (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      printer_name TEXT,
      ink_detection_method TEXT NOT NULL,
      ink_telemetry_available INTEGER NOT NULL,
      ink_telemetry_reason TEXT,
      supplies_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_consumable_ink_snapshots_timestamp
      ON consumable_ink_snapshots(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_consumable_ink_snapshots_printer_name
      ON consumable_ink_snapshots(printer_name);

    CREATE TABLE IF NOT EXISTS pricing_analysis_cache (
      file_hash TEXT NOT NULL,
      config_fingerprint TEXT NOT NULL,
      content_type TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      analysis_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(file_hash, config_fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_analysis_cache_updated_at
      ON pricing_analysis_cache(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pricing_analysis_cache_config_fingerprint
      ON pricing_analysis_cache(config_fingerprint);

    CREATE TABLE IF NOT EXISTS power_safety_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      power_source_instance_id TEXT,
      power_sequence INTEGER,
      status_json TEXT,
      operational_state TEXT,
      accepting_transactions INTEGER,
      source_timestamp_utc TEXT,
      received_timestamp_utc TEXT
    );
  `);

  const wirelessDocumentColumnRows = db
    .prepare('PRAGMA table_info(wireless_session_documents)')
    .all() as Array<Record<string, unknown>>;
  const wirelessDocumentColumns = new Set(
    wirelessDocumentColumnRows
      .map((row) => (typeof row.name === 'string' ? row.name : ''))
      .filter((name) => name.length > 0),
  );
  if (!wirelessDocumentColumns.has('analysis_status')) {
    db.exec(
      "ALTER TABLE wireless_session_documents ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'pending'",
    );
    appliedMigrations.push('wireless_session_documents.analysis_status');
  }
  if (!wirelessDocumentColumns.has('analysis_error')) {
    db.exec(
      'ALTER TABLE wireless_session_documents ADD COLUMN analysis_error TEXT',
    );
    appliedMigrations.push('wireless_session_documents.analysis_error');
  }
  if (!wirelessDocumentColumns.has('analysis_requested_at')) {
    db.exec(
      'ALTER TABLE wireless_session_documents ADD COLUMN analysis_requested_at TEXT',
    );
    appliedMigrations.push('wireless_session_documents.analysis_requested_at');
  }
  if (!wirelessDocumentColumns.has('converted_pdf_path')) {
    db.exec(
      'ALTER TABLE wireless_session_documents ADD COLUMN converted_pdf_path TEXT',
    );
    appliedMigrations.push('wireless_session_documents.converted_pdf_path');
  }
  if (!wirelessDocumentColumns.has('content_hash')) {
    db.exec(
      'ALTER TABLE wireless_session_documents ADD COLUMN content_hash TEXT',
    );
    appliedMigrations.push('wireless_session_documents.content_hash');
  }
  addAnalysisVersionColumnIfMissing(
    db,
    wirelessDocumentColumns,
    appliedMigrations,
  );

  const receiptColumnRows = db
    .prepare('PRAGMA table_info(receipt_records)')
    .all() as Array<Record<string, unknown>>;
  const receiptColumns = new Set(
    receiptColumnRows
      .map((row) => (typeof row.name === 'string' ? row.name : ''))
      .filter((name) => name.length > 0),
  );

  if (!receiptColumns.has('change_requested')) {
    db.exec(
      'ALTER TABLE receipt_records ADD COLUMN change_requested INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!receiptColumns.has('change_dispensed')) {
    db.exec(
      'ALTER TABLE receipt_records ADD COLUMN change_dispensed INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!receiptColumns.has('change_state')) {
    db.exec(
      "ALTER TABLE receipt_records ADD COLUMN change_state TEXT NOT NULL DEFAULT 'none'",
    );
  }
  if (!receiptColumns.has('change_attempts')) {
    db.exec(
      'ALTER TABLE receipt_records ADD COLUMN change_attempts INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!receiptColumns.has('change_owed_id')) {
    db.exec('ALTER TABLE receipt_records ADD COLUMN change_owed_id TEXT');
  }
  if (!receiptColumns.has('change_message')) {
    db.exec('ALTER TABLE receipt_records ADD COLUMN change_message TEXT');
  }
  if (!receiptColumns.has('color_pages')) {
    db.exec('ALTER TABLE receipt_records ADD COLUMN color_pages INTEGER');
  }
  if (!receiptColumns.has('bw_pages')) {
    db.exec('ALTER TABLE receipt_records ADD COLUMN bw_pages INTEGER');
  }
  if (!receiptColumns.has('details_json')) {
    db.exec('ALTER TABLE receipt_records ADD COLUMN details_json TEXT');
    appliedMigrations.push('receipt_records.details_json');
  }

  const consumablesUsageColumnRows = db
    .prepare('PRAGMA table_info(consumable_usage_events)')
    .all() as Array<Record<string, unknown>>;
  const consumablesUsageColumns = new Set(
    consumablesUsageColumnRows
      .map((row) => (typeof row.name === 'string' ? row.name : ''))
      .filter((name) => name.length > 0),
  );
  if (!consumablesUsageColumns.has('billing_page_detection')) {
    db.exec(
      "ALTER TABLE consumable_usage_events ADD COLUMN billing_page_detection TEXT NOT NULL DEFAULT 'fallback-assumptions'",
    );
  }
  if (!consumablesUsageColumns.has('analysis_confidence')) {
    db.exec(
      "ALTER TABLE consumable_usage_events ADD COLUMN analysis_confidence TEXT NOT NULL DEFAULT 'unknown'",
    );
  }

  const consumableUsageColumnRows = db
    .prepare('PRAGMA table_info(consumable_usage_events)')
    .all() as Array<Record<string, unknown>>;
  const consumableUsageColumns = new Set(
    consumableUsageColumnRows
      .map((row) => (typeof row.name === 'string' ? row.name : ''))
      .filter((name) => name.length > 0),
  );
  if (!consumableUsageColumns.has('estimated_ink_units_json')) {
    db.exec(
      "ALTER TABLE consumable_usage_events ADD COLUMN estimated_ink_units_json TEXT NOT NULL DEFAULT '{}'",
    );
  }

  // Ensure consumable_ink_snapshots exists for DBs that missed schema creation
  const inkSnapshotColumnRows = db
    .prepare('PRAGMA table_info(consumable_ink_snapshots)')
    .all() as Array<Record<string, unknown>>;
  if (inkSnapshotColumnRows.length === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS consumable_ink_snapshots (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        printer_name TEXT,
        ink_detection_method TEXT NOT NULL,
        ink_telemetry_available INTEGER NOT NULL,
        ink_telemetry_reason TEXT,
        supplies_json TEXT NOT NULL
      );
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_consumable_ink_snapshots_timestamp ON consumable_ink_snapshots(timestamp DESC)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_consumable_ink_snapshots_printer_name ON consumable_ink_snapshots(printer_name)',
    );
  }

  const pricingCacheColumnRows = db
    .prepare('PRAGMA table_info(pricing_analysis_cache)')
    .all() as Array<Record<string, unknown>>;
  const pricingCacheColumns = new Set(
    pricingCacheColumnRows
      .map((row) => (typeof row.name === 'string' ? row.name : ''))
      .filter((name) => name.length > 0),
  );
  if (!pricingCacheColumns.has('algorithm_version')) {
    db.exec(
      'ALTER TABLE pricing_analysis_cache ADD COLUMN algorithm_version INTEGER NOT NULL DEFAULT 0',
    );
    appliedMigrations.push('pricing_analysis_cache.algorithm_version');
  }

  if (appliedMigrations.length > 0) {
    console.info(
      `[SQLITE] Schema migrations applied during startup before session uploads are accepted: ${appliedMigrations.join(', ')}`,
    );
  } else {
    console.info(
      '[SQLITE] Schema migrations not needed at startup; wireless_session_documents analysis columns already present.',
    );
  }
}

function addAnalysisVersionColumnIfMissing(
  db: DatabaseSync,
  wirelessDocumentColumns: Set<string>,
  appliedMigrations: string[],
): void {
  if (!wirelessDocumentColumns.has('analysis_version')) {
    db.exec(
      'ALTER TABLE wireless_session_documents ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 0',
    );
    appliedMigrations.push('wireless_session_documents.analysis_version');
  }
}

function getMetaValue(key: string): string | null {
  const db = getSqliteDb();
  const row = db
    .prepare('SELECT value FROM storage_meta WHERE key = ? LIMIT 1')
    .get(key) as { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

function setMetaValue(key: string, value: string): void {
  const db = getSqliteDb();
  db.prepare(
    `INSERT INTO storage_meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(key, value, toIsoDate(new Date()));
}

export function getSqliteFilePath(): string {
  return SQLITE_FILE_PATH;
}

export function initSqliteStorage(): void {
  if (sqliteDb) return;
  sqliteDb = openSqliteDatabase();
  ensureSchema(sqliteDb);
}

export function readSchemaSnapshot<T>(): T | null {
  const raw = getMetaValue(SCHEMA_SNAPSHOT_META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeSchemaSnapshot(snapshot: unknown): void {
  setMetaValue(SCHEMA_SNAPSHOT_META_KEY, JSON.stringify(snapshot));
}

export function readRuntimeState<T>(): T | null {
  const row = getSqliteDb()
    .prepare(
      `SELECT payload_json
       FROM runtime_state
       WHERE id = ?`,
    )
    .get(RUNTIME_STATE_ROW_ID) as { payload_json?: unknown } | undefined;

  if (typeof row?.payload_json !== 'string' || row.payload_json.length === 0) {
    return null;
  }

  try {
    return JSON.parse(row.payload_json) as T;
  } catch {
    return null;
  }
}

export function writeRuntimeState(state: unknown): void {
  getSqliteDb()
    .prepare(
      `INSERT INTO runtime_state (id, payload_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
    )
    .run(RUNTIME_STATE_ROW_ID, JSON.stringify(state), toIsoDate(new Date()));
}

export function migrateSchemaSnapshotToRuntimeState(): boolean {
  const existingRuntimeState = readRuntimeState<unknown>();
  if (existingRuntimeState !== null) return false;

  const legacySnapshot = readSchemaSnapshot<unknown>();
  if (legacySnapshot === null) return false;

  writeRuntimeState(legacySnapshot);
  return true;
}

export function clearLowDbImportMarker(): void {
  getSqliteDb()
    .prepare('DELETE FROM storage_meta WHERE key = ?')
    .run(LOWDB_IMPORT_META_KEY);
}

export function getSqliteDb(): DatabaseSync {
  if (!sqliteDb) initSqliteStorage();
  if (!sqliteDb) {
    throw new Error('SQLite database is not initialized.');
  }
  return sqliteDb;
}

export {
  type WirelessSessionStorageEntry,
  type WirelessSessionDocumentStorageEntry,
  type WirelessSessionSnapshotStorageEntry,
  WirelessSessionSqliteStore,
  wirelessSessionStore,
} from './models/wireless-session.model';

export {
  type PricingAnalysisCacheEntry,
  PricingAnalysisCacheSqliteStore,
  pricingAnalysisCacheStore,
} from './models/pricing-analysis-cache.model';

export {
  type ReceiptTokenLookupResult,
  type ListReceiptOptions,
  ReceiptSqliteStore,
  receiptStore,
} from './models/receipt.model';

export {
  ConsumablesSqliteStore,
  ADMIN_TEST_PAGE_USAGE_SOURCE,
  consumablesStore,
  type ConsumableUsageEventEntry,
  type ConsumableInkSnapshotSupply,
  type ConsumableInkSnapshotEntry,
} from './models/consumables.model';

export { PrintJobSqliteStore, printJobStore } from './models/print-job.model';

export {
  FeedbackSqliteStore,
  feedbackStore,
  type ListFeedbackOptions,
} from './models/feedback.model';

export {
  ReportIssueSqliteStore,
  reportIssueStore,
  type ListReportIssueOptions,
} from './models/report-issue.model';

export { AdminLogSqliteStore, adminLogStore } from './models/admin.model';
export {
  PowerSafetySqliteStore,
  powerSafetyStore,
  type PowerSafetyStateRecord,
} from './power-safety-store';

export function importLowDbSnapshotIfNeeded(
  snapshot: LowDbImportSnapshot,
  options: LowDbImportOptions = {},
): LowDbImportResult {
  initSqliteStorage();
  const hasCandidates =
    snapshot.receiptRecords.length > 0 ||
    snapshot.receiptAccessTokens.length > 0 ||
    snapshot.feedbackSessions.length > 0 ||
    snapshot.feedback.length > 0 ||
    snapshot.reportIssueSessions.length > 0 ||
    snapshot.reportIssues.length > 0 ||
    snapshot.reportIssueAttachments.length > 0 ||
    snapshot.logs.length > 0;
  if (!hasCandidates) {
    return {
      skipped: true,
      attempted: {
        receiptRecords: 0,
        receiptAccessTokens: 0,
        feedbackSessions: 0,
        feedback: 0,
        reportIssueSessions: 0,
        reportIssues: 0,
        reportIssueAttachments: 0,
        logs: 0,
      },
      inserted: {
        receiptRecords: 0,
        receiptAccessTokens: 0,
        feedbackSessions: 0,
        feedback: 0,
        reportIssueSessions: 0,
        reportIssues: 0,
        reportIssueAttachments: 0,
        logs: 0,
      },
      skippedOrphans: {
        receiptAccessTokens: 0,
        feedback: 0,
        reportIssues: 0,
        reportIssueAttachments: 0,
      },
    };
  }

  const existing = getMetaValue(LOWDB_IMPORT_META_KEY);
  if (existing === 'done' && !options.force) {
    return {
      skipped: true,
      attempted: {
        receiptRecords: 0,
        receiptAccessTokens: 0,
        feedbackSessions: 0,
        feedback: 0,
        reportIssueSessions: 0,
        reportIssues: 0,
        reportIssueAttachments: 0,
        logs: 0,
      },
      inserted: {
        receiptRecords: 0,
        receiptAccessTokens: 0,
        feedbackSessions: 0,
        feedback: 0,
        reportIssueSessions: 0,
        reportIssues: 0,
        reportIssueAttachments: 0,
        logs: 0,
      },
      skippedOrphans: {
        receiptAccessTokens: 0,
        feedback: 0,
        reportIssues: 0,
        reportIssueAttachments: 0,
      },
    };
  }

  const attempted: LowDbImportResult['attempted'] = {
    receiptRecords: 0,
    receiptAccessTokens: 0,
    feedbackSessions: 0,
    feedback: 0,
    reportIssueSessions: 0,
    reportIssues: 0,
    reportIssueAttachments: 0,
    logs: 0,
  };
  const inserted: LowDbImportResult['inserted'] = {
    receiptRecords: 0,
    receiptAccessTokens: 0,
    feedbackSessions: 0,
    feedback: 0,
    reportIssueSessions: 0,
    reportIssues: 0,
    reportIssueAttachments: 0,
    logs: 0,
  };
  const skippedOrphans: LowDbImportResult['skippedOrphans'] = {
    receiptAccessTokens: 0,
    feedback: 0,
    reportIssues: 0,
    reportIssueAttachments: 0,
  };

  withTransaction(() => {
    const db = getSqliteDb();
    const receiptExistsStmt = db.prepare(
      'SELECT id FROM receipt_records WHERE id = ? LIMIT 1',
    );

    for (const receipt of snapshot.receiptRecords) {
      attempted.receiptRecords += 1;
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO receipt_records (
            id,
            transaction_id,
            mode,
            charged_amount,
            status,
            change_requested,
            change_dispensed,
            change_state,
            change_attempts,
            change_owed_id,
            change_message,
            details_json,
            settled_at,
            terminal_at,
            created_at,
            updated_at,
            expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.id,
          receipt.transactionId,
          receipt.mode,
          receipt.chargedAmount,
          receipt.status,
          receipt.change.requested,
          receipt.change.dispensed,
          receipt.change.state,
          receipt.change.attempts,
          receipt.change.owedChangeId,
          receipt.change.message,
          receipt.details ? JSON.stringify(receipt.details) : null,
          receipt.settledAt,
          receipt.terminalAt,
          receipt.createdAt,
          receipt.updatedAt,
          receipt.expiresAt,
        );
      inserted.receiptRecords += changesFromRun(result);
    }

    for (const token of snapshot.receiptAccessTokens) {
      attempted.receiptAccessTokens += 1;
      const parent = receiptExistsStmt.get(token.receiptId) as
        | Record<string, unknown>
        | undefined;
      if (!parent) {
        skippedOrphans.receiptAccessTokens += 1;
        continue;
      }
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO receipt_access_tokens (
            id,
            receipt_id,
            token_hash,
            created_at,
            expires_at,
            revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          token.id,
          token.receiptId,
          token.tokenHash,
          token.createdAt,
          token.expiresAt,
          token.revokedAt,
        );
      inserted.receiptAccessTokens += changesFromRun(result);
    }

    const feedbackSessionIds = new Set<string>();
    for (const session of snapshot.feedbackSessions) {
      attempted.feedbackSessions += 1;
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO feedback_sessions (
          id,
          token,
          feedback_url,
          created_at,
          expires_at,
          submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.token,
          session.feedbackUrl,
          session.createdAt,
          session.expiresAt,
          session.submittedAt,
        );
      inserted.feedbackSessions += changesFromRun(result);
      feedbackSessionIds.add(session.id);
    }

    for (const entry of snapshot.feedback) {
      attempted.feedback += 1;
      if (!feedbackSessionIds.has(entry.sessionId)) {
        skippedOrphans.feedback += 1;
        continue;
      }
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO feedback_entries (
          id,
          session_id,
          timestamp,
          comment,
          category,
          rating,
          status,
          resolved_at,
          meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.sessionId,
          entry.timestamp,
          entry.comment,
          entry.category,
          entry.rating,
          entry.status,
          entry.resolvedAt ?? null,
          jsonOrNull(entry.meta),
        );
      inserted.feedback += changesFromRun(result);
    }

    const reportSessionIds = new Set<string>();
    for (const session of snapshot.reportIssueSessions) {
      attempted.reportIssueSessions += 1;
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO report_issue_sessions (
          id,
          token,
          report_url,
          created_at,
          expires_at,
          submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.token,
          session.reportUrl,
          session.createdAt,
          session.expiresAt,
          session.submittedAt,
        );
      inserted.reportIssueSessions += changesFromRun(result);
      reportSessionIds.add(session.id);
    }

    const reportIssueIds = new Set<string>();
    for (const issue of snapshot.reportIssues) {
      attempted.reportIssues += 1;
      if (!reportSessionIds.has(issue.sessionId)) {
        skippedOrphans.reportIssues += 1;
        continue;
      }
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO report_issue_entries (
          id,
          session_id,
          timestamp,
          title,
          description,
          category,
          status,
          attachment_ids_json,
          acknowledged_at,
          resolved_at,
          meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          issue.id,
          issue.sessionId,
          issue.timestamp,
          issue.title,
          issue.description,
          issue.category,
          issue.status,
          JSON.stringify(issue.attachmentIds),
          issue.acknowledgedAt,
          issue.resolvedAt,
          jsonOrNull(issue.meta),
        );
      inserted.reportIssues += changesFromRun(result);
      reportIssueIds.add(issue.id);
    }

    for (const attachment of snapshot.reportIssueAttachments) {
      attempted.reportIssueAttachments += 1;
      if (!reportSessionIds.has(attachment.sessionId)) {
        skippedOrphans.reportIssueAttachments += 1;
        continue;
      }
      const reportIssueId =
        attachment.reportIssueId && reportIssueIds.has(attachment.reportIssueId)
          ? attachment.reportIssueId
          : null;
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO report_issue_attachments (
          id,
          session_id,
          report_issue_id,
          timestamp,
          original_name,
          stored_name,
          content_type,
          size_bytes,
          file_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attachment.id,
          attachment.sessionId,
          reportIssueId,
          attachment.timestamp,
          attachment.originalName,
          attachment.storedName,
          attachment.contentType,
          attachment.sizeBytes,
          attachment.filePath,
        );
      inserted.reportIssueAttachments += changesFromRun(result);
    }

    for (const log of snapshot.logs) {
      attempted.logs += 1;
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO admin_logs (
          id,
          timestamp,
          timestamp_meta_json,
          type,
          message,
          meta_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          log.id,
          log.timestamp,
          jsonOrNull(log.timestampMeta),
          log.type,
          log.message,
          jsonOrNull(log.meta),
        );
      inserted.logs += changesFromRun(result);
    }

    setMetaValue(LOWDB_IMPORT_META_KEY, 'done');
  });

  return {
    skipped: false,
    attempted,
    inserted,
    skippedOrphans,
  };
}

export function clearStalePricingAnalysisCache(currentVersion: number): number {
  const db = getSqliteDb();
  const columns = db
    .prepare('PRAGMA table_info(pricing_analysis_cache)')
    .all() as Array<Record<string, unknown>>;
  const hasVersion = columns.some(
    (col) => typeof col.name === 'string' && col.name === 'algorithm_version',
  );
  if (!hasVersion) return 0;
  const result = db
    .prepare('DELETE FROM pricing_analysis_cache WHERE algorithm_version < ?')
    .run(currentVersion) as { changes?: unknown };
  const deleted = Number(result.changes ?? 0);
  if (deleted > 0) {
    console.log(
      `[PRICING CACHE] Invalidated ${deleted} stale cache entries (algorithm_version < ${currentVersion}).`,
    );
  }
  return deleted;
}
