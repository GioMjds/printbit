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
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.toEntry(row));
  }

  deleteJob(jobId: string): void {
    getSqliteDb().prepare('DELETE FROM print_jobs WHERE job_id = ?').run(jobId);
  }

<<<<<<< HEAD
=======
  getJobByTransactionId(transactionId: string): PrintJobEntry | null {
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
         WHERE transaction_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(transactionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toEntry(row);
  }

  listAllJobs(limit = 1000): PrintJobEntry[] {
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
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.toEntry(row));
  }

  getJobStats(): { total: number; print: number; copy: number; scan: number } {
    const rows = getSqliteDb()
      .prepare(`SELECT payload_json FROM print_jobs WHERE state = 'printed'`)
      .all() as { payload_json: string }[];
    let print = 0;
    let copy = 0;
    let scan = 0;
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload_json);
        const mode = p.request?.mode || p.mode;
        if (mode === 'print') print += 1;
        else if (mode === 'copy') copy += 1;
        else if (mode === 'scan') scan += 1;
        else print += 1;
      } catch {
        print += 1;
      }
    }
    return {
      total: print + copy + scan,
      print,
      copy,
      scan,
    };
  }

>>>>>>> 39192d9520fc5f430f33c78b2550d03fd0c5a05f
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
