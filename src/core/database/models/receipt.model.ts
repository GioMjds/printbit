import { getSqliteDb, withTransaction } from '../sqlite-storage';

export type ReceiptMode = 'print' | 'copy';

export type ReceiptRecordStatus =
  | 'settled_pending_terminal'
  | 'printed'
  | 'failed'
  | 'refunded'
  | 'refunded_pending_review';

export type ReceiptChangeState = 'none' | 'dispensed' | 'failed';

export interface ReceiptChangeSnapshot {
  requested: number;
  dispensed: number;
  state: ReceiptChangeState;
  attempts: number;
  owedChangeId: string | null;
  message: string | null;
}

export interface ReceiptPrintConfigurationSnapshot {
  copies: number | null;
  colorMode: 'colored' | 'grayscale' | null;
  paperSize: 'A4' | 'Letter' | 'Legal' | null;
  quality: 'standard' | 'high' | null;
  duplex: boolean | null;
  orientation: 'portrait' | 'landscape' | null;
  pageRange: string | null;
}

export interface ReceiptDetailsSnapshot {
  coinsInserted: number | null;
  documentName: string | null;
  printConfiguration: ReceiptPrintConfigurationSnapshot;
}

export interface ReceiptRecordEntry {
  id: string;
  transactionId: string;
  mode: ReceiptMode;
  chargedAmount: number;
  colorPages?: number | null;
  bwPages?: number | null;
  status: ReceiptRecordStatus;
  change: ReceiptChangeSnapshot;
  details?: ReceiptDetailsSnapshot;
  settledAt: string | null;
  terminalAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ReceiptAccessTokenEntry {
  id: string;
  receiptId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface ReceiptTokenLookupResult {
  receipt: ReceiptRecordEntry;
  token: ReceiptAccessTokenEntry;
}

export type ListReceiptOptions = {
  mode?: ReceiptRecordEntry['mode'];
  status?: ReceiptRecordEntry['status'];
  limit: number;
  offset: number;
};

export class ReceiptSqliteStore {
  upsertReceiptRecord(entry: ReceiptRecordEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT INTO receipt_records (
          id,
          transaction_id,
          mode,
          charged_amount,
          color_pages,
          bw_pages,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(transaction_id) DO UPDATE SET
          mode = excluded.mode,
          charged_amount = excluded.charged_amount,
          color_pages = excluded.color_pages,
          bw_pages = excluded.bw_pages,
          status = excluded.status,
          change_requested = excluded.change_requested,
          change_dispensed = excluded.change_dispensed,
          change_state = excluded.change_state,
          change_attempts = excluded.change_attempts,
          change_owed_id = excluded.change_owed_id,
          change_message = excluded.change_message,
          details_json = excluded.details_json,
          settled_at = excluded.settled_at,
          terminal_at = excluded.terminal_at,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at`,
      )
      .run(
        entry.id,
        entry.transactionId,
        entry.mode,
        entry.chargedAmount,
        // color_pages
        typeof (entry as unknown as Record<string, unknown>).colorPages ===
          'number'
          ? Math.max(
              0,
              Math.floor(
                (entry as unknown as Record<string, number>).colorPages,
              ),
            )
          : null,
        // bw_pages
        typeof (entry as unknown as Record<string, unknown>).bwPages ===
          'number'
          ? Math.max(
              0,
              Math.floor((entry as unknown as Record<string, number>).bwPages),
            )
          : null,
        entry.status,
        entry.change.requested,
        entry.change.dispensed,
        entry.change.state,
        entry.change.attempts,
        entry.change.owedChangeId,
        entry.change.message,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.settledAt,
        entry.terminalAt,
        entry.createdAt,
        entry.updatedAt,
        entry.expiresAt,
      );
  }

  getReceiptById(receiptId: string): ReceiptRecordEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          id,
          transaction_id,
          mode,
          charged_amount,
          color_pages,
          bw_pages,
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
         FROM receipt_records
         WHERE id = ?
         LIMIT 1`,
      )
      .get(receiptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toReceiptRecord(row);
  }

  getReceiptByTransactionId(transactionId: string): ReceiptRecordEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          id,
          transaction_id,
          mode,
          charged_amount,
          color_pages,
          bw_pages,
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
         FROM receipt_records
         WHERE transaction_id = ?
         LIMIT 1`,
      )
      .get(transactionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toReceiptRecord(row);
  }

  deleteReceiptById(receiptId: string): boolean {
    const result = getSqliteDb()
      .prepare('DELETE FROM receipt_records WHERE id = ?')
      .run(receiptId) as { changes?: unknown };
    return Number(result.changes ?? 0) > 0;
  }

  listReceipts(options: ListReceiptOptions): {
    total: number;
    items: ReceiptRecordEntry[];
  } {
    const db = getSqliteDb();
    const limit = Math.max(1, Math.floor(options.limit));
    const offset = Math.max(0, Math.floor(options.offset));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.mode) {
      where.push('mode = ?');
      params.push(options.mode);
    }
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS total FROM receipt_records ${whereSql}`)
      .get(...params) as { total?: unknown };
    const rows = db
      .prepare(
        `SELECT
          id,
          transaction_id,
          mode,
          charged_amount,
          color_pages,
          bw_pages,
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
         FROM receipt_records
         ${whereSql}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];

    return {
      total: Number(totalRow.total ?? 0),
      items: rows.map((row) => this.toReceiptRecord(row)),
    };
  }

  createAccessToken(entry: ReceiptAccessTokenEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT INTO receipt_access_tokens (
          id,
          receipt_id,
          token_hash,
          created_at,
          expires_at,
          revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.receiptId,
        entry.tokenHash,
        entry.createdAt,
        entry.expiresAt,
        entry.revokedAt,
      );
  }

  getAccessTokenByHash(tokenHash: string): ReceiptAccessTokenEntry | null {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          id,
          receipt_id,
          token_hash,
          created_at,
          expires_at,
          revoked_at
         FROM receipt_access_tokens
         WHERE token_hash = ?
         LIMIT 1`,
      )
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toAccessTokenEntry(row);
  }

  listAccessTokensForReceipt(receiptId: string): ReceiptAccessTokenEntry[] {
    const rows = getSqliteDb()
      .prepare(
        `SELECT
          id,
          receipt_id,
          token_hash,
          created_at,
          expires_at,
          revoked_at
         FROM receipt_access_tokens
         WHERE receipt_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(receiptId) as Record<string, unknown>[];
    return rows.map((row) => this.toAccessTokenEntry(row));
  }

  revokeAccessToken(tokenHash: string, revokedAt: string): boolean {
    const result = getSqliteDb()
      .prepare(
        `UPDATE receipt_access_tokens
         SET revoked_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, tokenHash) as { changes?: unknown };
    return Number(result.changes ?? 0) > 0;
  }

  deleteAccessTokenByHash(tokenHash: string): boolean {
    const result = getSqliteDb()
      .prepare('DELETE FROM receipt_access_tokens WHERE token_hash = ?')
      .run(tokenHash) as { changes?: unknown };
    return Number(result.changes ?? 0) > 0;
  }

  findActiveReceiptByTokenHash(
    tokenHash: string,
    now: Date,
  ): ReceiptTokenLookupResult | null {
    const nowIso = now.toISOString();
    const row = getSqliteDb()
      .prepare(
        `SELECT
          rr.id AS receipt_id,
          rr.transaction_id AS receipt_transaction_id,
          rr.mode AS receipt_mode,
          rr.charged_amount AS receipt_charged_amount,
          rr.color_pages AS receipt_color_pages,
          rr.bw_pages AS receipt_bw_pages,
          rr.status AS receipt_status,
          rr.change_requested AS receipt_change_requested,
          rr.change_dispensed AS receipt_change_dispensed,
          rr.change_state AS receipt_change_state,
          rr.change_attempts AS receipt_change_attempts,
          rr.change_owed_id AS receipt_change_owed_id,
          rr.change_message AS receipt_change_message,
          rr.details_json AS receipt_details_json,
          rr.settled_at AS receipt_settled_at,
          rr.terminal_at AS receipt_terminal_at,
          rr.created_at AS receipt_created_at,
          rr.updated_at AS receipt_updated_at,
          rr.expires_at AS receipt_expires_at,
          rat.id AS token_id,
          rat.receipt_id AS token_receipt_id,
          rat.token_hash AS token_hash,
          rat.created_at AS token_created_at,
          rat.expires_at AS token_expires_at,
          rat.revoked_at AS token_revoked_at
         FROM receipt_access_tokens rat
         INNER JOIN receipt_records rr
           ON rr.id = rat.receipt_id
         WHERE rat.token_hash = ?
           AND rat.revoked_at IS NULL
           AND rat.expires_at > ?
           AND rr.expires_at > ?
         LIMIT 1`,
      )
      .get(tokenHash, nowIso, nowIso) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      receipt: this.toReceiptRecord({
        id: row.receipt_id,
        transaction_id: row.receipt_transaction_id,
        mode: row.receipt_mode,
        charged_amount: row.receipt_charged_amount,
        color_pages: row.receipt_color_pages,
        bw_pages: row.receipt_bw_pages,
        status: row.receipt_status,
        change_requested: row.receipt_change_requested,
        change_dispensed: row.receipt_change_dispensed,
        change_state: row.receipt_change_state,
        change_attempts: row.receipt_change_attempts,
        change_owed_id: row.receipt_change_owed_id,
        change_message: row.receipt_change_message,
        details_json: row.receipt_details_json,
        settled_at: row.receipt_settled_at,
        terminal_at: row.receipt_terminal_at,
        created_at: row.receipt_created_at,
        updated_at: row.receipt_updated_at,
        expires_at: row.receipt_expires_at,
      }),
      token: this.toAccessTokenEntry({
        id: row.token_id,
        receipt_id: row.token_receipt_id,
        token_hash: row.token_hash,
        created_at: row.token_created_at,
        expires_at: row.token_expires_at,
        revoked_at: row.token_revoked_at,
      }),
    };
  }

  cleanupExpiredAccessTokens(now: Date): number {
    const nowIso = now.toISOString();
    const result = getSqliteDb()
      .prepare(
        `DELETE FROM receipt_access_tokens
         WHERE expires_at <= ?
            OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
      )
      .run(nowIso, nowIso) as { changes?: unknown };
    return Number(result.changes ?? 0);
  }

  cleanupExpiredReceiptRecords(now: Date): number {
    const nowIso = now.toISOString();
    const result = getSqliteDb()
      .prepare(
        `DELETE FROM receipt_records
         WHERE expires_at <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM receipt_access_tokens
             WHERE receipt_access_tokens.receipt_id = receipt_records.id
               AND receipt_access_tokens.revoked_at IS NULL
               AND receipt_access_tokens.expires_at > ?
           )`,
      )
      .run(nowIso, nowIso) as { changes?: unknown };
    return Number(result.changes ?? 0);
  }

  cleanupExpired(now: Date): {
    deletedReceiptRecords: number;
    deletedAccessTokens: number;
  } {
    return withTransaction(() => {
      const deletedAccessTokens = this.cleanupExpiredAccessTokens(now);
      const deletedReceiptRecords = this.cleanupExpiredReceiptRecords(now);
      return { deletedReceiptRecords, deletedAccessTokens };
    });
  }

  private toReceiptStatus(value: unknown): ReceiptRecordStatus {
    if (
      value === 'settled_pending_terminal' ||
      value === 'printed' ||
      value === 'failed' ||
      value === 'refunded' ||
      value === 'refunded_pending_review'
    ) {
      return value;
    }
    return 'settled_pending_terminal';
  }

  private toReceiptChangeState(value: unknown): ReceiptChangeState {
    if (value === 'dispensed' || value === 'failed' || value === 'none') {
      return value;
    }
    return 'none';
  }

  private toReceiptRecord(row: Record<string, unknown>): ReceiptRecordEntry {
    const requested = Math.max(
      0,
      Math.floor(Number(row.change_requested ?? 0) || 0),
    );
    const dispensed = Math.max(
      0,
      Math.floor(Number(row.change_dispensed ?? 0) || 0),
    );
    const attempts = Math.max(
      0,
      Math.floor(Number(row.change_attempts ?? 0) || 0),
    );
    const changeState = this.toReceiptChangeState(row.change_state);
    const owedChangeId =
      typeof row.change_owed_id === 'string' ? row.change_owed_id : null;
    const changeMessage =
      typeof row.change_message === 'string' ? row.change_message : null;
    return {
      id: String(row.id ?? ''),
      transactionId: String(row.transaction_id ?? ''),
      mode: row.mode === 'copy' ? 'copy' : 'print',
      chargedAmount: Number(row.charged_amount ?? 0),
      status: this.toReceiptStatus(row.status),
      change: {
        requested,
        dispensed: Math.min(dispensed, requested),
        state: changeState,
        attempts,
        owedChangeId: changeState === 'failed' ? owedChangeId : null,
        message: changeState === 'failed' ? changeMessage : null,
      },
      details: this.toReceiptDetails(row.details_json),
      settledAt: typeof row.settled_at === 'string' ? row.settled_at : null,
      terminalAt: typeof row.terminal_at === 'string' ? row.terminal_at : null,
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      expiresAt: String(row.expires_at ?? ''),
      colorPages:
        typeof row.color_pages === 'number' && Number.isFinite(row.color_pages)
          ? Math.max(0, Math.floor(Number(row.color_pages)))
          : null,
      bwPages:
        typeof row.bw_pages === 'number' && Number.isFinite(row.bw_pages)
          ? Math.max(0, Math.floor(Number(row.bw_pages)))
          : null,
    };
  }

  private toReceiptDetails(value: unknown): ReceiptDetailsSnapshot | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;

    let candidate: Record<string, unknown>;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      candidate = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }

    const rawConfiguration =
      typeof candidate.printConfiguration === 'object' &&
      candidate.printConfiguration !== null
        ? (candidate.printConfiguration as Record<string, unknown>)
        : {};
    const coinsInserted = Number(candidate.coinsInserted);

    return {
      coinsInserted:
        Number.isFinite(coinsInserted) && coinsInserted >= 0
          ? coinsInserted
          : null,
      documentName:
        typeof candidate.documentName === 'string' && candidate.documentName
          ? candidate.documentName
          : null,
      printConfiguration: {
        copies:
          typeof rawConfiguration.copies === 'number' &&
          Number.isFinite(rawConfiguration.copies)
            ? Math.min(30, Math.max(1, Math.floor(rawConfiguration.copies)))
            : null,
        colorMode:
          rawConfiguration.colorMode === 'colored' ||
          rawConfiguration.colorMode === 'grayscale'
            ? rawConfiguration.colorMode
            : null,
        paperSize:
          rawConfiguration.paperSize === 'A4' ||
          rawConfiguration.paperSize === 'Letter' ||
          rawConfiguration.paperSize === 'Legal'
            ? rawConfiguration.paperSize
            : null,
        quality:
          rawConfiguration.quality === 'standard' ||
          rawConfiguration.quality === 'high'
            ? rawConfiguration.quality
            : null,
        duplex:
          typeof rawConfiguration.duplex === 'boolean'
            ? rawConfiguration.duplex
            : null,
        orientation:
          rawConfiguration.orientation === 'portrait' ||
          rawConfiguration.orientation === 'landscape'
            ? rawConfiguration.orientation
            : null,
        pageRange:
          typeof rawConfiguration.pageRange === 'string' &&
          rawConfiguration.pageRange
            ? rawConfiguration.pageRange
            : null,
      },
    };
  }

  private toAccessTokenEntry(
    row: Record<string, unknown>,
  ): ReceiptAccessTokenEntry {
    return {
      id: String(row.id ?? ''),
      receiptId: String(row.receipt_id ?? ''),
      tokenHash: String(row.token_hash ?? ''),
      createdAt: String(row.created_at ?? ''),
      expiresAt: String(row.expires_at ?? ''),
      revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : null,
    };
  }
}

export const receiptStore = new ReceiptSqliteStore();
