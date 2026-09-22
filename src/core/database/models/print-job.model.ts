import { getSqliteDb } from '../sqlite-storage';

export type PrintJobState =
  | 'pending'
  | 'processing'
  | 'printed'
  | 'failed'
  | 'retrying';

export interface PrintJobEntry {
  jobId: string;
  transactionId: string;
  state: PrintJobState;
  payloadJson: string;
  attemptsJson: string;
  createdAt: string;
  updatedAt: string;
}

export class PrintJobSqliteStore {
  createJob(entry: PrintJobEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT INTO print_jobs (
          job_id,
          transaction_id,
          state,
          payload_json,
          attempts_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.jobId,
        entry.transactionId,
        entry.state,
        entry.payloadJson,
        entry.attemptsJson,
        entry.createdAt,
        entry.updatedAt,
      );
  }

  getJobById(jobId: string): PrintJobEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          job_id,
          transaction_id,
          state,
          payload_json,
          attempts_json,
          created_at,
          updated_at
         FROM print_jobs
         WHERE job_id = ?
         LIMIT 1`,
      )
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toEntry(row);
  }

  updateJobState(
    jobId: string,
    state: PrintJobState,
    attemptsJson?: string,
  ): void {
    const updatedAt = new Date().toISOString();
    if (attemptsJson !== undefined) {
      getSqliteDb()
        .prepare(
          `UPDATE print_jobs
           SET state = ?, attempts_json = ?, updated_at = ?
           WHERE job_id = ?`,
        )
         .run(state, attemptsJson, updatedAt, jobId);
    } else {
      getSqliteDb()
        .prepare(
          `UPDATE print_jobs
           SET state = ?, updated_at = ?
           WHERE job_id = ?`,
        )
         .run(state, updatedAt, jobId);
    }
  }

  listPendingJobs(): PrintJobEntry[] {
    const rows = getSqliteDb()
      .prepare(
        `SELECT
          job_id,
          transaction_id,
          state,
          payload_json,
          attempts_json,
          created_at,
          updated_at
         FROM print_jobs
         WHERE state = 'pending'
         ORDER BY created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.toEntry(row));
  }

  deleteJob(jobId: string): void {
    getSqliteDb().prepare('DELETE FROM print_jobs WHERE job_id = ?').run(jobId);
  }

  private toEntry(row: Record<string, unknown>): PrintJobEntry {
    return {
      jobId: String(row.job_id ?? ''),
      transactionId: String(row.transaction_id ?? ''),
      state: toPrintJobState(row.state),
      payloadJson: String(row.payload_json ?? ''),
      attemptsJson: String(row.attempts_json ?? '[]'),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }
}

function toPrintJobState(value: unknown): PrintJobState {
  return value === 'pending' ||
    value === 'processing' ||
    value === 'printed' ||
    value === 'failed' ||
    value === 'retrying'
    ? value
    : 'failed';
}

export const printJobStore = new PrintJobSqliteStore();
