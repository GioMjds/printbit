import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { receiptStore } from '@/core/database/sqlite-storage';
import type {
  LogMeta,
  ReceiptAccessTokenEntry,
  ReceiptChangeSnapshot,
  ReceiptChangeState,
  ReceiptDetailsSnapshot,
  ReceiptMode,
  ReceiptPrintConfigurationSnapshot,
  ReceiptRecordEntry,
  ReceiptRecordStatus,
} from '@/services/db';
import { adminService } from '@/services/admin';
import { getSpoolerLifecycleRecord } from '@/services/recovery';

const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const RECEIPT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STATUS: ReceiptRecordStatus = 'settled_pending_terminal';

export interface ReceiptSnapshotInput {
  transactionId: string;
  mode: ReceiptMode;
  chargedAmount: number;
  // Optional persisted page composition counts (nullable when unknown)
  colorPages?: number | null;
  bwPages?: number | null;
  coinsInserted?: number | null;
  documentName?: string | null;
  printConfiguration?: Partial<ReceiptPrintConfigurationSnapshot> | null;
  status?: ReceiptRecordStatus;
  change?: Partial<ReceiptChangeSnapshot>;
  settledAt?: string | null;
  terminalAt?: string | null;
  expiresAt?: string;
}

export interface ReceiptTerminalUpdateInput {
  transactionId: string;
  status: ReceiptRecordStatus;
  terminalAt?: string | null;
}

export interface MintReceiptTokenOptions {
  ttlMs?: number;
  revokeExisting?: boolean;
}

export interface MintReceiptTokenResult {
  token: string;
  tokenId: string;
  transactionId: string;
  receiptId: string;
  expiresAt: string;
}

export interface ReceiptPayloadChange {
  requested: number;
  dispensed: number;
  remaining: number;
  state: ReceiptChangeState;
  attempts: number;
  owedChangeId: string | null;
  message: string | null;
}

export interface ReceiptPayload {
  transactionId: string;
  mode: ReceiptMode;
  chargedAmount: number;
  colorPages: number | null;
  bwPages: number | null;
  pagesPrinted: number | null;
  totalPages: number | null;
  coinsInserted: number | null;
  documentName: string | null;
  printConfiguration: ReceiptPrintConfigurationSnapshot;
  status: ReceiptRecordStatus;
  change: ReceiptPayloadChange;
  settledAt: string | null;
  terminalAt: string | null;
  generatedAt: string;
}

export type ResolveReceiptByTokenResult =
  | {
      status: 'ok';
      receipt: ReceiptRecordEntry;
      accessToken: ReceiptAccessTokenEntry;
      payload: ReceiptPayload;
    }
  | { status: 'unknown' | 'expired' | 'revoked' };

export type ResolveReceiptByTransactionResult =
  | { status: 'ok'; receipt: ReceiptRecordEntry; payload: ReceiptPayload }
  | { status: 'not_found' | 'expired' };

export interface ReceiptCleanupResult {
  deletedReceiptRecords: number;
  deletedAccessTokens: number;
}

function parseTimestampMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIsoTimestamp(
  value: string | null | undefined,
  fallback: string | null,
): string | null {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const parsed = parseTimestampMs(trimmed);
  if (parsed === null) return fallback;
  return new Date(parsed).toISOString();
}

function isExpired(value: string, nowMs: number): boolean {
  const parsed = parseTimestampMs(value);
  if (parsed === null) return true;
  return parsed <= nowMs;
}

export class ReceiptService {
  upsertReceiptSnapshot(
    input: ReceiptSnapshotInput,
    now = new Date(),
  ): ReceiptRecordEntry {
    const transactionId = input.transactionId.trim();
    if (!transactionId) {
      throw new Error('transactionId is required.');
    }

    const nowIso = now.toISOString();
    const existing = receiptStore.getReceiptByTransactionId(transactionId);
    const expiresAt = this.resolveExpiryTimestamp(
      input.expiresAt,
      existing?.expiresAt,
      now,
    );
    const settledAt = normalizeIsoTimestamp(
      input.settledAt,
      existing?.settledAt ?? nowIso,
    );
    const terminalAt = normalizeIsoTimestamp(
      input.terminalAt,
      existing?.terminalAt ?? null,
    );
    const change = this.normalizeChangeSnapshot(input.change, existing?.change);
    const details = this.normalizeDetailsSnapshot(input, existing?.details);

    const entry: ReceiptRecordEntry = {
      id: existing?.id ?? randomUUID(),
      transactionId,
      mode: input.mode === 'copy' ? 'copy' : 'print',
      chargedAmount: this.normalizeChargedAmount(input.chargedAmount),
      // Persist reported color/bw page counts when available
      colorPages:
        typeof input.colorPages === 'number'
          ? Math.max(0, Math.floor(input.colorPages))
          : existing?.colorPages ?? null,
      bwPages:
        typeof input.bwPages === 'number'
          ? Math.max(0, Math.floor(input.bwPages))
          : existing?.bwPages ?? null,
      status: input.status ?? existing?.status ?? DEFAULT_STATUS,
      change,
      details,
      settledAt,
      terminalAt,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      expiresAt,
    };

    receiptStore.upsertReceiptRecord(entry);
    if (!existing) {
      this.appendLifecycleLog(
        'receipt_snapshot_created',
        'Receipt snapshot created.',
        {
          transactionId: entry.transactionId,
          receiptId: entry.id,
          mode: entry.mode,
          status: entry.status,
          chargedAmount: entry.chargedAmount,
          changeState: entry.change.state,
          changeRequested: entry.change.requested,
          changeDispensed: entry.change.dispensed,
          changeAttempts: entry.change.attempts,
          owedChangeId: entry.change.owedChangeId,
          expiresAt: entry.expiresAt,
        },
      );
    }
    return entry;
  }

  mintToken(
    transactionIdRaw: string,
    options: MintReceiptTokenOptions = {},
    now = new Date(),
  ): MintReceiptTokenResult | null {
    const transactionId = transactionIdRaw.trim();
    if (!transactionId) return null;

    const resolution = this.resolveByTransactionId(transactionId, now);
    if (resolution.status !== 'ok') return null;

    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const receiptExpiresMs = parseTimestampMs(resolution.receipt.expiresAt);
    const requestedTtlMs = Math.max(
      1_000,
      Math.floor(options.ttlMs ?? RECEIPT_TOKEN_TTL_MS),
    );
    const candidateExpiryMs = nowMs + requestedTtlMs;
    const expiresAtMs =
      receiptExpiresMs === null
        ? candidateExpiryMs
        : Math.min(candidateExpiryMs, receiptExpiresMs);
    const expiresAt = new Date(expiresAtMs).toISOString();

    let revokedTokenCount = 0;
    if (options.revokeExisting) {
      const currentTokens = receiptStore.listAccessTokensForReceipt(
        resolution.receipt.id,
      );
      for (const token of currentTokens) {
        if (token.revokedAt === null) {
          if (receiptStore.revokeAccessToken(token.tokenHash, nowIso)) {
            revokedTokenCount += 1;
          }
        }
      }
    }

    const token = randomBytes(32).toString('base64url');
    const entry: ReceiptAccessTokenEntry = {
      id: randomUUID(),
      receiptId: resolution.receipt.id,
      tokenHash: this.hashToken(token),
      createdAt: nowIso,
      expiresAt,
      revokedAt: null,
    };

    receiptStore.createAccessToken(entry);
    this.appendLifecycleLog(
      'receipt_token_minted',
      'Receipt access token minted.',
      {
        transactionId: resolution.receipt.transactionId,
        receiptId: resolution.receipt.id,
        tokenId: entry.id,
        expiresAt: entry.expiresAt,
        revokedExisting: options.revokeExisting === true,
        revokedTokenCount,
      },
    );
    return {
      token,
      tokenId: entry.id,
      transactionId: resolution.receipt.transactionId,
      receiptId: resolution.receipt.id,
      expiresAt: entry.expiresAt,
    };
  }

  resolveByToken(
    tokenRaw: string,
    now = new Date(),
  ): ResolveReceiptByTokenResult {
    const token = tokenRaw.trim();
    if (!token) return { status: 'unknown' };

    const tokenEntry = receiptStore.getAccessTokenByHash(this.hashToken(token));
    if (!tokenEntry) return { status: 'unknown' };
    if (tokenEntry.revokedAt) return { status: 'revoked' };

    const nowMs = now.getTime();
    if (isExpired(tokenEntry.expiresAt, nowMs)) return { status: 'expired' };

    const receipt = receiptStore.getReceiptById(tokenEntry.receiptId);
    if (!receipt) return { status: 'unknown' };
    if (isExpired(receipt.expiresAt, nowMs)) return { status: 'expired' };

    return {
      status: 'ok',
      receipt,
      accessToken: tokenEntry,
      payload: this.toPayload(receipt, now),
    };
  }

  resolveByTransactionId(
    transactionIdRaw: string,
    now = new Date(),
  ): ResolveReceiptByTransactionResult {
    const transactionId = transactionIdRaw.trim();
    if (!transactionId) return { status: 'not_found' };

    const receipt = receiptStore.getReceiptByTransactionId(transactionId);
    if (!receipt) return { status: 'not_found' };
    if (isExpired(receipt.expiresAt, now.getTime()))
      return { status: 'expired' };

    return { status: 'ok', receipt, payload: this.toPayload(receipt, now) };
  }

  updateTerminalStatus(
    input: ReceiptTerminalUpdateInput,
    now = new Date(),
  ): ReceiptRecordEntry | null {
    const transactionId = input.transactionId.trim();
    if (!transactionId) return null;

    const existing = receiptStore.getReceiptByTransactionId(transactionId);
    if (!existing) return null;

    const nowIso = now.toISOString();
    const previousStatus = existing.status;
    const entry: ReceiptRecordEntry = {
      ...existing,
      status: input.status,
      terminalAt: normalizeIsoTimestamp(input.terminalAt, nowIso),
      updatedAt: nowIso,
    };

    receiptStore.upsertReceiptRecord(entry);
    if (previousStatus !== entry.status) {
      this.appendLifecycleLog(
        'receipt_terminal_status_updated',
        'Receipt terminal status updated.',
        {
          transactionId: entry.transactionId,
          receiptId: entry.id,
          mode: entry.mode,
          previousStatus,
          status: entry.status,
          terminalAt: entry.terminalAt,
        },
      );
    }
    return entry;
  }

  cleanupExpired(now = new Date()): ReceiptCleanupResult {
    return receiptStore.cleanupExpired(now);
  }

  cleanupExpiredTokens(now = new Date()): number {
    return receiptStore.cleanupExpiredAccessTokens(now);
  }

  cleanupExpiredRecords(now = new Date()): number {
    return receiptStore.cleanupExpiredReceiptRecords(now);
  }

  private toPayload(record: ReceiptRecordEntry, now: Date): ReceiptPayload {
    const remaining = Math.max(
      0,
      record.change.requested - record.change.dispensed,
    );

    const lifecycle = getSpoolerLifecycleRecord(record.transactionId);

    return {
      transactionId: record.transactionId,
      mode: record.mode,
      chargedAmount: record.chargedAmount,
      colorPages: record.colorPages ?? null,
      bwPages: record.bwPages ?? null,
      pagesPrinted: lifecycle?.pagesPrinted ?? null,
      totalPages: lifecycle?.totalPages ?? null,
      coinsInserted: record.details?.coinsInserted ?? null,
      documentName: record.details?.documentName ?? null,
      printConfiguration:
        record.details?.printConfiguration ?? this.emptyPrintConfiguration(),
      status: record.status,
      change: {
        requested: record.change.requested,
        dispensed: record.change.dispensed,
        remaining,
        state: record.change.state,
        attempts: record.change.attempts,
        owedChangeId: record.change.owedChangeId,
        message: record.change.message,
      },
      settledAt: record.settledAt,
      terminalAt: record.terminalAt,
      generatedAt: now.toISOString(),
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private resolveExpiryTimestamp(
    requestedExpiryIso: string | undefined,
    existingExpiryIso: string | undefined,
    now: Date,
  ): string {
    const requestedMs =
      typeof requestedExpiryIso === 'string'
        ? parseTimestampMs(requestedExpiryIso)
        : null;
    if (requestedMs !== null) return new Date(requestedMs).toISOString();

    const existingMs =
      typeof existingExpiryIso === 'string'
        ? parseTimestampMs(existingExpiryIso)
        : null;
    if (existingMs !== null) return new Date(existingMs).toISOString();

    return new Date(now.getTime() + RECEIPT_RETENTION_MS).toISOString();
  }

  private normalizeChargedAmount(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, value);
  }

  private normalizeChangeState(value: string): ReceiptChangeState {
    if (value === 'dispensed' || value === 'failed' || value === 'none') {
      return value;
    }
    return 'none';
  }

  private normalizeChangeAmount(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
  }

  private normalizeChangeSnapshot(
    input: Partial<ReceiptChangeSnapshot> | undefined,
    existing: ReceiptChangeSnapshot | undefined,
  ): ReceiptChangeSnapshot {
    const requested = this.normalizeChangeAmount(
      input?.requested ?? existing?.requested ?? 0,
    );
    const dispensedRaw = this.normalizeChangeAmount(
      input?.dispensed ?? existing?.dispensed ?? 0,
    );
    const dispensed = Math.min(dispensedRaw, requested);
    const attempts = this.normalizeChangeAmount(
      input?.attempts ?? existing?.attempts ?? 0,
    );
    const state = this.normalizeChangeState(
      input?.state ?? existing?.state ?? 'none',
    );
    const owedChangeId =
      typeof input?.owedChangeId === 'string' &&
      input.owedChangeId.trim().length > 0
        ? input.owedChangeId.trim()
        : typeof existing?.owedChangeId === 'string' &&
            existing.owedChangeId.trim().length > 0
          ? existing.owedChangeId.trim()
          : null;
    const message =
      typeof input?.message === 'string' && input.message.trim().length > 0
        ? input.message.trim()
        : typeof existing?.message === 'string' && existing.message.trim().length > 0
          ? existing.message.trim()
          : null;

    return {
      requested,
      dispensed,
      state,
      attempts,
      owedChangeId: state === 'failed' ? owedChangeId : null,
      message: state === 'failed' ? message : null,
    };
  }

  private normalizeDetailsSnapshot(
    input: ReceiptSnapshotInput,
    existing: ReceiptDetailsSnapshot | undefined,
  ): ReceiptDetailsSnapshot {
    const configuration = input.printConfiguration;
    const previousConfiguration =
      existing?.printConfiguration ?? this.emptyPrintConfiguration();

    return {
      coinsInserted:
        typeof input.coinsInserted === 'number'
          ? this.normalizeChargedAmount(input.coinsInserted)
          : existing?.coinsInserted ?? null,
      documentName:
        typeof input.documentName === 'string'
          ? this.normalizeDocumentName(input.documentName)
          : existing?.documentName ?? null,
      printConfiguration: {
        copies:
          typeof configuration?.copies === 'number' &&
          Number.isFinite(configuration.copies)
            ? Math.min(30, Math.max(1, Math.floor(configuration.copies)))
            : previousConfiguration.copies,
        colorMode:
          configuration?.colorMode === 'colored' ||
          configuration?.colorMode === 'grayscale'
            ? configuration.colorMode
            : previousConfiguration.colorMode,
        paperSize:
          configuration?.paperSize === 'A4' ||
          configuration?.paperSize === 'Short' ||
          configuration?.paperSize === 'Long'
            ? configuration.paperSize
            : previousConfiguration.paperSize,
        quality:
          configuration?.quality === 'standard' ||
          configuration?.quality === 'high'
            ? configuration.quality
            : previousConfiguration.quality,
        duplex:
          typeof configuration?.duplex === 'boolean'
            ? configuration.duplex
            : previousConfiguration.duplex,
        orientation:
          configuration?.orientation === 'portrait' ||
          configuration?.orientation === 'landscape'
            ? configuration.orientation
            : previousConfiguration.orientation,
        pageRange:
          typeof configuration?.pageRange === 'string'
            ? this.normalizeDisplayText(configuration.pageRange, 80)
            : previousConfiguration.pageRange,
      },
    };
  }

  private emptyPrintConfiguration(): ReceiptPrintConfigurationSnapshot {
    return {
      copies: null,
      colorMode: null,
      paperSize: null,
      quality: null,
      duplex: null,
      orientation: null,
      pageRange: null,
    };
  }

  private normalizeDocumentName(value: string): string | null {
    const leafName = value.replace(/\\/g, '/').split('/').pop() ?? '';
    return this.normalizeDisplayText(leafName, 180);
  }

  private normalizeDisplayText(value: string, maxLength: number): string | null {
    const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  private appendLifecycleLog(
    type: string,
    message: string,
    meta: LogMeta,
  ): void {
    void adminService.appendAdminLog(type, message, meta).catch((error) => {
      console.error('[RECEIPT] Failed to append lifecycle admin log.', {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
