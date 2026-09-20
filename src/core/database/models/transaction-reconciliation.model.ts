import { getSqliteDb } from '../sqlite-storage';

export type TransactionReconciliationStatus =
  | 'RECONCILED_COMPLETED'
  | 'RECONCILED_REFUNDED'
  | 'FAILED_NO_CHARGE'
  | 'PAID_BUT_UNRESOLVED'
  | 'JOB_ONLY';

export interface TransactionReconciliationEntry {
  transactionId: string;
  jobId: string | null;
  createdAt: string;
  mode: string;
  requiredAmount: number;
  verifiedAmount: number;
  reconciliationStatus: TransactionReconciliationStatus;
  paymentEvidence: string;
  changeDispensed: number;
  receiptId: string | null;
  detailsJson?: string | null;
}

export interface ReconciliationSummary {
  totalJobs: number;
  verifiedTransactions: number;
  verifiedRevenue: number;
  unreconciledJobs: number;
  unreconciledRequiredAmount: number;
  rawCoinTotal: number;
  ledgerDiscrepancy: boolean;
}

export class TransactionReconciliationSqliteStore {
  upsert(entry: TransactionReconciliationEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT INTO transaction_reconciliation (
          transaction_id,
          job_id,
          created_at,
          mode,
          required_amount,
          verified_amount,
          reconciliation_status,
          payment_evidence,
          change_dispensed,
          receipt_id,
          details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(transaction_id) DO UPDATE SET
          job_id = excluded.job_id,
          created_at = excluded.created_at,
          mode = excluded.mode,
          required_amount = excluded.required_amount,
          verified_amount = excluded.verified_amount,
          reconciliation_status = excluded.reconciliation_status,
          payment_evidence = excluded.payment_evidence,
          change_dispensed = excluded.change_dispensed,
          receipt_id = excluded.receipt_id,
          details_json = excluded.details_json`,
      )
      .run(
        entry.transactionId,
        entry.jobId,
        entry.createdAt,
        entry.mode,
        entry.requiredAmount,
        entry.verifiedAmount,
        entry.reconciliationStatus,
        entry.paymentEvidence,
        entry.changeDispensed,
        entry.receiptId,
        entry.detailsJson ?? null,
      );
  }

  getByTransactionId(txId: string): TransactionReconciliationEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT * FROM transaction_reconciliation WHERE transaction_id = ? LIMIT 1`,
      )
      .get(txId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toEntry(row);
  }

  listAll(limit = 1000): TransactionReconciliationEntry[] {
    const rows = getSqliteDb()
      .prepare(
        `SELECT * FROM transaction_reconciliation ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toEntry(r));
  }

  getSummary(): ReconciliationSummary {
    const db = getSqliteDb();
    const jobStatsRow = db
      .prepare(
        `SELECT
           COUNT(*) as total_jobs,
           SUM(CASE WHEN reconciliation_status = 'RECONCILED_COMPLETED' THEN 1 ELSE 0 END) as verified_txs,
           SUM(CASE WHEN reconciliation_status = 'RECONCILED_COMPLETED' THEN verified_amount ELSE 0 END) as verified_revenue,
           SUM(CASE WHEN reconciliation_status = 'JOB_ONLY' THEN 1 ELSE 0 END) as unreconciled_jobs,
           SUM(CASE WHEN reconciliation_status = 'JOB_ONLY' THEN required_amount ELSE 0 END) as unreconciled_required
         FROM transaction_reconciliation`,
      )
      .get() as Record<string, unknown> | undefined;

    const coinSumRow = db
      .prepare(`SELECT COALESCE(SUM(coin_value), 0) as total FROM coin_bridge_events`)
      .get() as Record<string, unknown> | undefined;

    let ledgerDiscrepancy = false;
    try {
      const stateRow = db
        .prepare('SELECT payload_json FROM runtime_state WHERE id = 1')
        .get() as { payload_json?: string } | undefined;
      if (stateRow?.payload_json) {
        const state = JSON.parse(stateRow.payload_json);
        const verifiedRevenue = Number(jobStatsRow?.verified_revenue ?? 0);
        if (
          state.earnings !== undefined &&
          Math.abs(Number(state.earnings) - verifiedRevenue) > 0.01
        ) {
          ledgerDiscrepancy = true;
        }
      }
    } catch {
      // Ignore
    }

    return {
      totalJobs: Number(jobStatsRow?.total_jobs ?? 0),
      verifiedTransactions: Number(jobStatsRow?.verified_txs ?? 0),
      verifiedRevenue: Number(jobStatsRow?.verified_revenue ?? 0),
      unreconciledJobs: Number(jobStatsRow?.unreconciled_jobs ?? 0),
      unreconciledRequiredAmount: Number(jobStatsRow?.unreconciled_required ?? 0),
      rawCoinTotal: Number(coinSumRow?.total ?? 0),
      ledgerDiscrepancy,
    };
  }

  private toEntry(row: Record<string, unknown>): TransactionReconciliationEntry {
    return {
      transactionId: String(row.transaction_id ?? ''),
      jobId: row.job_id ? String(row.job_id) : null,
      createdAt: String(row.created_at ?? ''),
      mode: String(row.mode ?? 'print'),
      requiredAmount: Number(row.required_amount ?? 0),
      verifiedAmount: Number(row.verified_amount ?? 0),
      reconciliationStatus:
        (row.reconciliation_status as TransactionReconciliationStatus) ?? 'JOB_ONLY',
      paymentEvidence: String(row.payment_evidence ?? 'none'),
      changeDispensed: Number(row.change_dispensed ?? 0),
      receiptId: row.receipt_id ? String(row.receipt_id) : null,
      detailsJson: row.details_json ? String(row.details_json) : null,
    };
  }
}

export const transactionReconciliationStore =
  new TransactionReconciliationSqliteStore();
