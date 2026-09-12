import type { Request, Response } from 'express';
import {
  coinSimulation,
  CoinSimulationError,
} from '@/services/coin-simulation';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Server } from 'socket.io';
import {
  db,
  type Schema,
  type FinancialLedgerEntry,
  type ReceiptRecordStatus,
  type SpoolerLifecycleState,
  acquireIdempotencyKey,
  storeIdempotencyKey,
  releaseIdempotencyKey,
} from '@/services/db';
import {
  evaluateInkPreflight,
  getPrinterTelemetry,
  refreshPrinterTelemetry,
} from '@/services/printer-state-projection';
import {
  isCoinSlotLocked,
  isCoinSlotLockedBy,
  getCoinSlotLockOwnerId,
} from '@/services/hardware-state-projection';
import {
  powerSafetyService,
  type PowerSafetyService,
} from '@/services/power-safety';
import {
  ESP32_COIN_BRIDGE_API_KEY,
  ESP32_COIN_BRIDGE_RELAXED_MODE,
  ESP32_COIN_BRIDGE_SOURCE,
  ESP32_ALWAYS_ACCEPT_COINS,
  PRINT_SPOOLER_MONITOR_WINDOW_MS,
} from '@/config/http.config';
import {
  getSqliteDb,
  consumablesStore,
  readRuntimeState,
  writeRuntimeState,
} from '@/core/database/sqlite-storage';
import { adminService } from '@/services/admin';
import { financialLedgerService } from '@/services/financial-ledger';
import { settlementService } from '@/services/settlement';
import {
  printFile,
  type PrintDispatchResult,
  type PrintJobOptions,
} from '@/services/printer';
import { withPrintQuality } from '@/services/print-job-options';
import { persistAndEmitPrintLifecycleState } from '@/services/print-lifecycle-state';
import type { SessionStore, UploadedDocument } from '@/services/session';
import { buildPrintQuote } from '@/services/print-quote';
import { BLOCKED_STATUSES } from '@/utils';
import {
  checkpointRecoverySession,
  getSpoolerLifecycleRecord,
  reconcileFinalizedCopySession,
} from '@/services/recovery';
import {
  assertTrustedTimeForFinancialOperation,
  getTrustedTimeStatus,
  getTrustedTimestamp,
  isTrustedTimeError,
} from '@/services/time-source';
import { promoteStagedUpload } from '@/services/upload-staging';
import {
  PendingRefundServiceError,
  upsertSpoolerFailureRefund,
} from '@/services/pending-refund';
import { evaluateConsumablesForecastAlerts } from '@/modules/admin/consumables.service';
import { PrintDispatchError } from '@/services/printer';
import {
  normalizeRotationDeg,
  parseRotationDeg,
} from '@/services/document-rotation';
import { ReceiptService } from '@/modules/receipt/receipt.service';
import { estimateInkUsageByJob } from '@/services/consumable-estimator';
import {
  buildPrintJobEnqueuePayload,
  getJobProcessor,
  enqueuePrintJob,
  PrintJobEnqueueError,
} from '@/modules/print-queue';

export interface FinancialServiceDeps {
  io: Server;
  sessionStore: SessionStore;
  resolvePublicBaseUrl: (req: Request) => URL;
  powerSafetyService?: PowerSafetyService;
}

interface UploadDeletionResult {
  deleted: boolean;
  alreadyMissing: boolean;
  filePath: string;
  error: string | null;
}

interface ConfirmPaymentBody {
  amount?: number;
  mode?: 'print' | 'copy';
  sessionId?: string;
  documentId?: string;
  spoolerCorrelationKey?: string;
  copies?: number;
  colorMode?: 'colored' | 'grayscale';
  quality?: 'standard' | 'high';
  orientation?: 'portrait' | 'landscape';
  rotationDeg?: number;
  paperSize?: 'A4' | 'Letter' | 'Legal';
  pageRange?: unknown;
  duplex?: boolean;
}

const LEGACY_UPLOAD_STAGING_DIR = path.resolve('uploads/staging/legacy');
const ACCEPTED_COIN_VALUES = new Set([1, 5, 10, 20]);
type CoinSource = 'test-ui' | 'esp32-http';
const COIN_TELEMETRY_MAX_AGE_MS = 45_000;
const COIN_BRIDGE_EVENTS_TABLE = 'coin_bridge_events';

class CoinCreditRejectedError extends Error {
  constructor(
    readonly reason: 'slot_locked' | 'printer_unavailable',
    readonly statusCode: number,
    readonly retryable: boolean,
    readonly details: Record<string, unknown>,
  ) {
    super(reason);
    this.name = 'CoinCreditRejectedError';
  }
}

function serializeLedgerHashPayload(entry: {
  id: string;
  timestamp: string;
  eventType: 'coin_inserted';
  amount: number;
  referenceId: string | null;
  meta: Record<string, string | number | boolean | null>;
  previousHash: string | null;
}): string {
  return JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    eventType: entry.eventType,
    amount: entry.amount,
    referenceId: entry.referenceId,
    meta: entry.meta,
    previousHash: entry.previousHash,
  });
}

function computeLedgerHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function buildTrustedTimeBlockedResponse(error: unknown): {
  code: 'TRUSTED_TIME_UNAVAILABLE';
  error: string;
  trustedTime?: Record<string, unknown>;
} {
  if (!isTrustedTimeError(error)) {
    return {
      code: 'TRUSTED_TIME_UNAVAILABLE',
      error:
        'Financial operations are temporarily unavailable because trusted time is not synchronized.',
    };
  }
  return {
    code: error.code,
    error: `Financial operations are temporarily unavailable: ${error.trustedTime.detail}`,
    trustedTime: {
      operation: error.operation,
      source: error.trustedTime.source,
      synced: error.trustedTime.synced,
      offsetMs: error.trustedTime.offsetMs,
      driftExceeded: error.trustedTime.driftExceeded,
      maxDriftMs: error.trustedTime.maxDriftMs,
      detail: error.trustedTime.detail,
      checkedAt: error.trustedTime.checkedAt,
      ntpSource: error.trustedTime.ntpSource,
    },
  };
}

function getSessionDocuments(session: {
  documents?: UploadedDocument[];
  document?: UploadedDocument;
}): UploadedDocument[] {
  return session.documents && session.documents.length > 0
    ? session.documents
    : session.document
      ? [session.document]
      : [];
}

function resolveTargetDocument(
  session: { documents?: UploadedDocument[]; document?: UploadedDocument },
  documentId?: string,
): UploadedDocument | null {
  const allDocs = getSessionDocuments(session);
  if (allDocs.length === 0) return null;

  if (!documentId) return allDocs[allDocs.length - 1];
  return allDocs.find((doc) => doc.documentId === documentId) ?? null;
}

function buildAnalysisUnavailablePayload(target: UploadedDocument): {
  code: 'ANALYSIS_PENDING' | 'ANALYSIS_FAILED' | 'ANALYSIS_UNAVAILABLE';
  error: string;
} {
  if (target.analysisStatus === 'pending') {
    return {
      code: 'ANALYSIS_PENDING',
      error:
        'Document analysis is still in progress. Please wait and try again.',
    };
  }

  if (target.analysisStatus === 'failed') {
    return {
      code: 'ANALYSIS_FAILED',
      error:
        'Document analysis failed for this file. Retry analysis or re-upload and try again.',
    };
  }

  return {
    code: 'ANALYSIS_UNAVAILABLE',
    error:
      'Document analysis is unavailable. Re-upload the file and try again.',
  };
}

async function persistLegacyUploadWithStaging(
  file: Express.Multer.File,
  storedFilename: string,
): Promise<string> {
  const uploadsDir = path.resolve('uploads');
  const finalPath = path.resolve(uploadsDir, storedFilename);

  if (file.path) {
    return await promoteStagedUpload(file, finalPath);
  }

  if (file.buffer) {
    await fs.promises.mkdir(uploadsDir, { recursive: true });
    await fs.promises.writeFile(finalPath, file.buffer);
    return finalPath;
  }

  throw new Error('Uploaded file is missing disk path and in-memory buffer.');
}

async function deleteUploadByStoredFilename(
  storedFilename: string,
): Promise<UploadDeletionResult> {
  const uploadsDir = path.resolve('uploads');
  const normalizedFilename = storedFilename.trim();
  if (!normalizedFilename) {
    return {
      deleted: false,
      alreadyMissing: false,
      filePath: '',
      error: 'Invalid filename',
    };
  }

  const filePath = path.resolve(uploadsDir, normalizedFilename);
  const relativePath = path.relative(uploadsDir, filePath);
  const outsideUploads =
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);
  if (outsideUploads) {
    return {
      deleted: false,
      alreadyMissing: false,
      filePath,
      error: 'Invalid filename',
    };
  }

  try {
    await fs.promises.unlink(filePath);
    return {
      deleted: true,
      alreadyMissing: false,
      filePath,
      error: null,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return {
        deleted: true,
        alreadyMissing: true,
        filePath,
        error: null,
      };
    }
    return {
      deleted: false,
      alreadyMissing: false,
      filePath,
      error: err.message,
    };
  }
}

export class FinancialService {
  private readonly receiptService = new ReceiptService();
  private readonly powerSafety: PowerSafetyService;

  constructor(private readonly deps: FinancialServiceDeps) {
    this.powerSafety = deps.powerSafetyService ?? powerSafetyService;
  }

  private incrementCoinStats(state: Schema, coinValue: number): void {
    switch (coinValue) {
      case 1:
        state.coinStats.one += 1;
        break;
      case 5:
        state.coinStats.five += 1;
        break;
      case 10:
        state.coinStats.ten += 1;
        break;
      case 20:
        state.coinStats.twenty += 1;
        break;
      default:
        break;
    }
  }

  private buildCoinLedgerEntry(
    state: Schema,
    coinValue: number,
    source: CoinSource,
  ): FinancialLedgerEntry {
    const trusted = getTrustedTimestamp();
    const id = randomUUID();
    const previous = state.financialLedger[0] ?? null;
    const previousHash = previous?.hash ?? null;
    const amount = Number.isFinite(coinValue)
      ? Number(coinValue.toFixed(2))
      : 0;
    const meta = {
      source,
      balance: state.balance,
    };
    const hashPayload = serializeLedgerHashPayload({
      id,
      timestamp: trusted.timestamp,
      eventType: 'coin_inserted',
      amount,
      referenceId: null,
      meta,
      previousHash,
    });

    return {
      id,
      timestamp: trusted.timestamp,
      timestampMeta: trusted.meta,
      eventType: 'coin_inserted',
      amount,
      referenceId: null,
      meta,
      previousHash,
      hash: computeLedgerHash(hashPayload),
    };
  }

  private ensureCoinBridgeEventsTable(sqliteDb: DatabaseSync): void {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS ${COIN_BRIDGE_EVENTS_TABLE} (
        event_id TEXT PRIMARY KEY,
        coin_value INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        processed_at TEXT NOT NULL
      );
    `);
  }

  private async creditCoinBalance(
    coinValue: number,
    source: CoinSource,
    eventId?: string,
  ): Promise<number> {
    if (
      isCoinSlotLockedBy('power-safety') ||
      !this.powerSafety.canAcceptCustomerWork()
    ) {
      throw new CoinCreditRejectedError('slot_locked', 503, false, {
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
    }

    const trustedTime = getTrustedTimeStatus();
    if (
      trustedTime.enforceForFinancial &&
      (!trustedTime.synced ||
        trustedTime.offsetMs === null ||
        trustedTime.driftExceeded)
    ) {
      void adminService.appendAdminLog(
        'coin_accepted_trusted_time_unsynced',
        `${source === 'esp32-http' ? 'ESP32' : 'Test'} coin accepted while trusted time is unsynchronized.`,
        {
          source,
          coinValue,
          detail: trustedTime.detail,
          offsetMs: trustedTime.offsetMs,
          driftExceeded: trustedTime.driftExceeded,
          checkedAt: trustedTime.checkedAt,
        },
      );
    }

    const sqliteDb = getSqliteDb();
    const normalizedEventId = eventId?.trim() ?? '';
    const shouldPersistBridgeEvent =
      source === 'esp32-http' && normalizedEventId.length > 0;
    if (shouldPersistBridgeEvent) {
      this.ensureCoinBridgeEventsTable(sqliteDb);
    }

    let balanceAfterCredit: number;
    let nextRuntimeState: Schema;
    sqliteDb.exec('BEGIN IMMEDIATE');
    try {
      if (shouldPersistBridgeEvent) {
        const existing = sqliteDb
          .prepare(
            `SELECT balance_after AS balanceAfter FROM ${COIN_BRIDGE_EVENTS_TABLE} WHERE event_id = ? LIMIT 1`,
          )
          .get(normalizedEventId) as { balanceAfter: number } | undefined;
        if (existing) {
          sqliteDb.exec('COMMIT');
          return Number(existing.balanceAfter);
        }
      }

      const runtimeState = readRuntimeState<Schema>() ?? db.data;
      if (!runtimeState) {
        throw new Error('Runtime state unavailable while crediting coin.');
      }
      nextRuntimeState = structuredClone(runtimeState);
      this.incrementCoinStats(nextRuntimeState, coinValue);
      nextRuntimeState.balance += coinValue;
      balanceAfterCredit = nextRuntimeState.balance;
      const ledgerEntry = this.buildCoinLedgerEntry(
        nextRuntimeState,
        coinValue,
        source,
      );
      nextRuntimeState.financialLedger.unshift(ledgerEntry);
      writeRuntimeState(nextRuntimeState);

      if (shouldPersistBridgeEvent) {
        sqliteDb
          .prepare(
            `INSERT INTO ${COIN_BRIDGE_EVENTS_TABLE} (event_id, coin_value, balance_after, processed_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(
            normalizedEventId,
            coinValue,
            balanceAfterCredit,
            new Date().toISOString(),
          );
      }

      sqliteDb.exec('COMMIT');
    } catch (error) {
      sqliteDb.exec('ROLLBACK');
      throw error;
    }
    db.data = nextRuntimeState;

    await adminService.appendAdminLog(
      'coin_accepted',
      `${source === 'esp32-http' ? 'ESP32 bridge' : 'Test'} coin inserted: ${coinValue}`,
      {
        coinValue,
        balance: balanceAfterCredit,
        source,
      },
    );
    this.deps.io.emit('balance', balanceAfterCredit);
    this.deps.io.emit('coinAccepted', {
      value: coinValue,
      balance: balanceAfterCredit,
    });

    return balanceAfterCredit;
  }

  getBalance = (_req: Request, res: Response): void => {
    res.json({
      balance: db.data?.balance ?? 0,
      earnings: db.data?.earnings ?? 0,
    });
  };

  getPricing = (_req: Request, res: Response): void => {
    res.json(adminService.getPricingSettings());
  };

  getPricingConfig = (_req: Request, res: Response): void => {
    const config = db.data?.settings?.pricingEngine;
    res.json({
      paperProfiles: config?.paperProfiles ?? {
        a4: { baseBwPrice: 3, baseColorPrice: 18 },
        shortBond: { baseBwPrice: 3, baseColorPrice: 18 },
        longBond: { baseBwPrice: 4, baseColorPrice: 20 },
      },
      highQualitySurcharge:
        config?.highQualitySurcharge ??
        db.data?.settings?.pricing?.highQualitySurcharge ??
        2,
      bulkDiscountTiers: config?.bulkDiscountTiers ?? [],
      rounding: config?.rounding ?? 'whole_peso_total_only',
    });
  };

  addCoinCompatibility = async (
    req: Request,
    res: Response,
  ): Promise<Response | void> => {
    const {
      value,
      eventId: queryEventId,
      source: querySource,
      apiKey: queryApiKey,
    } = req.query as {
      value?: string | string[];
      eventId?: string | string[];
      source?: string | string[];
      apiKey?: string | string[];
    };
    const rawValue = Array.isArray(value) ? value[0] : value;
    const coinValue = rawValue !== undefined ? Number(rawValue) : Number.NaN;

    if (!Number.isInteger(coinValue) || !ACCEPTED_COIN_VALUES.has(coinValue)) {
      await adminService.appendAdminLog(
        'coin_rejected_invalid_value',
        'ESP32 /coin rejected due to invalid value.',
        {
          source: 'esp32-http',
          value: rawValue ?? null,
        },
      );
      return res
        .status(400)
        .json({ error: 'Invalid coin value. Accepted: 1, 5, 10, 20' });
    }

    const queryEventIdRaw = Array.isArray(queryEventId)
      ? queryEventId[0]
      : queryEventId;
    let eventId = (req.get('x-coin-event-id') ?? queryEventIdRaw ?? '').trim();
    if (!eventId && !ESP32_COIN_BRIDGE_RELAXED_MODE) {
      await adminService.appendAdminLog(
        'coin_rejected_missing_event_id',
        'ESP32 /coin rejected due to missing event ID.',
        {
          source: 'esp32-http',
          coinValue,
        },
      );
      return res.status(400).json({ error: 'Missing coin event ID' });
    }
    if (!eventId) {
      eventId = `sim-${randomUUID()}`;
      await adminService.appendAdminLog(
        'coin_relaxed_mode_event_id_generated',
        'ESP32 /coin accepted in relaxed mode with generated event ID.',
        {
          source: 'esp32-http',
          coinValue,
          generatedEventId: eventId,
        },
      );
    }

    const querySourceRaw = Array.isArray(querySource)
      ? querySource[0]
      : querySource;
    const source = (req.get('x-coin-source') ?? querySourceRaw ?? '').trim();
    if (
      !ESP32_COIN_BRIDGE_RELAXED_MODE &&
      source !== ESP32_COIN_BRIDGE_SOURCE
    ) {
      await adminService.appendAdminLog(
        'coin_rejected_invalid_source',
        'ESP32 /coin rejected due to invalid source.',
        {
          source: source || null,
          expectedSource: ESP32_COIN_BRIDGE_SOURCE,
          coinValue,
        },
      );
      return res.status(403).json({ error: 'Invalid coin source' });
    }
    const normalizedSource =
      source.length > 0 ? source : ESP32_COIN_BRIDGE_SOURCE;

    if (!ESP32_COIN_BRIDGE_RELAXED_MODE && queryApiKey !== undefined) {
      await adminService.appendAdminLog(
        'coin_rejected_api_key_in_query',
        'ESP32 /coin rejected because API key was sent in query string.',
        {
          source: normalizedSource,
          coinValue,
          eventId,
        },
      );
      return res.status(400).json({
        error: 'API key must be sent via x-coin-api-key header',
      });
    }

    const apiKey = (req.get('x-coin-api-key') ?? '').trim();
    if (
      !ESP32_COIN_BRIDGE_RELAXED_MODE &&
      (!apiKey || apiKey !== ESP32_COIN_BRIDGE_API_KEY)
    ) {
      await adminService.appendAdminLog(
        'coin_rejected_auth_failed',
        'ESP32 /coin rejected due to invalid API key.',
        {
          source: normalizedSource,
          coinValue,
        },
      );
      return res.status(403).json({ error: 'Unauthorized coin source' });
    }
    if (ESP32_COIN_BRIDGE_RELAXED_MODE) {
      await adminService.appendAdminLog(
        'coin_relaxed_mode_accept',
        'ESP32 /coin accepted in relaxed compatibility mode.',
        {
          source: normalizedSource,
          coinValue,
          eventId,
        },
      );
    }

    if (
      isCoinSlotLockedBy('power-safety') ||
      !this.powerSafety.canAcceptCustomerWork()
    ) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        error: 'Coin rejected',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    const namespace = 'GET:/coin';
    const idempotencyClaim = acquireIdempotencyKey(eventId, namespace);
    if (idempotencyClaim.type === 'hit') {
      res.status(200).json(idempotencyClaim.entry.response);
      return;
    }
    if (idempotencyClaim.type === 'inflight') {
      const entry = await idempotencyClaim.promise;
      if (entry) {
        res.status(entry.statusCode).json(entry.response);
      } else {
        res
          .status(503)
          .json({ error: 'Concurrent request failed. Please retry.' });
      }
      return;
    }

    try {
      const balance = await this.creditCoinBalance(
        coinValue,
        'esp32-http',
        eventId,
      );
      const payload = {
        ok: true,
        coinValue,
        balance,
      };
      storeIdempotencyKey(eventId, namespace, 200, payload);
      res.status(200).json(payload);
    } catch (error) {
      releaseIdempotencyKey(eventId, namespace);
      if (error instanceof CoinCreditRejectedError) {
        res.status(error.statusCode).json({
          error: 'Coin rejected',
          reason: error.reason,
          retryable: error.retryable,
          details: error.details,
        });
        return;
      }
      await adminService.appendAdminLog(
        'coin_processing_failed',
        'ESP32 /coin failed due to an unexpected server error.',
        {
          source: normalizedSource,
          coinValue,
          eventId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      res.status(500).json({ error: 'Failed to process coin event' });
    }
  };

  getPrintQuote = (req: Request, res: Response): Response => {
    const { sessionId, documentId } = req.body as {
      sessionId?: string;
      documentId?: string;
      copies?: number;
      colorMode?: 'colored' | 'grayscale';
      pageRange?: unknown;
      duplex?: boolean;
    };

    if (!sessionId) {
      return res.status(400).json({ error: 'Print session is required' });
    }

    const sessionState = this.deps.sessionStore.getSessionState(sessionId);
    if (sessionState === 'expired') {
      return res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new upload session.',
      });
    }
    if (sessionState === 'missing') {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = this.deps.sessionStore.tryGetSession(
      sessionId,
      this.deps.resolvePublicBaseUrl(req),
    );
    if (!session) {
      return res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new upload session.',
      });
    }
    this.deps.sessionStore.touchSession(sessionId);

    const target = resolveTargetDocument(session, documentId);
    if (!target) {
      return res.status(400).json({
        error: documentId
          ? `Document "${documentId}" not found in session`
          : 'No uploaded document found for this session',
      });
    }

    if (!target.analysis) {
      return res.status(409).json(buildAnalysisUnavailablePayload(target));
    }

    const safeCopies =
      typeof req.body?.copies === 'number' && Number.isFinite(req.body.copies)
        ? Math.max(1, Math.floor(req.body.copies))
        : 1;
    const requestedColorMode =
      req.body?.colorMode === 'colored' || req.body?.colorMode === 'grayscale'
        ? req.body.colorMode
        : 'grayscale';
    const requestedQuality: 'standard' | 'high' =
      req.body?.quality === 'high' ? 'high' : 'standard';
    const duplex = req.body?.duplex === true;
    const requestedPaperSize: 'A4' | 'Letter' | 'Legal' =
      req.body?.paperSize === 'Legal'
        ? 'Legal'
        : req.body?.paperSize === 'Letter'
          ? 'Letter'
          : 'A4';

    const quoteComputation = buildPrintQuote({
      analysis: target.analysis,
      copies: safeCopies,
      colorMode: requestedColorMode,
      quality: requestedQuality,
      paperSize: requestedPaperSize,
      pageRange: req.body?.pageRange,
      duplex,
    });
    if (!quoteComputation.ok) {
      return res.status(400).json({ error: quoteComputation.error });
    }

    return res.json({
      ok: true,
      sessionId,
      documentId: target.documentId,
      filename: target.filename,
      quote: quoteComputation.quote,
    });
  };

  getTransactionReceipt = (req: Request, res: Response): Response => {
    const transactionId = String(req.params.transactionId ?? '').trim();
    if (!transactionId) {
      return res.status(400).json({ error: 'transactionId is required.' });
    }

    const result = this.receiptService.resolveByTransactionId(transactionId);
    if (result.status !== 'ok') {
      if (result.status === 'expired') {
        return res.status(410).json({ error: 'Receipt has expired.' });
      }
      return res.status(404).json({ error: 'Receipt not found.' });
    }

    return res.json(result.payload);
  };

  resetBalance = async (_req: Request, res: Response): Promise<void> => {
    const previousBalance = db.data!.balance;
    db.data!.balance = 0;
    await db.write();
    writeRuntimeState(db.data);
    this.deps.io.emit('balance', 0);
    await adminService.appendAdminLog(
      'balance_reset',
      'Balance reset from admin/testing.',
      {
        previousBalance,
        newBalance: 0,
      },
    );

    res.json({
      ok: true,
      balance: db.data!.balance,
      earnings: db.data!.earnings,
    });
  };

  addTestCoin = async (
    req: Request,
    res: Response,
  ): Promise<Response | void> => {
    const { value } = req.body as { value?: unknown };
    const coinValue =
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    if (coinValue === null || !ACCEPTED_COIN_VALUES.has(coinValue)) {
      return res
        .status(400)
        .json({ error: 'Invalid coin value. Accepted: 1, 5, 10, 20' });
    }
    let balance: number;
    try {
      if (
        isCoinSlotLockedBy('power-safety') ||
        !this.powerSafety.canAcceptCustomerWork()
      ) {
        throw new CoinSimulationError(
          409,
          'power_emergency',
          'Power emergency active; coin simulation suspended.',
        );
      }
      balance = await coinSimulation.insert(coinValue);
    } catch (error) {
      if (error instanceof CoinSimulationError) {
        return res.status(error.statusCode).json({
          error: 'Coin simulation failed',
          reason: error.reason,
          details: error.message,
        });
      }
      if (error instanceof CoinCreditRejectedError) {
        return res.status(error.statusCode).json({
          error: 'Coin rejected',
          reason: error.reason,
          retryable: error.retryable,
          details: error.details,
        });
      }
      await adminService.appendAdminLog(
        'coin_processing_failed',
        'Test coin failed due to an unexpected server error.',
        {
          source: 'test-ui',
          coinValue,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return res.status(500).json({ error: 'Failed to process test coin' });
    }

    res.json({
      ok: true,
      coinValue,
      balance,
    });
  };

  uploadLegacy = async (
    req: Request,
    res: Response,
  ): Promise<Response | void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      return res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
    }

    if (!req.file) {
      await adminService.appendAdminLog(
        'upload_failed',
        'Upload failed: no file provided.',
      );
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const safeFilename = `${randomUUID()}${path.extname(req.file.originalname).toLowerCase()}`;

    try {
      await persistLegacyUploadWithStaging(req.file, safeFilename);
    } catch (error) {
      await adminService.appendAdminLog(
        'upload_failed',
        'Upload failed while persisting validated file.',
        {
          filename: req.file.originalname,
          sizeBytes: req.file.size,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return res.status(500).json({ error: 'Failed to store uploaded file.' });
    }

    await adminService.appendAdminLog(
      'upload_completed',
      'Upload completed via /upload.',
      {
        filename: req.file.originalname,
        storedFilename: safeFilename,
        sizeBytes: req.file.size,
      },
    );
    res.status(200).json({ filename: safeFilename });
  };

  printLegacy = async (
    req: Request,
    res: Response,
  ): Promise<Response | void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      return res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
    }

    const { filename } = req.body as { filename?: string };

    if (!filename) {
      void adminService.appendAdminLog(
        'print_failed',
        'Legacy print failed: filename missing.',
      );
      return res.status(400).json({ error: 'Filename is required' });
    }
    try {
      assertTrustedTimeForFinancialOperation('legacy_print');
    } catch (error) {
      const payload = buildTrustedTimeBlockedResponse(error);
      void adminService.appendAdminLog(
        'trusted_time_unsynced',
        'Legacy print blocked because trusted time is unavailable.',
        {
          source: 'legacy-print',
          filename,
          detail: payload.error,
        },
      );
      return res.status(503).json(payload);
    }

    const minimumAmount = adminService.calculateJobAmount(
      'print',
      'grayscale',
      1,
    );
    if ((db.data?.balance ?? 0) < minimumAmount) {
      void adminService.appendAdminLog(
        'print_failed',
        'Legacy print failed: insufficient balance.',
        { balance: db.data?.balance ?? 0, required: minimumAmount },
      );
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const defaultOptions: PrintJobOptions = {
      copies: 1,
      colorMode: 'grayscale',
      orientation: 'portrait',
      rotationDeg: 0,
      paperSize: 'A4',
    };

    const legacyTelemetry = await refreshPrinterTelemetry();
    if (
      !legacyTelemetry.connected ||
      BLOCKED_STATUSES.has(legacyTelemetry.status)
    ) {
      void adminService.appendAdminLog(
        'print_preflight_failed',
        'Legacy print rejected: printer not ready.',
        {
          filename,
          printerStatus: legacyTelemetry.status,
          printerConnected: legacyTelemetry.connected,
        },
      );
      return res.status(409).json({
        error: `Printer is not ready: ${legacyTelemetry.status}. Please notify the operator.`,
        printerStatus: legacyTelemetry.status,
      });
    }

    const legacyInkPreflight = evaluateInkPreflight(legacyTelemetry);
    if (legacyInkPreflight.blocked) {
      void adminService.appendAdminLog(
        'print_preflight_failed_ink',
        'Legacy print rejected: ink preflight policy blocked the job.',
        {
          filename,
          printerStatus: legacyTelemetry.status,
          inkCode: legacyInkPreflight.code,
          inkReason: legacyInkPreflight.reason ?? 'Unknown ink policy reason',
          telemetryAvailable: legacyInkPreflight.telemetryAvailable,
          inkDetectionMethod: legacyTelemetry.inkDetectionMethod,
        },
      );
      return res.status(409).json({
        error:
          legacyInkPreflight.reason ??
          'Printer ink state is not ready for printing.',
        printerStatus: legacyTelemetry.status,
        inkStatus: legacyInkPreflight.code,
        inkReason: legacyInkPreflight.reason,
        telemetryAvailable: legacyInkPreflight.telemetryAvailable,
      });
    }

    try {
      await printFile(
        filename,
        {
          ...defaultOptions,
          printerName: legacyTelemetry.name ?? undefined,
        },
        {
          mode: 'legacy-print',
          source: 'legacy-print-route',
        },
      );
    } catch (err) {
      void adminService.appendAdminLog(
        'print_failed',
        'Legacy print failed: printer error.',
        {
          filename,
          error: err instanceof Error ? err.message : 'Unknown error',
        },
      );
      return res.status(500).json({ error: 'Print failed' });
    }

    await financialLedgerService.append({
      eventType: 'job_started',
      amount: minimumAmount,
      referenceId: filename,
      meta: {
        mode: 'print',
        source: 'legacy',
        filename,
      },
    });

    const chargedAmount = db.data!.balance;
    db.data!.earnings += chargedAmount;
    db.data!.balance = 0;
    await db.write();
    await financialLedgerService.append({
      eventType: 'job_completed',
      amount: chargedAmount,
      referenceId: filename,
      meta: {
        mode: 'print',
        source: 'legacy',
        filename,
      },
    });
    await adminService.appendAdminLog(
      'print_completed',
      'Legacy print completed and charged.',
      {
        filename,
        chargedAmount,
      },
    );
    await adminService.incrementJobStats('print');

    const legacyCleanup = await deleteUploadByStoredFilename(filename);
    if (legacyCleanup.deleted) {
      await adminService.appendAdminLog(
        'upload_deleted_after_print',
        'Uploaded file deleted after legacy print.',
        {
          filename,
          filePath: legacyCleanup.filePath || null,
          alreadyMissing: legacyCleanup.alreadyMissing,
          source: 'legacy-print',
        },
      );
    } else {
      await adminService.appendAdminLog(
        'upload_delete_after_print_failed',
        'Failed to delete uploaded file after legacy print.',
        {
          filename,
          filePath: legacyCleanup.filePath || null,
          source: 'legacy-print',
          error: legacyCleanup.error ?? 'Unknown error',
        },
      );
    }

    this.deps.io.emit('balance', 0);
    res.sendStatus(200);
  };

  confirmPayment = async (req: Request, res: Response): Promise<void> => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    const idempotencyKey = req.get('Idempotency-Key') ?? '';
    let idempotencyClaimed = false;
    if (idempotencyKey) {
      const slot = acquireIdempotencyKey(
        idempotencyKey,
        'POST:/api/confirm-payment',
      );
      if (slot.type === 'hit') {
        res.status(slot.entry.statusCode).json(slot.entry.response);
        return;
      }
      if (slot.type === 'inflight') {
        const entry = await slot.promise;
        if (entry) {
          res.status(entry.statusCode).json(entry.response);
        } else {
          res
            .status(503)
            .json({ error: 'Concurrent request failed. Please retry.' });
        }
        return;
      }
      idempotencyClaimed = true;
    }

    const transactionId = randomUUID();

    const sendResponse = (status: number, body: unknown): void => {
      if (idempotencyClaimed) {
        if (status < 500) {
          storeIdempotencyKey(
            idempotencyKey,
            'POST:/api/confirm-payment',
            status,
            body,
          );
        } else {
          releaseIdempotencyKey(idempotencyKey, 'POST:/api/confirm-payment');
        }
      }
      res.status(status).json(body);
    };

    try {
      assertTrustedTimeForFinancialOperation('confirm_payment');
    } catch (error) {
      const payload = buildTrustedTimeBlockedResponse(error);
      void adminService.appendAdminLog(
        'trusted_time_unsynced',
        'Confirm payment blocked because trusted time is unavailable.',
        {
          transactionId,
          detail: payload.error,
        },
      );
      sendResponse(503, payload);
      return;
    }

    const { amount, mode, sessionId, documentId } =
      req.body as ConfirmPaymentBody;
    const spoolerCorrelationKey =
      typeof req.body?.spoolerCorrelationKey === 'string' &&
      req.body.spoolerCorrelationKey.trim()
        ? req.body.spoolerCorrelationKey.trim()
        : null;

    if (mode !== 'print' && mode !== 'copy') {
      void adminService.appendAdminLog(
        'payment_failed',
        'Confirm payment failed: invalid mode.',
        {
          transactionId,
          mode: mode ?? null,
        },
      );
      sendResponse(400, { error: 'Invalid mode' });
      return;
    }

    const copies =
      typeof req.body?.copies === 'number' && Number.isFinite(req.body.copies)
        ? Math.max(1, Math.floor(req.body.copies))
        : 1;
    const colorMode =
      req.body?.colorMode === 'colored' || req.body?.colorMode === 'grayscale'
        ? req.body.colorMode
        : 'grayscale';
    const orientation =
      req.body?.orientation === 'portrait' ||
      req.body?.orientation === 'landscape'
        ? req.body.orientation
        : 'portrait';
    if (
      typeof req.body?.rotationDeg !== 'undefined' &&
      parseRotationDeg(req.body.rotationDeg) === null
    ) {
      sendResponse(400, {
        error: 'Invalid rotation. Accepted values: 0, 90, 180, 270.',
      });
      return;
    }
    const rotationDeg = normalizeRotationDeg(req.body?.rotationDeg, 0);
    const paperSize: 'A4' | 'Letter' | 'Legal' =
      req.body?.paperSize === 'Legal'
        ? 'Legal'
        : req.body?.paperSize === 'Letter'
          ? 'Letter'
          : 'A4';
    const quality: 'standard' | 'high' =
      req.body?.quality === 'high' ? 'high' : 'standard';
    const duplex = req.body?.duplex === true;
    let requiredAmount =
      mode === 'copy'
        ? adminService.calculateJobAmount(
            'copy',
            colorMode,
            copies,
            paperSize,
            quality,
          )
        : 0;

    let serverFilename: string | null = null;
    let targetDocumentId: string | null = null;
    let originalDocumentName: string | null =
      mode === 'copy' ? 'Scanned Document' : null;
    let printOptions: PrintJobOptions | null = null;
    let printQuotePages: {
      selectedPages: number;
      selectedColorPages: number;
      selectedBwPages: number;
      billableColorPages: number;
      billableBwPages: number;
      effectiveColorMode: 'colored' | 'grayscale';
      billingPageDetection:
        | 'high-confidence-page-detection'
        | 'fallback-assumptions';
      analysisConfidence: 'high' | 'medium' | 'low';
    } | null = null;

    await checkpointRecoverySession({
      transactionId,
      mode,
      phase: 'initiated',
      requiredAmount: 0,
      sessionId: sessionId ?? null,
      documentId: documentId ?? null,
      spoolerCorrelationKey,
      context: {
        endpoint: 'confirm_payment',
      },
    });

    if (mode === 'print') {
      if (!sessionId) {
        void adminService.appendAdminLog(
          'payment_failed',
          'Confirm payment failed: missing print session.',
          { transactionId },
        );
        sendResponse(400, { error: 'Print session is required' });
        return;
      }

      const sessionState = this.deps.sessionStore.getSessionState(sessionId);
      if (sessionState === 'expired') {
        void adminService.appendAdminLog(
          'payment_failed',
          'Confirm payment failed: session expired.',
          { transactionId, sessionId },
        );
        sendResponse(410, {
          code: 'SESSION_EXPIRED',
          error: 'Session has expired. Please start a new upload session.',
        });
        return;
      }
      if (sessionState === 'missing') {
        void adminService.appendAdminLog(
          'payment_failed',
          'Confirm payment failed: session not found.',
          { transactionId, sessionId },
        );
        sendResponse(404, { error: 'Session not found' });
        return;
      }

      const session = this.deps.sessionStore.tryGetSession(
        sessionId,
        this.deps.resolvePublicBaseUrl(req),
      );
      if (!session) {
        void adminService.appendAdminLog(
          'payment_failed',
          'Confirm payment failed: session not found.',
          { transactionId, sessionId },
        );
        sendResponse(410, {
          code: 'SESSION_EXPIRED',
          error: 'Session has expired. Please start a new upload session.',
        });
        return;
      }
      this.deps.sessionStore.touchSession(sessionId);

      const target = resolveTargetDocument(session, documentId);
      if (target) {
        originalDocumentName = target.filename ?? null;
      }
      if (!target) {
        void adminService.appendAdminLog(
          'payment_failed',
          documentId
            ? 'Confirm payment failed: target document not found.'
            : 'Confirm payment failed: no uploaded document in session.',
          { transactionId, sessionId, documentId: documentId ?? null },
        );
        sendResponse(400, {
          error: documentId
            ? `Document "${documentId}" not found in session`
            : 'No uploaded document found for this session',
        });
        return;
      }

      if (!target.analysis) {
        void adminService.appendAdminLog(
          'payment_failed',
          'Confirm payment failed: document analysis unavailable.',
          {
            transactionId,
            sessionId,
            filename: target.filename,
          },
        );
        sendResponse(409, buildAnalysisUnavailablePayload(target));
        return;
      }

      const quoteComputation = buildPrintQuote({
        analysis: target.analysis,
        copies,
        colorMode,
        quality,
        paperSize,
        pageRange: req.body?.pageRange,
        duplex,
      });
      if (!quoteComputation.ok) {
        void adminService.appendAdminLog(
          'payment_failed',
          'Confirm payment failed: invalid quote input.',
          {
            transactionId,
            sessionId,
            pageRange: req.body?.pageRange ?? null,
            error: quoteComputation.error,
          },
        );
        sendResponse(400, { error: quoteComputation.error });
        return;
      }

      requiredAmount = quoteComputation.quote.requiredAmount;
      printQuotePages = {
        selectedPages: quoteComputation.quote.selectedPages,
        selectedColorPages: quoteComputation.quote.selectedColorPages,
        selectedBwPages: quoteComputation.quote.selectedBwPages,
        billableColorPages: quoteComputation.quote.billableColorPages,
        billableBwPages: quoteComputation.quote.billableBwPages,
        effectiveColorMode: quoteComputation.quote.effectiveColorMode,
        billingPageDetection: quoteComputation.quote.billingPageDetection,
        analysisConfidence: quoteComputation.quote.analysisConfidence,
      };

      const printSourcePath = target.convertedPdfPath ?? target.filePath;
      if (
        path.extname(target.filePath).toLowerCase() !== '.pdf' &&
        !target.convertedPdfPath
      ) {
        sendResponse(409, buildAnalysisUnavailablePayload(target));
        return;
      }
      if (!fs.existsSync(printSourcePath)) {
        sendResponse(409, buildAnalysisUnavailablePayload(target));
        return;
      }
      serverFilename = path.basename(printSourcePath);
      targetDocumentId = target.documentId;
      printOptions = withPrintQuality(
        {
          copies: quoteComputation.quote.copies,
          colorMode: quoteComputation.quote.effectiveColorMode,
          orientation,
          rotationDeg,
          paperSize,
          pageRange: quoteComputation.quote.pageRange ?? undefined,
          duplex: quoteComputation.quote.duplex,
        },
        quality,
      );
    } else if (mode === 'copy') {
      const isColor = colorMode === 'colored';
      printQuotePages = {
        selectedPages: 1,
        selectedColorPages: isColor ? 1 : 0,
        selectedBwPages: isColor ? 0 : 1,
        billableColorPages: isColor ? 1 : 0,
        billableBwPages: isColor ? 0 : 1,
        effectiveColorMode: isColor ? 'colored' : 'grayscale',
        billingPageDetection: 'fallback-assumptions',
        analysisConfidence: 'medium',
      };
    }

    await checkpointRecoverySession({
      transactionId,
      mode,
      phase: 'preflight_passed',
      requiredAmount,
      sessionId: sessionId ?? null,
      documentId: targetDocumentId ?? documentId ?? null,
      spoolerCorrelationKey,
      context: {
        copies,
        colorMode: printOptions?.colorMode ?? colorMode,
        duplex: printOptions?.duplex ?? false,
        selectedPages: printQuotePages?.selectedPages ?? 1,
        billableColorPages: printQuotePages?.billableColorPages ?? 0,
        billableBwPages: printQuotePages?.billableBwPages ?? 0,
      },
    });

    if (
      typeof amount === 'number' &&
      Number.isFinite(amount) &&
      amount !== requiredAmount
    ) {
      void adminService.appendAdminLog(
        'payment_amount_mismatch',
        'Client amount differed from server pricing.',
        {
          transactionId,
          amount,
          requiredAmount,
        },
      );
    }

    if ((db.data?.balance ?? 0) < requiredAmount) {
      void adminService.appendAdminLog(
        'payment_failed',
        'Confirm payment failed: insufficient balance.',
        { transactionId, balance: db.data?.balance ?? 0, requiredAmount },
      );
      if (idempotencyClaimed) {
        releaseIdempotencyKey(idempotencyKey, 'POST:/api/confirm-payment');
      }
      res.status(400).json({
        error: 'Insufficient balance',
        balance: db.data?.balance ?? 0,
        requiredAmount,
      });
      return;
    }

    const telemetry =
      mode === 'print'
        ? await refreshPrinterTelemetry()
        : getPrinterTelemetry();
    let jobDispatchedAt: string | null = null;
    let dispatchResult: PrintDispatchResult | null = null;

    let receipt: Record<string, unknown> | null = null;

    if (mode === 'print' && serverFilename && printOptions) {
      if (!telemetry.connected || BLOCKED_STATUSES.has(telemetry.status)) {
        void adminService.appendAdminLog(
          'print_preflight_failed',
          'Print rejected: printer not ready.',
          {
            transactionId,
            printerStatus: telemetry.status,
            printerConnected: telemetry.connected,
            sessionId: sessionId ?? null,
          },
        );
        if (idempotencyClaimed) {
          releaseIdempotencyKey(idempotencyKey, 'POST:/api/confirm-payment');
        }
        res.status(409).json({
          error: `Printer is not ready: ${telemetry.status}. Please notify the operator.`,
          printerStatus: telemetry.status,
        });
        return;
      }

      const inkPreflight = evaluateInkPreflight(telemetry);
      if (inkPreflight.blocked) {
        void adminService.appendAdminLog(
          'print_preflight_failed_ink',
          'Print rejected: ink preflight policy blocked the job.',
          {
            transactionId,
            printerStatus: telemetry.status,
            inkCode: inkPreflight.code,
            inkReason: inkPreflight.reason ?? 'Unknown ink policy reason',
            telemetryAvailable: inkPreflight.telemetryAvailable,
            inkDetectionMethod: telemetry.inkDetectionMethod,
          },
        );
        if (idempotencyClaimed) {
          releaseIdempotencyKey(idempotencyKey, 'POST:/api/confirm-payment');
        }
        res.status(409).json({
          error:
            inkPreflight.reason ??
            'Printer ink state is not ready for printing.',
          printerStatus: telemetry.status,
          inkStatus: inkPreflight.code,
          inkReason: inkPreflight.reason,
          telemetryAvailable: inkPreflight.telemetryAvailable,
        });
        return;
      }

      // Queue handoff replaces direct Node-side dispatch. Payment is settled
      // before the local JobProcessor prepares the PDF and hands it to the C# worker.
    }

    try {
      await financialLedgerService.append({
        eventType: 'job_started',
        amount: requiredAmount,
        referenceId: transactionId,
        meta: {
          mode,
          sessionId: sessionId ?? null,
          documentId: targetDocumentId ?? null,
          filename: serverFilename ?? null,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown ledger error.';
      void adminService.appendAdminLog(
        'financial_ledger_write_failed',
        'Failed to record immutable job_started event.',
        { transactionId, mode, error: message },
      );
      sendResponse(500, { error: 'Failed to record financial event.' });
      return;
    }

    const settlement = await settlementService.settle({
      requiredAmount,
      io: this.deps.io,
      jobContext: {
        transactionId,
        mode,
        copies,
        colorMode: printOptions?.colorMode ?? colorMode,
        rotationDeg: printOptions?.rotationDeg ?? rotationDeg,
        duplex: printOptions?.duplex ?? false,
        spoolerCorrelationKey,
        sessionId: sessionId ?? null,
        documentId: targetDocumentId ?? null,
        filename: serverFilename ?? null,
      },
    });

    if (!settlement.ok) {
      sendResponse(400, {
        error: settlement.error ?? 'Insufficient balance',
        balance: settlement.remainingBalance,
        requiredAmount,
      });
      return;
    }

    const settledAt = getTrustedTimestamp().timestamp;

    await checkpointRecoverySession({
      transactionId,
      mode,
      phase: 'settled',
      requiredAmount,
      chargedAmount: settlement.chargedAmount,
      sessionId: sessionId ?? null,
      documentId: targetDocumentId ?? null,
      spoolerCorrelationKey,
      jobDispatchedAt,
      settledAt,
      context: {
        changeState: settlement.change.state,
        changeRequested: settlement.change.requested,
        changeDispensed: settlement.change.dispensed,
        selectedPages: printQuotePages?.selectedPages ?? 1,
        billableColorPages: printQuotePages?.billableColorPages ?? 0,
        billableBwPages: printQuotePages?.billableBwPages ?? 0,
      },
    });

    try {
      const initialStatus: ReceiptRecordStatus =
        mode === 'print' ? 'settled_pending_terminal' : 'printed';
      const printConfig = {
        copies:
          typeof copies === 'number' && Number.isFinite(copies) ? copies : 1,
        colorMode:
          printOptions?.colorMode ??
          (colorMode === 'colored' ? 'colored' : 'grayscale'),
        paperSize,
        quality,
        duplex: printOptions?.duplex ?? duplex,
        orientation: printOptions?.orientation ?? orientation,
        pageRange:
          typeof printOptions?.pageRange === 'string'
            ? printOptions.pageRange
            : typeof req.body?.pageRange === 'string'
              ? req.body.pageRange
              : null,
      };
      const safeCopies = printConfig.copies > 0 ? printConfig.copies : 1;
      let snapshot = this.receiptService.upsertReceiptSnapshot({
        transactionId,
        mode,
        chargedAmount: settlement.chargedAmount,
        // persist color/BW counts (per-copy page count * no. of copies)
        colorPages:
          typeof printQuotePages?.billableColorPages === 'number'
            ? printQuotePages?.billableColorPages * safeCopies
            : null,
        bwPages:
          typeof printQuotePages?.billableBwPages === 'number'
            ? printQuotePages?.billableBwPages * safeCopies
            : null,
        coinsInserted: settlement.previousBalance,
        documentName: originalDocumentName,
        printConfiguration: printConfig,
        status: initialStatus,
        change: {
          requested: settlement.change.requested,
          dispensed: settlement.change.dispensed,
          state:
            settlement.change.state === 'dispensed' ||
            settlement.change.state === 'failed'
              ? settlement.change.state
              : 'none',
          attempts: settlement.change.attempts ?? 0,
          owedChangeId: settlement.change.owedChangeId ?? null,
          message: settlement.change.message ?? null,
        },
        settledAt,
        terminalAt: mode === 'print' ? null : new Date().toISOString(),
      });
      if (mode === 'print') {
        const lifecycleRecord = getSpoolerLifecycleRecord(transactionId);
        const terminalStatus = this.resolvePrintReceiptTerminalStatus(
          transactionId,
          lifecycleRecord?.currentState ?? null,
        );
        if (terminalStatus) {
          const terminalAt =
            lifecycleRecord?.printedAt ??
            lifecycleRecord?.failedAt ??
            new Date().toISOString();
          const updated = this.receiptService.updateTerminalStatus({
            transactionId,
            status: terminalStatus,
            terminalAt,
          });
          if (updated) snapshot = updated;
        }
      }
      const tokenData = this.receiptService.mintToken(transactionId, {
        revokeExisting: true,
      });
      if (!tokenData) {
        throw new Error('Receipt token mint returned null.');
      }
      const publicBaseUrl = this.deps.resolvePublicBaseUrl(req);
      const encodedToken = encodeURIComponent(tokenData.token);
      receipt = {
        transactionId,
        mode,
        status: snapshot.status,
        token: tokenData.token,
        tokenId: tokenData.tokenId,
        expiresAt: tokenData.expiresAt,
        viewUrl: new URL(
          `/receipt/t/${encodedToken}`,
          publicBaseUrl,
        ).toString(),
        apiUrl: new URL(
          `/api/receipts/by-token/${encodedToken}`,
          publicBaseUrl,
        ).toString(),
      };
    } catch (error) {
      void adminService.appendAdminLog(
        'receipt_generation_failed',
        'Failed to create e-receipt snapshot/token after settlement.',
        {
          transactionId,
          mode,
          spoolerCorrelationKey,
          error: error instanceof Error ? error.message : String(error),
          phase: 'confirm_payment_settled',
        },
      );
    }

    try {
      await financialLedgerService.append({
        eventType: 'job_completed',
        amount: settlement.chargedAmount,
        referenceId: transactionId,
        meta: {
          mode,
          changeState: settlement.change.state,
          changeRequested: settlement.change.requested,
          changeDispensed: settlement.change.dispensed,
          remainingBalance: settlement.remainingBalance,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown ledger error.';
      void adminService.appendAdminLog(
        'financial_ledger_write_failed',
        'Failed to record immutable job_completed event.',
        { transactionId, mode, error: message },
      );
      sendResponse(500, { error: 'Failed to record financial event.' });
      return;
    }

    const settledAmount = settlement.chargedAmount;
    const settledChangeState = settlement.change.state;
    const settledChangeRequested = settlement.change.requested;
    const settledChangeDispensed = settlement.change.dispensed;
    const settledChangeAttempts = settlement.change.attempts ?? 0;
    const settledOwedChangeId = settlement.change.owedChangeId ?? null;
    const settledChangeMessage = settlement.change.message ?? null;
    const settledRemainingBalance = settlement.remainingBalance;

    function appendConsumableUsageEvent(eventMode: 'print' | 'copy'): void {
      const isPrintMode = eventMode === 'print';
      const selectedPages = Math.max(1, printQuotePages?.selectedPages ?? 1);
      const duplexEnabled = isPrintMode ? Boolean(printOptions?.duplex) : false;
      const billableColorPages = Math.max(
        0,
        printQuotePages?.billableColorPages ??
          (colorMode === 'colored' ? 1 : 0),
      );
      const billableBwPages = Math.max(
        0,
        printQuotePages?.billableBwPages ?? (colorMode === 'colored' ? 0 : 1),
      );
      const estimatedSheetsUsed =
        Math.max(1, copies) *
        Math.ceil(selectedPages / (duplexEnabled ? 2 : 1));
      const billingPageDetection = isPrintMode
        ? (printQuotePages?.billingPageDetection ?? 'fallback-assumptions')
        : 'fallback-assumptions';
      const analysisConfidence = isPrintMode
        ? (printQuotePages?.analysisConfidence ?? 'unknown')
        : 'unknown';
      const estimatedInkUnits = estimateInkUsageByJob({
        selectedColorPages: billableColorPages,
        selectedBwPages: billableBwPages,
        copies: Math.max(1, copies),
        printerName: telemetry.name ?? null,
      });
      consumablesStore.appendUsageEvent({
        id: randomUUID(),
        timestamp: getTrustedTimestamp().timestamp,
        transactionId,
        mode: eventMode,
        copies: Math.max(1, copies),
        duplex: duplexEnabled,
        selectedPages,
        billableColorPages,
        billableBwPages,
        estimatedSheetsUsed,
        estimatedInkUnits,
        source: 'confirm-payment',
        billingPageDetection,
        analysisConfidence,
      });
    }

    if (mode === 'copy') {
      try {
        appendConsumableUsageEvent('copy');
        await evaluateConsumablesForecastAlerts();
      } catch (error) {
        console.error(
          '[CONFIRM-PAYMENT] Failed to persist copy consumable usage event.',
          error instanceof Error ? error.message : error,
        );
      }
    }

    let queuedAt: string | null = null;
    if (mode === 'print' && serverFilename && printOptions) {
      const enqueueIdempotencyKey =
        idempotencyKey.trim().length > 0 ? idempotencyKey.trim() : randomUUID();
      const payload = buildPrintJobEnqueuePayload({
        transactionId,
        idempotencyKey: enqueueIdempotencyKey,
        mode: 'print',
        sessionId: sessionId ?? null,
        documentId: targetDocumentId ?? null,
        serverFilename,
        printOptions: {
          ...printOptions,
          printerName: telemetry.name ?? undefined,
        },
        requiredAmount,
        billedColorPages:
          (printQuotePages?.billableColorPages ?? 0) *
          (printOptions.copies ?? 1),
        billedBwPages:
          (printQuotePages?.billableBwPages ?? 0) * (printOptions.copies ?? 1),
        printerName: telemetry.name ?? null,
        spoolerCorrelationKey,
      });

      try {
        await enqueuePrintJob(payload, {
          powerSafetyService: this.powerSafety,
        });
        queuedAt = getTrustedTimestamp().timestamp;
      } catch (enqueueError) {
        await upsertSpoolerFailureRefund({
          chargedAmount: settlement.chargedAmount,
          reason:
            'Failed to enqueue worker print job after payment settlement.',
          autoRefund: true,
          jobContext: {
            transactionId,
            sessionId: sessionId ?? null,
            documentId: targetDocumentId ?? null,
            spoolerCorrelationKey,
            filename: serverFilename,
            source: 'confirm-payment-enqueue',
          },
        });
        this.safeUpdateReceiptTerminalStatus({
          transactionId,
          status: 'refunded',
          phase: 'worker_enqueue_failed',
          spoolerCorrelationKey,
          terminalAt: new Date().toISOString(),
          reason:
            enqueueError instanceof Error
              ? enqueueError.message
              : String(enqueueError),
        });
        sendResponse(503, {
          code:
            enqueueError instanceof PrintJobEnqueueError
              ? enqueueError.code
              : 'PRINT_ENQUEUE_FAILED',
          error: 'Print job could not be queued for the worker.',
          message:
            enqueueError instanceof Error
              ? enqueueError.message
              : String(enqueueError),
        });
        return;
      }

      try {
        await checkpointRecoverySession({
          transactionId,
          mode,
          phase: 'settled',
          requiredAmount,
          chargedAmount: settlement.chargedAmount,
          sessionId: sessionId ?? null,
          documentId: targetDocumentId ?? null,
          spoolerCorrelationKey,
          settledAt,
          context: {
            filename: serverFilename,
            queuedAt,
          },
        });
      } catch (checkpointError) {
        console.error(
          '[CONFIRM-PAYMENT] checkpointRecoverySession failed after enqueue:',
          {
            error:
              checkpointError instanceof Error
                ? checkpointError.message
                : String(checkpointError),
            transactionId,
            correlationKey: spoolerCorrelationKey,
            settledAt,
            queuedAt,
            filename: serverFilename,
          },
        );
        this.safeUpdateReceiptTerminalStatus({
          transactionId,
          status: 'settled_pending_terminal',
          phase: 'worker_checkpoint_failed',
          spoolerCorrelationKey,
          reason:
            checkpointError instanceof Error
              ? checkpointError.message
              : String(checkpointError),
        });
      }
    }

    sendResponse(200, {
      ok: true,
      transactionId,
      chargedAmount: settlement.chargedAmount,
      balance: settlement.remainingBalance,
      earnings: settlement.earnings,
      change: settlement.change,
      print:
        mode === 'print'
          ? {
              state: 'queued',
              spoolerCorrelationKey,
              queuedAt,
              monitorWindowMs: PRINT_SPOOLER_MONITOR_WINDOW_MS,
            }
          : undefined,
      receipt: receipt ?? undefined,
    });

    void (async () => {
      const runAuditStep = async (
        step: string,
        operation: () => Promise<unknown>,
      ): Promise<void> => {
        try {
          await operation();
        } catch (err) {
          console.error(
            `[CONFIRM-PAYMENT] Audit step failed (${step}):`,
            err instanceof Error ? err.message : err,
          );
        }
      };

      await runAuditStep('increment_job_stats', () =>
        adminService.incrementJobStats(mode),
      );

      await runAuditStep('payment_confirmed', () =>
        adminService.appendAdminLog('payment_confirmed', 'Payment confirmed.', {
          transactionId,
          mode,
          amount: requiredAmount,
          copies,
          colorMode: printOptions?.colorMode ?? colorMode,
          rotationDeg: printOptions?.rotationDeg ?? rotationDeg,
          duplex: printOptions?.duplex ?? false,
          pageRange: printOptions?.pageRange ?? null,
          selectedPages: printQuotePages?.selectedPages ?? null,
          selectedColorPages: printQuotePages?.selectedColorPages ?? null,
          selectedBwPages: printQuotePages?.selectedBwPages ?? null,
          billableColorPages: printQuotePages?.billableColorPages ?? null,
          billableBwPages: printQuotePages?.billableBwPages ?? null,
          billingPageDetection: printQuotePages?.billingPageDetection ?? null,
          analysisConfidence: printQuotePages?.analysisConfidence ?? null,
          documentId: targetDocumentId ?? null,
          sessionId: sessionId ?? null,
          filename: serverFilename ?? null,
          dispatchEngine: null,
          dispatchMode: null,
          dispatchRequestedMode: null,
          dispatchDurationMs: null,
          dispatchMimeType: null,
          dispatchExtension: null,
          dispatchAttempts: null,
          remainingBalance: settledRemainingBalance,
          changeState: settledChangeState,
          changeRequested: settledChangeRequested,
          changeDispensed: settledChangeDispensed,
        }),
      );

      if (settledChangeState === 'dispensed') {
        await runAuditStep('hopper_dispense_succeeded', () =>
          adminService.appendAdminLog(
            'hopper_dispense_succeeded',
            'Coin change dispensed.',
            {
              transactionId,
              requested: settledChangeRequested,
              dispensed: settledChangeDispensed,
              attempts: settledChangeAttempts,
            },
          ),
        );
      }

      if (settledChangeState === 'failed') {
        await runAuditStep('hopper_dispense_failed', () =>
          adminService.appendAdminLog(
            'hopper_dispense_failed',
            'Coin change dispense failed.',
            {
              transactionId,
              requested: settledChangeRequested,
              dispensed: settledChangeDispensed,
              attempts: settledChangeAttempts,
              owedChangeId: settledOwedChangeId,
              message: settledChangeMessage,
            },
          ),
        );
      }
    })();

    if (mode === 'copy') {
      void reconcileFinalizedCopySession(transactionId).catch((error) => {
        console.error(
          '[CONFIRM-PAYMENT] Failed to reconcile finalized copy session:',
          error instanceof Error ? error.message : error,
        );
      });
    }
  };

  private safeUpdateReceiptTerminalStatus(input: {
    transactionId: string;
    status: ReceiptRecordStatus;
    phase: string;
    spoolerCorrelationKey: string | null;
    reason?: string;
    terminalAt?: string;
  }): void {
    try {
      this.receiptService.updateTerminalStatus({
        transactionId: input.transactionId,
        status: input.status,
        terminalAt: input.terminalAt,
      });
    } catch (error) {
      void adminService.appendAdminLog(
        'receipt_status_update_failed',
        'Failed to update e-receipt terminal status.',
        {
          transactionId: input.transactionId,
          status: input.status,
          phase: input.phase,
          spoolerCorrelationKey: input.spoolerCorrelationKey,
          reason: input.reason ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private resolvePrintReceiptTerminalStatus(
    transactionId: string,
    lifecycleState: SpoolerLifecycleState | null,
  ): ReceiptRecordStatus | null {
    if (lifecycleState === 'printed') return 'printed';
    if (lifecycleState !== 'failed') return null;

    const pendingRefund = db.data!.pendingRefunds.find((entry) => {
      const ref = entry.jobContext.transactionId;
      return typeof ref === 'string' && ref === transactionId;
    });
    if (!pendingRefund) return 'failed';
    if (pendingRefund.status === 'refunded') return 'refunded';
    if (pendingRefund.status === 'open') return 'refunded_pending_review';
    return 'failed';
  }

  private async cleanupPrintUploadAfterSpoolerSuccess(input: {
    transactionId: string;
    sessionId: string | null;
    documentId: string | null;
    filename: string;
  }): Promise<void> {
    const { transactionId, sessionId, documentId, filename } = input;

    let cleaned = false;
    if (sessionId && documentId) {
      const removedDocument = await this.deps.sessionStore.removeDocument(
        sessionId,
        documentId,
      );
      if (removedDocument.success && removedDocument.deletedFile) {
        cleaned = true;
        await adminService.appendAdminLog(
          'upload_deleted_after_print',
          'Uploaded file deleted after spooler-confirmed print completion.',
          {
            transactionId,
            sessionId,
            documentId,
            filename,
            source: 'session-store-spooler-confirmed',
            alreadyMissing: false,
          },
        );
      } else {
        const fallbackCleanup = await deleteUploadByStoredFilename(filename);
        if (fallbackCleanup.deleted) {
          cleaned = true;
          await adminService.appendAdminLog(
            'upload_deleted_after_print',
            'Uploaded file deleted after spooler-confirmed print completion.',
            {
              transactionId,
              sessionId,
              documentId,
              filename,
              source: 'fallback-unlink-spooler-confirmed',
              alreadyMissing: fallbackCleanup.alreadyMissing,
              sessionRemoveErrorCode: removedDocument.errorCode ?? null,
              sessionDeletedFile: removedDocument.deletedFile,
            },
          );
        } else {
          await adminService.appendAdminLog(
            'upload_delete_after_print_failed',
            'Failed to delete uploaded file after spooler-confirmed print completion.',
            {
              transactionId,
              sessionId,
              documentId,
              filename,
              source: 'spooler-confirmed',
              sessionRemoveErrorCode: removedDocument.errorCode ?? null,
              sessionDeletedFile: removedDocument.deletedFile,
              error: fallbackCleanup.error ?? 'Unknown error',
            },
          );
        }
      }
    } else {
      const cleanup = await deleteUploadByStoredFilename(filename);
      cleaned = cleanup.deleted;
      if (cleanup.deleted) {
        await adminService.appendAdminLog(
          'upload_deleted_after_print',
          'Uploaded file deleted after spooler-confirmed print completion.',
          {
            transactionId,
            sessionId,
            documentId,
            filename,
            source: 'spooler-confirmed',
            alreadyMissing: cleanup.alreadyMissing,
          },
        );
      } else {
        await adminService.appendAdminLog(
          'upload_delete_after_print_failed',
          'Failed to delete uploaded file after spooler-confirmed print completion.',
          {
            transactionId,
            sessionId,
            documentId,
            filename,
            source: 'spooler-confirmed',
            error: cleanup.error ?? 'Unknown error',
          },
        );
      }
    }

    if (!cleaned) {
      throw new Error(
        'Uploaded file cleanup failed after spooler-confirmed print completion.',
      );
    }
  }

  private async handleMissingSpoolerTelemetry(input: {
    transactionId: string;
    chargedAmount: number;
    spoolerCorrelationKey: string | null;
    sessionId: string | null;
    documentId: string | null;
    filename: string | null;
    copies: number;
    colorMode: 'colored' | 'grayscale';
    rotationDeg: number;
    duplex: boolean;
    pageRange: string | null | undefined;
    jobDispatchedAt: string;
  }): Promise<void> {
    const {
      transactionId,
      chargedAmount,
      spoolerCorrelationKey,
      sessionId,
      documentId,
      filename,
      copies,
      colorMode,
      rotationDeg,
      duplex,
      pageRange,
      jobDispatchedAt,
    } = input;

    const reason =
      'Print spooler monitoring unavailable because printer telemetry name is missing.';
    await adminService
      .appendAdminLog(
        'print_spooler_monitor_unavailable',
        'Unable to monitor spooler job because printer telemetry is missing.',
        {
          transactionId,
          spoolerCorrelationKey,
          sessionId,
          documentId,
          filename,
        },
      )
      .catch((logError) => {
        console.error(
          '[CONFIRM-PAYMENT] Failed to append monitor-unavailable admin log:',
          logError instanceof Error ? logError.message : logError,
        );
      });

    try {
      const refundOutcome = await upsertSpoolerFailureRefund({
        chargedAmount,
        reason,
        autoRefund: false,
        jobContext: {
          transactionId,
          mode: 'print',
          copies,
          colorMode,
          rotationDeg,
          duplex,
          pageRange,
          spoolerCorrelationKey,
          sessionId,
          documentId,
          filename,
          spoolerStatus: 'monitor_unavailable',
          jobDispatchedAt,
        },
      });
      const refundDisposition = refundOutcome.autoRefunded
        ? 'auto_refunded'
        : 'pending_admin_review';
      this.safeUpdateReceiptTerminalStatus({
        transactionId,
        status:
          refundDisposition === 'auto_refunded'
            ? 'refunded'
            : 'refunded_pending_review',
        phase: 'spooler_monitor_unavailable_refund',
        spoolerCorrelationKey,
        terminalAt: new Date().toISOString(),
        reason,
      });

      if (
        refundOutcome.autoRefunded &&
        refundOutcome.restoredBalanceAmount > 0
      ) {
        this.deps.io.emit('balance', db.data!.balance);
      }

      await adminService
        .appendAdminLog(
          refundOutcome.autoRefunded
            ? 'print_spooler_auto_refund'
            : 'print_spooler_job_failed',
          refundOutcome.autoRefunded
            ? `Print monitor fallback auto-refunded ₱${chargedAmount}.`
            : `Print monitor fallback queued pending refund ₱${chargedAmount}.`,
          {
            transactionId,
            spoolerCorrelationKey,
            refundId: refundOutcome.entry.id,
            refundDisposition,
            restoredBalanceAmount: refundOutcome.restoredBalanceAmount,
            reason,
          },
        )
        .catch((logError) => {
          console.error(
            '[CONFIRM-PAYMENT] Failed to append fallback refund admin log:',
            logError instanceof Error ? logError.message : logError,
          );
        });

      this.deps.io.emit('printerSpoolerFailure', {
        jobStatus: 'monitor_unavailable',
        chargedAmount,
        refundId: refundOutcome.entry.id,
        pagesPrinted: 0,
        totalPages: 0,
        printerName: null,
        reason,
        refundDisposition,
        restoredBalanceAmount: refundOutcome.restoredBalanceAmount,
        transactionId,
        spoolerCorrelationKey,
      });

      await checkpointRecoverySession({
        transactionId,
        mode: 'print',
        phase: 'reconciled',
        requiredAmount: chargedAmount,
        chargedAmount,
        sessionId,
        documentId,
        spoolerCorrelationKey,
        spoolerJobId: null,
        jobDispatchedAt,
        settledAt: null,
        spoolerTerminalAt: new Date().toISOString(),
        reconciledAt: new Date().toISOString(),
        startupReconciled: false,
        reconciliationAction:
          refundDisposition === 'auto_refunded'
            ? 'auto_refund'
            : 'pending_admin_review',
        reconciliationReason:
          refundDisposition === 'auto_refunded'
            ? 'Spooler monitor unavailable; auto-refunded.'
            : 'Spooler monitor unavailable; pending admin refund review.',
        context: {
          spoolerOutcome: 'monitor_unavailable',
          refundDisposition,
          refundId: refundOutcome.entry.id,
        },
      });
      if (filename) {
        await this.cleanupPrintUploadAfterSpoolerSuccess({
          transactionId,
          sessionId,
          documentId,
          filename,
        }).catch((cleanupError) => {
          console.error(
            '[CONFIRM-PAYMENT] Fallback print upload cleanup failed:',
            cleanupError instanceof Error ? cleanupError.message : cleanupError,
          );
        });
      }
    } catch (error) {
      if (
        error instanceof PendingRefundServiceError &&
        error.code === 'TRUSTED_TIME_UNAVAILABLE'
      ) {
        await adminService
          .appendAdminLog(
            'trusted_time_unsynced',
            'Print fallback refund blocked because trusted time is unavailable.',
            {
              transactionId,
              spoolerCorrelationKey,
              detail: error.message,
            },
          )
          .catch((logError) => {
            console.error(
              '[CONFIRM-PAYMENT] Failed to append trusted-time fallback admin log:',
              logError instanceof Error ? logError.message : logError,
            );
          });
        this.deps.io.emit('printerSpoolerFailure', {
          jobStatus: 'monitor_unavailable',
          chargedAmount,
          refundId: null,
          pagesPrinted: 0,
          totalPages: 0,
          printerName: null,
          reason: 'Refund blocked because trusted time is unavailable.',
          refundDisposition: 'refund_blocked_trusted_time',
          restoredBalanceAmount: 0,
          transactionId,
          spoolerCorrelationKey,
        });
        this.safeUpdateReceiptTerminalStatus({
          transactionId,
          status: 'failed',
          phase: 'spooler_monitor_unavailable_trusted_time_blocked',
          spoolerCorrelationKey,
          terminalAt: new Date().toISOString(),
          reason: 'Refund blocked because trusted time is unavailable.',
        });
        await checkpointRecoverySession({
          transactionId,
          mode: 'print',
          phase: 'spooler_failed',
          requiredAmount: chargedAmount,
          chargedAmount,
          sessionId,
          documentId,
          spoolerCorrelationKey,
          spoolerJobId: null,
          jobDispatchedAt,
          settledAt: null,
          spoolerTerminalAt: new Date().toISOString(),
          lastError: 'Refund blocked because trusted time is unavailable.',
          context: {
            spoolerOutcome: 'monitor_unavailable',
            refundDisposition: 'refund_blocked_trusted_time',
            trustedTimeBlocked: true,
          },
        });
        if (filename) {
          await this.cleanupPrintUploadAfterSpoolerSuccess({
            transactionId,
            sessionId,
            documentId,
            filename,
          }).catch((cleanupError) => {
            console.error(
              '[CONFIRM-PAYMENT] Fallback print upload cleanup failed:',
              cleanupError instanceof Error
                ? cleanupError.message
                : cleanupError,
            );
          });
        }
        return;
      }
      throw error;
    }
  }
}
