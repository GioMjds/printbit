'use strict';

const path = require('node:path');

// Parse CLI flags first so we can provide usage help or run safely in dry-run mode.
const args = new Set(process.argv.slice(2));
const showHelp = args.has('--help') || args.has('-h');
const dryRun = args.has('--dry-run');

if (showHelp) {
  console.log(`Usage: node scripts/reset-db.js [--dry-run]

Resets PrintBit SQLite-backed runtime data while preserving configuration.

What it resets:
- Balance and earnings counters
- Coin/job statistics
- Hopper runtime stats
- Owed change, pending refund, anomaly, ledger, ink history, recovery sessions
- E-Receipt records and access tokens
- Wireless print sessions/documents metadata
- Admin logs, feedback entries/sessions, report issue entries/sessions/attachments

What it preserves:
- Admin/settings configuration (pricing, admin PIN hash, alert config, etc.)
- Hopper settings configuration
`);
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, '..');
process.chdir(repoRoot);

require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { initDB, db } = require('../src/services/db');
const {
  getSqliteDb,
  initSqliteStorage,
} = require('../src/core/database/sqlite-storage');

// Build the next runtime state by preserving configuration while clearing runtime/operational data.
function buildResetState(current) {
  return {
    ...current,
    adminLockout: {
      failedAttempts: 0,
      lockedUntil: null,
    },
    balance: 0,
    earnings: 0,
    coinStats: {
      one: 0,
      five: 0,
      ten: 0,
      twenty: 0,
    },
    jobStats: {
      total: 0,
      print: 0,
      copy: 0,
      scan: 0,
    },
    hopperStats: {
      dispenseAttempts: 0,
      dispenseSuccess: 0,
      dispenseFailures: 0,
      totalDispensed: 0,
      lastDispensedAt: null,
      lastError: null,
      selfTestPassed: null,
      lastSelfTestAt: null,
    },
    owedChanges: [],
    logs: [],
    feedback: [],
    feedbackSessions: [],
    reportIssues: [],
    reportIssueSessions: [],
    reportIssueAttachments: [],
    pendingRefunds: [],
    anomalyIncidents: [],
    financialLedger: [],
    inkHistory: [],
    receiptRecords: [],
    receiptAccessTokens: [],
    recovery: {
      lifecycle: {
        bootCount: 0,
        unexpectedRestartCount: 0,
        lastStartupAt: null,
        lastStartupPid: null,
        lastStartupReason: null,
        lastShutdownAt: null,
        lastShutdownPid: null,
        lastShutdownSignal: null,
        lastUnexpectedRestartAt: null,
      },
      sessions: [],
    },
  };
}

const ALLOWED_TABLES = new Set([
  'wireless_sessions',
  'wireless_session_documents',
  'admin_logs',
  'feedback_entries',
  'feedback_sessions',
  'report_issue_entries',
  'report_issue_sessions',
  'report_issue_attachments',
  'receipt_records',
  'receipt_access_tokens',
]);

function countRows(sqliteDb, tableName) {
  if (!ALLOWED_TABLES.has(tableName))
    throw new Error(`Table "${tableName}" is not allowed for counting.`);

  const row = sqliteDb
    .prepare(`SELECT COUNT(*) AS total FROM ${tableName}`)
    .get();
  return Number(row?.total ?? 0);
}

// Clear only operational SQLite tables in one transaction for all-or-nothing consistency.
function clearSqliteOperationalTables(sqliteDb) {
  // BEGIN IMMEDIATE acquires a write lock early to prevent partial clears during concurrent access.
  sqliteDb.exec('BEGIN IMMEDIATE');
  try {
    // These tables contain runtime/admin event data and can be safely regenerated after reset.
    sqliteDb.exec(
      `DELETE FROM wireless_session_documents;
       DELETE FROM wireless_sessions;
       DELETE FROM admin_logs;
       DELETE FROM feedback_entries;
       DELETE FROM feedback_sessions;
       DELETE FROM report_issue_attachments;
       DELETE FROM report_issue_entries;
       DELETE FROM report_issue_sessions;
       DELETE FROM receipt_access_tokens;
       DELETE FROM receipt_records;`,
    );
    // Commit once all deletes succeed.
    sqliteDb.exec('COMMIT');
  } catch (error) {
    try {
      // Roll back any partial deletes to keep SQLite tables consistent on failure.
      sqliteDb.exec('ROLLBACK');
    } catch (_rollbackError) {
      // no-op
    }
    throw error;
  }
}

async function main() {
  // Initialize database state before taking any reset snapshots.
  await initDB();
  if (!db.data) {
    throw new Error('Database state is not initialized.');
  }

  // Initialize SQLite storage and get the shared connection used by runtime stores.
  initSqliteStorage();
  const sqliteDb = getSqliteDb();

  // Capture a before snapshot so operators can confirm what will be reset.
  const before = {
    wireless_sessions: countRows(sqliteDb, 'wireless_sessions'),
    wireless_session_documents: countRows(sqliteDb, 'wireless_session_documents'),
    admin_logs: countRows(sqliteDb, 'admin_logs'),
    feedback_entries: countRows(sqliteDb, 'feedback_entries'),
    feedback_sessions: countRows(sqliteDb, 'feedback_sessions'),
    report_issue_entries: countRows(sqliteDb, 'report_issue_entries'),
    report_issue_sessions: countRows(sqliteDb, 'report_issue_sessions'),
    report_issue_attachments: countRows(sqliteDb, 'report_issue_attachments'),
    receipt_records: countRows(sqliteDb, 'receipt_records'),
    receipt_access_tokens: countRows(sqliteDb, 'receipt_access_tokens'),
    financialLedger: db.data.financialLedger.length,
    receiptRecords: db.data.receiptRecords.length,
    receiptAccessTokens: db.data.receiptAccessTokens.length,
    anomalyIncidents: db.data.anomalyIncidents.length,
    pendingRefunds: db.data.pendingRefunds.length,
  };

  console.log('[reset-db] Current data snapshot:', before);

  // Dry run reports impact only and exits without mutating database state or SQLite.
  if (dryRun) {
    console.log('[reset-db] Dry run complete. No data was changed.');
    return;
  }

  // Apply reset: clear SQLite operational tables, replace runtime state, then persist.
  clearSqliteOperationalTables(sqliteDb);
  db.data = buildResetState(db.data);
  await db.write();

  // Capture an after snapshot to verify reset effects immediately.
  const after = {
    wireless_sessions: countRows(sqliteDb, 'wireless_sessions'),
    wireless_session_documents: countRows(sqliteDb, 'wireless_session_documents'),
    admin_logs: countRows(sqliteDb, 'admin_logs'),
    feedback_entries: countRows(sqliteDb, 'feedback_entries'),
    feedback_sessions: countRows(sqliteDb, 'feedback_sessions'),
    report_issue_entries: countRows(sqliteDb, 'report_issue_entries'),
    report_issue_sessions: countRows(sqliteDb, 'report_issue_sessions'),
    report_issue_attachments: countRows(sqliteDb, 'report_issue_attachments'),
    receipt_records: countRows(sqliteDb, 'receipt_records'),
    receipt_access_tokens: countRows(sqliteDb, 'receipt_access_tokens'),
    financialLedger: db.data.financialLedger.length,
    receiptRecords: db.data.receiptRecords.length,
    receiptAccessTokens: db.data.receiptAccessTokens.length,
    anomalyIncidents: db.data.anomalyIncidents.length,
    pendingRefunds: db.data.pendingRefunds.length,
  };

  console.log('[reset-db] Reset complete:', after);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[reset-db] Failed:', message);
  process.exit(1);
});
