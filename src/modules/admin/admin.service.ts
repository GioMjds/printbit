import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {
  type AdminLogEntry,
  type ColorMode,
  type LogMeta,
  type PrintMode,
  type PricingSettings,
} from '@/modules/admin/admin.schema';
import {
  type PrintQuality,
  type TrustedTimestampMeta,
} from '@/core/database/shared.schema';
import type { CoverageTier } from '@/core/database/models/admin.model';
import type {
  FinancialLedgerEntry,
  PendingRefundEntry,
  OwedChangeEntry,
} from '@/core/database/models/payment.model';
import type { RecoverySessionEntry } from '@/core/database/models/recovery.model';
import type { ReceiptRecordEntry } from '@/core/database/models/receipt.model';
import { db, defaultPricingEngine } from '@/services/db';
import { getTrustedTimestamp } from '@/services/time-source';
import { adminLogStore } from '@/core/database/sqlite-storage';
import { financialLedgerService } from '@/services/financial-ledger';

export type EarningsAnalyticsView = 'daily' | 'weekly' | 'monthly' | 'yearly';
type EarningsMode = 'print' | 'copy' | 'scan';
export type TransactionLogMode = 'print' | 'copy' | 'scan';
export type TransactionLogStatus =
  | 'created'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'refund';

export interface UnreconciledCopyTransaction {
  txId: string;
  timestamp: string;
  timestampMeta?: TrustedTimestampMeta;
  amount: number;
  copies?: number;
  colorMode?: ColorMode;
}

export interface TransactionLogFilters {
  transactionId?: string;
  exactTransactionId?: string;
  mode?: TransactionLogMode;
  dateFrom?: string;
  dateTo?: string;
  eventType?: string;
  status?: TransactionLogStatus;
}

export interface PageOutputSummaryResult {
  scope: {
    totalTransactions: number;
    dateFrom: string | null;
    dateTo: string | null;
  };
  financials: {
    grossCharged: number;
    cashRefundsIssued: number;
    refundCount: number;
    netCashRetained: number;
    unresolvedOwedChange: number;
    unresolvedOwedChangeCount: number;
  };
  pages: {
    totalRequested: number;
    totalPrinted: number;
    totalFailed: number;
    fulfillmentRatePercent: number;
    colorPagesPrinted: number;
    bwPagesPrinted: number;
  };
  hardwareIncidents: {
    spoolerFailures: number;
    hopperShortfalls: number;
  };
}

const TRANSACTION_TYPE_PREFIXES = [
  'print_',
  'copy_',
  'scan_',
  'payment_',
  'refund_',
  'settlement_',
] as const;

const TRANSACTION_TYPE_EXACT = new Set([
  'hopper_dispense_failed',
  'trusted_time_unsynced',
]);

export interface EarningsAnalyticsBucket {
  key: string;
  label: string;
  start: string;
  end: string;
  amount: number;
}

export interface EarningsAnalyticsResult {
  view: EarningsAnalyticsView;
  anchorDate: string;
  period: {
    start: string;
    end: string;
    label: string;
  };
  totals: {
    today: number;
    week: number;
    month: number;
    year: number;
    allTime: number;
    period: number;
  };
  buckets: EarningsAnalyticsBucket[];
  methods: {
    print: number;
    copy: number;
    scan: number;
    total: number;
    topMode: EarningsMode | null;
  };
}

export interface DispatchLatencyPercentiles {
  p50: number | null;
  p95: number | null;
  sampleCount: number;
}

export interface DispatchLatencyByMime extends DispatchLatencyPercentiles {
  mimeType: string;
}

export interface DispatchLatencyByEngine extends DispatchLatencyPercentiles {
  engine: string;
}

export interface DispatchLatencySpeculation {
  baselinePdfP95: number | null;
  worstNonPdfP95: number | null;
  thresholdPercent: number;
  confirmed: boolean;
}

export interface DispatchLatencyMetricsResult {
  generatedAt: string;
  sampleCount: number;
  byMimeType: DispatchLatencyByMime[];
  byEngine: DispatchLatencyByEngine[];
  speculation: DispatchLatencySpeculation;
}

interface SocketEmitter {
  emit: (event: string, ...args: unknown[]) => void;
}

export class AdminService {
  private readonly MAX_LOGS = 3000;
  private io: SocketEmitter | null = null;

  setSocketIo(io: SocketEmitter | null): void {
    this.io = io;
  }

  private readonly dateShortFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  private readonly monthFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
  });

  private readonly monthYearFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
  });

  getPricingSettings(): PricingSettings {
    return db.data!.settings.pricing;
  }

  calculateJobAmount(
    mode: PrintMode,
    colorOrPageCounts:
      | ColorMode
      | {
          colorPages?: number;
          bwPages?: number;
          imagePages?: number;
          imageBwPages?: number;
          coverageTier?: CoverageTier;
          tierCounts?: {
            bw?: Partial<Record<CoverageTier, number>>;
            color?: Partial<Record<CoverageTier, number>>;
          };
        },
    copies: number,
    paperSize: 'A4' | 'Short' | 'Long' = 'A4',
    quality: PrintQuality = 'standard',
  ): number {
    const safeCopies = Math.max(1, Math.floor(copies));
    const pricing = this.getPricingSettings();
    const engineCfg = db.data?.settings?.pricingEngine;

    if (mode === 'scan') {
      return pricing.scanDocument;
    }

    if (mode === 'copy') {
      const counts =
        typeof colorOrPageCounts === 'string'
          ? {
              colorPages: colorOrPageCounts === 'colored' ? 1 : 0,
              bwPages: colorOrPageCounts === 'colored' ? 0 : 1,
            }
          : colorOrPageCounts;
      const colorPages = Math.max(0, Math.floor(counts.colorPages ?? 0));
      const bwPages = Math.max(0, Math.floor(counts.bwPages ?? 0));
      const totalPages = Math.max(1, colorPages + bwPages);
      const isColor =
        typeof colorOrPageCounts === 'string'
          ? colorOrPageCounts === 'colored'
          : colorPages > 0;
      const copyBwRate = pricing.copyBwPerPage ?? pricing.copyPerPage ?? 3;
      const copyColorRate = pricing.copyColorPerPage ?? 5;
      const ratePerPage = isColor ? copyColorRate : copyBwRate;
      const qualitySurcharge =
        quality === 'high'
          ? (engineCfg?.highQualitySurcharge ?? pricing.highQualitySurcharge ?? 2)
          : 0;
      return (ratePerPage + qualitySurcharge) * totalPages * safeCopies;
    }

    const paperSizeName = paperSize as string;
    const profileKey =
      paperSizeName === 'Long' || paperSizeName === 'Legal'
        ? 'longBond'
        : paperSizeName === 'Short' || paperSizeName === 'Letter'
          ? 'shortBond'
          : 'a4';
    const profile =
      engineCfg?.paperProfiles?.[profileKey] ??
      defaultPricingEngine.paperProfiles[profileKey];

    const counts =
      typeof colorOrPageCounts === 'string'
        ? {
            colorPages: colorOrPageCounts === 'colored' ? 1 : 0,
            bwPages: colorOrPageCounts === 'colored' ? 0 : 1,
            imagePages: 0,
            imageBwPages: 0,
          }
        : colorOrPageCounts;

    const safeColorPages = Math.max(0, Math.floor(counts.colorPages ?? 0));
    const safeBwPages = Math.max(0, Math.floor(counts.bwPages ?? 0));
    const safeImagePages = Math.max(
      0,
      Math.floor(
        'imagePages' in counts && counts.imagePages ? counts.imagePages : 0,
      ),
    );
    const safeImageBwPages = Math.max(
      0,
      Math.floor(
        'imageBwPages' in counts && counts.imageBwPages
          ? counts.imageBwPages
          : 0,
      ),
    );

    const defaultTier: CoverageTier = counts.coverageTier ?? 'low';
    const colorTierRate = profile.colorPrint[defaultTier];
    const bwTierRate = profile.bwPrint[defaultTier];

    // Images default to very_high tier
    const imageColorRate = profile.colorPrint.very_high;
    const imageBwRate = profile.bwPrint.very_high;

    let printSubtotalPerCopy =
      safeColorPages * colorTierRate +
      safeBwPages * bwTierRate +
      safeImagePages * imageColorRate +
      safeImageBwPages * imageBwRate;

    let totalPages =
      safeColorPages + safeBwPages + safeImagePages + safeImageBwPages;

    if (counts.tierCounts) {
      if (counts.tierCounts.bw) {
        for (const [tier, count] of Object.entries(counts.tierCounts.bw)) {
          const c = Math.max(0, Math.floor(count ?? 0));
          printSubtotalPerCopy += c * profile.bwPrint[tier as CoverageTier];
          totalPages += c;
        }
      }
      if (counts.tierCounts.color) {
        for (const [tier, count] of Object.entries(counts.tierCounts.color)) {
          const c = Math.max(0, Math.floor(count ?? 0));
          printSubtotalPerCopy += c * profile.colorPrint[tier as CoverageTier];
          totalPages += c;
        }
      }
    }

    const paperSubtotalPerCopy = totalPages * profile.paperCost;
    const surchargePerPg =
      quality === 'high'
        ? (engineCfg?.highQualitySurcharge ??
          pricing?.highQualitySurcharge ??
          2)
        : 0;
    const qualitySubtotalPerCopy = totalPages * surchargePerPg;

    const totalExact =
      (paperSubtotalPerCopy + printSubtotalPerCopy + qualitySubtotalPerCopy) *
      safeCopies;

    return Math.ceil(totalExact);
  }

  calculateDocumentAmount(
    mode: Exclude<PrintMode, 'scan'>,
    pageCounts: {
      colorPages?: number;
      bwPages?: number;
      imagePages?: number;
      imageBwPages?: number;
      coverageTier?: CoverageTier;
      tierCounts?: {
        bw?: Partial<Record<CoverageTier, number>>;
        color?: Partial<Record<CoverageTier, number>>;
      };
    },
    copies: number,
    paperSize: 'A4' | 'Short' | 'Long' = 'A4',
    quality: PrintQuality = 'standard',
  ): number {
    return this.calculateJobAmount(
      mode,
      pageCounts,
      copies,
      paperSize,
      quality,
    );
  }

  async appendAdminLog(
    type: string,
    message: string,
    meta?: LogMeta,
  ): Promise<AdminLogEntry> {
    const trusted = getTrustedTimestamp();
    const entry: AdminLogEntry = {
      id: randomUUID(),
      timestamp: trusted.timestamp,
      timestampMeta: trusted.meta,
      type,
      message,
      meta,
    };

    adminLogStore.append(entry, this.MAX_LOGS);
    try {
      this.io?.emit('admin:new_log', entry);
    } catch {
      // Ignore broadcast failures
    }
    return entry;
  }

  private normalizeLimit(limit: number, fallback = 200): number {
    return Number.isFinite(limit)
      ? Math.max(1, Math.min(1000, Math.floor(limit)))
      : fallback;
  }

  private normalizeTransactionMode(value: unknown): TransactionLogMode | null {
    return value === 'print' || value === 'copy' || value === 'scan'
      ? value
      : null;
  }

  private inferTransactionMode(
    entry: AdminLogEntry,
  ): TransactionLogMode | null {
    const mode = this.normalizeTransactionMode(entry.meta?.mode);
    if (mode) return mode;

    const lowerType = entry.type.toLowerCase();
    if (lowerType.startsWith('print_')) return 'print';
    if (lowerType.startsWith('copy_')) return 'copy';
    if (lowerType.startsWith('scan_')) return 'scan';
    return null;
  }

  private classifyTransactionStatus(
    entry: AdminLogEntry,
  ): TransactionLogStatus | null {
    const lowerType = entry.type.toLowerCase();
    const lowerMessage = entry.message.toLowerCase();
    const hasToken = (...tokens: ReadonlyArray<string>): boolean =>
      tokens.some(
        (token) => lowerType.includes(token) || lowerMessage.includes(token),
      );

    if (hasToken('refund', 'reconcile')) return 'refund';
    if (hasToken('failed', 'error', 'timeout', 'blocked', 'mismatch')) {
      return 'failed';
    }
    if (hasToken('completed', 'confirmed', 'success', 'succeeded', 'charged')) {
      return 'completed';
    }
    if (hasToken('created', 'started', 'queued', 'requested')) return 'created';
    if (hasToken('dispatch', 'processing', 'monitor', 'spooler')) {
      return 'processing';
    }
    return null;
  }

  isTransactionLog(entry: AdminLogEntry): boolean {
    const transactionId =
      entry.meta?.transactionId ?? entry.meta?.transaction_id;
    if (typeof transactionId === 'string' && transactionId.trim().length > 0) {
      return true;
    }

    if (this.inferTransactionMode(entry) !== null) {
      return true;
    }

    const lowerType = entry.type.toLowerCase();
    if (TRANSACTION_TYPE_EXACT.has(lowerType)) {
      return true;
    }

    return TRANSACTION_TYPE_PREFIXES.some((prefix) =>
      lowerType.startsWith(prefix),
    );
  }

  private getTransactionId(entry: AdminLogEntry): string | null {
    const txId =
      entry.meta?.transactionId ??
      entry.meta?.transaction_id ??
      (entry.meta?.jobId ? String(entry.meta.jobId) : null);
    if (typeof txId === 'string' && txId.trim().length > 0) {
      return txId.trim();
    }
    return null;
  }

  private filterTransactionLogs(
    logs: readonly AdminLogEntry[],
    filters: TransactionLogFilters,
  ): AdminLogEntry[] {
    const exactTxId = filters.exactTransactionId?.trim();
    const rawTxId = filters.transactionId?.trim();
    const query = rawTxId ? rawTxId.toLowerCase() : '';
    const queryNoHyphens = query.replace(/-/g, '');
    const dateFromMs =
      typeof filters.dateFrom === 'string' ? Date.parse(filters.dateFrom) : NaN;
    const dateToMs =
      typeof filters.dateTo === 'string' ? Date.parse(filters.dateTo) : NaN;

    return logs.filter((entry) => {
      if (exactTxId) {
        const entryTxId = this.getTransactionId(entry);
        if (entryTxId !== exactTxId) return false;
      }

      if (query) {
        const entryTxId = this.getTransactionId(entry);
        let matched = false;
        if (entryTxId) {
          const lowerId = entryTxId.toLowerCase();
          if (
            lowerId.includes(query) ||
            (queryNoHyphens.length >= 3 &&
              lowerId.replace(/-/g, '').includes(queryNoHyphens))
          ) {
            matched = true;
          }
        }
        if (!matched && entry.message.toLowerCase().includes(query)) {
          matched = true;
        }
        if (!matched && entry.id.toLowerCase().includes(query)) {
          matched = true;
        }
        if (!matched) return false;
      }

      if (filters.mode) {
        const inferredMode = this.inferTransactionMode(entry);
        if (inferredMode !== filters.mode) return false;
      }

      if (filters.eventType && entry.type !== filters.eventType) {
        return false;
      }

      if (filters.status) {
        const status = this.classifyTransactionStatus(entry);
        if (status !== filters.status) return false;
      }

      if (Number.isFinite(dateFromMs) || Number.isFinite(dateToMs)) {
        const timestampMs = Date.parse(entry.timestamp);
        if (!Number.isFinite(timestampMs)) return false;
        if (Number.isFinite(dateFromMs) && timestampMs < dateFromMs)
          return false;
        if (Number.isFinite(dateToMs) && timestampMs > dateToMs) return false;
      }

      return true;
    });
  }

  resolveTransactionId(query: string): string | null {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return null;
    const queryNoHyphens = trimmed.replace(/-/g, '');
    const logs = this.listAllLogs().filter((entry) =>
      this.isTransactionLog(entry),
    );
    for (const entry of logs) {
      const txId = this.getTransactionId(entry);
      if (!txId) continue;
      const lower = txId.toLowerCase();
      if (
        lower === trimmed ||
        lower.endsWith(trimmed) ||
        lower.startsWith(trimmed) ||
        lower.includes(trimmed) ||
        (queryNoHyphens.length >= 3 &&
          lower.replace(/-/g, '').includes(queryNoHyphens))
      ) {
        return txId;
      }
    }
    return null;
  }

  listSystemLogs(limit: number): AdminLogEntry[] {
    return adminLogStore.listSystemLogs(this.normalizeLimit(limit));
  }

  listAllSystemLogs(): AdminLogEntry[] {
    return adminLogStore.listAllSystemLogs();
  }

  listTransactionLogs(
    limit: number,
    filters: TransactionLogFilters,
  ): AdminLogEntry[] {
    return this.listAllTransactionLogs(filters).slice(
      0,
      this.normalizeLimit(limit),
    );
  }

  private getAllRawTransactionLogs(): AdminLogEntry[] {
    const rawTxLogs = adminLogStore.listAllTransactionLogs();
    const rawDb = db.data as (Record<string, unknown> & typeof db.data) | null;
    const fallbackLogs = (rawDb?.adminLogs ??
      rawDb?.logs ??
      []) as AdminLogEntry[];
    if (fallbackLogs.length > 0) {
      const existingIds = new Set(rawTxLogs.map((l) => l.id));
      const extras = fallbackLogs.filter(
        (l) => !existingIds.has(l.id) && this.isTransactionLog(l),
      );
      return [...rawTxLogs, ...extras];
    }
    return rawTxLogs;
  }

  listAllTransactionLogs(filters: TransactionLogFilters): AdminLogEntry[] {
    const rawTxLogs = this.getAllRawTransactionLogs();
    const logs = this.filterTransactionLogs(rawTxLogs, filters);
    return this.groupLogsByTransaction(logs);
  }

  computePageOutputSummary(
    filters: TransactionLogFilters = {},
  ): PageOutputSummaryResult {
    const rawLogs = this.getAllRawTransactionLogs();
    const filteredLogs = this.filterTransactionLogs(rawLogs, filters);
    const matchingTxGroups = this.groupLogsByTransaction(filteredLogs);

    const totalTransactions = matchingTxGroups.length;
    const dateFrom = filters.dateFrom ?? null;
    const dateTo = filters.dateTo ?? null;

    // ── Pre-indexing collections for O(1) lookups (avoids O(M*N) quadratic passes) ──
    const logsByTxId = new Map<string, AdminLogEntry[]>();
    const txModeMap = new Map<string, TransactionLogMode>();
    const txStatusMap = new Map<string, TransactionLogStatus>();

    for (const log of rawLogs) {
      const id = this.getTransactionId(log);
      if (id) {
        let list = logsByTxId.get(id);
        if (!list) {
          list = [];
          logsByTxId.set(id, list);
        }
        list.push(log);

        const m = this.inferTransactionMode(log);
        if (m && !txModeMap.has(id)) {
          txModeMap.set(id, m);
        }
        const s = this.classifyTransactionStatus(log);
        if (s && !txStatusMap.has(id)) {
          txStatusMap.set(id, s);
        }
      }
    }

    const ledgerByRefId = new Map<string, FinancialLedgerEntry[]>();
    for (const entry of db.data?.financialLedger ?? []) {
      if (entry.referenceId) {
        let list = ledgerByRefId.get(entry.referenceId);
        if (!list) {
          list = [];
          ledgerByRefId.set(entry.referenceId, list);
        }
        list.push(entry);
      }
    }

    const pendingRefundsByTxId = new Map<string, PendingRefundEntry[]>();
    for (const p of db.data?.pendingRefunds ?? []) {
      const txRef =
        typeof p.jobContext?.transactionId === 'string'
          ? p.jobContext.transactionId.trim()
          : p.id;
      if (txRef) {
        let list = pendingRefundsByTxId.get(txRef);
        if (!list) {
          list = [];
          pendingRefundsByTxId.set(txRef, list);
        }
        list.push(p);
      }
    }

    const recoverySessionByTxId = new Map<string, RecoverySessionEntry>();
    for (const s of db.data?.recovery?.sessions ?? []) {
      if (s.id) {
        recoverySessionByTxId.set(s.id, s);
      }
    }

    const receiptRecordByTxId = new Map<string, ReceiptRecordEntry>();
    for (const r of db.data?.receiptRecords ?? []) {
      if (r.transactionId) {
        receiptRecordByTxId.set(r.transactionId, r);
      }
    }

    const owedChangesByTxId = new Map<string, OwedChangeEntry[]>();
    for (const oc of db.data?.owedChanges ?? []) {
      const ocTxId =
        typeof oc.meta?.transactionId === 'string'
          ? oc.meta.transactionId.trim()
          : null;
      if (ocTxId) {
        let list = owedChangesByTxId.get(ocTxId);
        if (!list) {
          list = [];
          owedChangesByTxId.set(ocTxId, list);
        }
        list.push(oc);
      }
    }

    let grossCharged = 0;
    let cashRefundsIssued = 0;
    let refundCount = 0;

    let totalRequested = 0;
    let totalPrinted = 0;
    let totalFailed = 0;
    let colorPagesPrinted = 0;
    let bwPagesPrinted = 0;

    let spoolerFailures = 0;
    let hopperShortfalls = 0;

    const countedSpoolerLogIds = new Set<string>();
    const countedSpoolerTxIds = new Set<string>();
    const countedHopperLogIds = new Set<string>();
    const countedHopperTxIds = new Set<string>();

    for (const txLog of matchingTxGroups) {
      const txId = this.getTransactionId(txLog);

      // O(1) fetch of logs and associated structures for this transaction
      const allTxLogs = txId ? (logsByTxId.get(txId) ?? [txLog]) : [txLog];
      const ledgerEntries = txId ? (ledgerByRefId.get(txId) ?? []) : [];
      const pendingRefunds = txId ? (pendingRefundsByTxId.get(txId) ?? []) : [];
      const recoverySession = txId ? recoverySessionByTxId.get(txId) : undefined;
      const receiptRecord = txId ? receiptRecordByTxId.get(txId) : undefined;

      // 1. Charged Amount
      let txCharged: number | null = null;
      if (typeof receiptRecord?.chargedAmount === 'number') {
        txCharged = receiptRecord.chargedAmount;
      } else {
        const paymentLedger = ledgerEntries.find(
          (e) =>
            e.eventType === 'job_completed' ||
            (e.eventType as string) === 'payment_received',
        );
        if (paymentLedger && typeof paymentLedger.amount === 'number') {
          txCharged = paymentLedger.amount;
        } else if (typeof recoverySession?.chargedAmount === 'number') {
          txCharged = recoverySession.chargedAmount;
        } else if (
          pendingRefunds.length > 0 &&
          typeof pendingRefunds[0].chargedAmount === 'number'
        ) {
          txCharged = pendingRefunds[0].chargedAmount;
        } else {
          for (const l of allTxLogs) {
            if (
              typeof l.meta?.amount === 'number' &&
              Number.isFinite(l.meta.amount)
            ) {
              txCharged = l.meta.amount;
              break;
            }
            if (
              typeof l.meta?.chargedAmount === 'number' &&
              Number.isFinite(l.meta.chargedAmount)
            ) {
              txCharged = l.meta.chargedAmount;
              break;
            }
          }
        }
      }

      if (
        typeof txCharged === 'number' &&
        Number.isFinite(txCharged) &&
        txCharged > 0
      ) {
        grossCharged += txCharged;
      }

      // 2. Refunds
      const pendingRefundIds = new Set(pendingRefunds.map((p) => p.id));
      const refundLedgerEntries = [
        ...ledgerEntries.filter((e) => e.eventType === 'refund_issued'),
        ...Array.from(pendingRefundIds).flatMap(
          (pId) =>
            (ledgerByRefId.get(pId) ?? []).filter(
              (e) => e.eventType === 'refund_issued',
            ),
        ),
      ];
      const uniqueRefundLedgers = new Map<string, FinancialLedgerEntry>();
      for (const r of refundLedgerEntries) {
        uniqueRefundLedgers.set(r.id, r);
      }

      let txRefundSum = 0;
      let txRefundCount = 0;
      for (const refEntry of uniqueRefundLedgers.values()) {
        if (typeof refEntry.amount === 'number' && refEntry.amount > 0) {
          txRefundSum += refEntry.amount;
          txRefundCount += 1;
        }
      }

      if (txRefundCount === 0) {
        for (const p of pendingRefunds) {
          if (p.status === 'refunded') {
            const refAmt =
              typeof p.jobContext?.refundedAmount === 'number'
                ? p.jobContext.refundedAmount
                : p.chargedAmount;
            if (typeof refAmt === 'number' && refAmt > 0) {
              txRefundSum += refAmt;
              txRefundCount += 1;
            }
          }
        }
      }

      cashRefundsIssued += txRefundSum;
      refundCount += txRefundCount;

      // ── Pages for this transaction ───────────────────────────────────────
      let rawReq: number | null = null;
      let rawPrint: number | null = null;
      let rawCol: number | null = null;
      let rawBw: number | null = null;

      if (typeof receiptRecord?.details?.printConfiguration?.copies === 'number') {
        rawReq = receiptRecord.details.printConfiguration.copies;
      }
      if (typeof receiptRecord?.colorPages === 'number') {
        rawCol = receiptRecord.colorPages;
      }
      if (typeof receiptRecord?.bwPages === 'number') {
        rawBw = receiptRecord.bwPages;
      }

      for (const l of allTxLogs) {
        if (rawReq === null) {
          const reqVal =
            l.meta?.totalPages ??
            l.meta?.totalRequested ??
            l.meta?.pagesRequested ??
            l.meta?.pages;
          if (typeof reqVal === 'number' && Number.isFinite(reqVal)) {
            rawReq = reqVal;
          }
        }
        if (rawPrint === null) {
          const printVal =
            l.meta?.pagesPrinted ??
            l.meta?.printedPages ??
            l.meta?.pagesDelivered;
          if (typeof printVal === 'number' && Number.isFinite(printVal)) {
            rawPrint = printVal;
          }
        }
        if (rawCol === null) {
          const colVal =
            l.meta?.colorPages ??
            l.meta?.colorPagesPrinted;
          if (typeof colVal === 'number' && Number.isFinite(colVal)) {
            rawCol = colVal;
          }
        }
        if (rawBw === null) {
          const bwVal =
            l.meta?.bwPages ??
            l.meta?.bwPagesPrinted;
          if (typeof bwVal === 'number' && Number.isFinite(bwVal)) {
            rawBw = bwVal;
          }
        }
      }

      if (rawReq === null && recoverySession?.context) {
        const ctxPages = recoverySession.context.totalPages;
        if (typeof ctxPages === 'number' && Number.isFinite(ctxPages)) {
          rawReq = ctxPages;
        }
      }
      if (rawPrint === null && recoverySession?.context) {
        const prVal = recoverySession.context.pagesPrinted;
        if (typeof prVal === 'number' && Number.isFinite(prVal)) {
          rawPrint = prVal;
        }
      }

      const txStatus = this.classifyTransactionStatus(txLog);
      const isCompleted =
        txStatus === 'completed' ||
        allTxLogs.some(
          (l) => this.classifyTransactionStatus(l) === 'completed',
        );

      let requested =
        typeof rawReq === 'number' && Number.isFinite(rawReq)
          ? Math.max(0, Math.floor(rawReq))
          : typeof rawPrint === 'number' && Number.isFinite(rawPrint)
            ? Math.max(0, Math.floor(rawPrint))
            : 0;

      let printed =
        typeof rawPrint === 'number' && Number.isFinite(rawPrint)
          ? Math.max(0, Math.floor(rawPrint))
          : isCompleted && requested > 0
            ? requested
            : 0;

      let failed = Math.max(0, requested - printed);

      let colPrinted = 0;
      let bwPrinted = 0;
      if (printed > 0) {
        const hasCol = typeof rawCol === 'number' && Number.isFinite(rawCol);
        const hasBw = typeof rawBw === 'number' && Number.isFinite(rawBw);
        if (hasCol && hasBw) {
          colPrinted = Math.max(0, Math.floor(rawCol!));
          bwPrinted = Math.max(0, Math.floor(rawBw!));
        } else if (hasCol) {
          colPrinted = Math.max(0, Math.floor(rawCol!));
          bwPrinted = Math.max(0, printed - colPrinted);
        } else if (hasBw) {
          bwPrinted = Math.max(0, Math.floor(rawBw!));
          colPrinted = Math.max(0, printed - bwPrinted);
        } else {
          const colorMode =
            allTxLogs.find((l) => typeof l.meta?.colorMode === 'string')?.meta
              ?.colorMode ??
            recoverySession?.context?.colorMode ??
            receiptRecord?.details?.printConfiguration?.colorMode;
          if (colorMode === 'colored' || colorMode === 'color') {
            colPrinted = printed;
            bwPrinted = 0;
          } else {
            bwPrinted = printed;
            colPrinted = 0;
          }
        }
      }

      // Check transaction mode: Document scanning produces digital scans, not printed physical pages
      const txMode =
        (typeof receiptRecord?.mode === 'string' ? receiptRecord.mode : null) ??
        (typeof recoverySession?.mode === 'string'
          ? recoverySession.mode
          : null) ??
        (txId ? txModeMap.get(txId) : null) ??
        this.inferTransactionMode(txLog);

      if (txMode === 'scan') {
        requested = 0;
        printed = 0;
        failed = 0;
        colPrinted = 0;
        bwPrinted = 0;
      } else {
        // Invariant: Cap colPrinted and bwPrinted to total printed
        if (colPrinted > printed) {
          colPrinted = printed;
        }
        if (colPrinted + bwPrinted > printed) {
          bwPrinted = Math.max(0, printed - colPrinted);
        }
      }

      totalRequested += requested;
      totalPrinted += printed;
      totalFailed += failed;
      colorPagesPrinted += colPrinted;
      bwPagesPrinted += bwPrinted;

      // ── Hardware incidents for this transaction ─────────────────────────
      const spoolerLogs = allTxLogs.filter((l) => {
        const t = l.type.toLowerCase();
        return (
          t === 'print_spooler_job_failed' ||
          t === 'spooler_failed' ||
          t === 'print_spooler_failed' ||
          t === 'print_spooler_monitor_timeout' ||
          (t.includes('spooler') && t.includes('fail'))
        );
      });

      const hasSpoolerFailure =
        spoolerLogs.length > 0 ||
        recoverySession?.phase === 'spooler_failed' ||
        pendingRefunds.some((p) =>
          p.reason?.toLowerCase().includes('spooler'),
        );

      if (hasSpoolerFailure) {
        spoolerFailures++;
        if (txId) countedSpoolerTxIds.add(txId);
        for (const l of spoolerLogs) {
          countedSpoolerLogIds.add(l.id);
        }
        countedSpoolerLogIds.add(txLog.id);
      }

      const hopperLogs = allTxLogs.filter((l) => {
        const t = l.type.toLowerCase();
        return (
          t === 'hopper_dispense_failed' ||
          t === 'hopper_dispense_shortfall' ||
          (t.startsWith('hopper_') &&
            (t.includes('fail') ||
              t.includes('shortfall') ||
              t.includes('jam')))
        );
      });

      const txOwedChanges = txId ? (owedChangesByTxId.get(txId) ?? []) : [];
      const hasHopperFailure =
        hopperLogs.length > 0 || txOwedChanges.length > 0;

      if (hasHopperFailure) {
        hopperShortfalls++;
        if (txId) countedHopperTxIds.add(txId);
        for (const l of hopperLogs) {
          countedHopperLogIds.add(l.id);
        }
        countedHopperLogIds.add(txLog.id);
      }
    }

    // Check any uncounted spooler failures in filtered logs (avoiding double counts via countedSpoolerLogIds)
    for (const l of filteredLogs) {
      if (countedSpoolerLogIds.has(l.id)) continue;
      const txId = this.getTransactionId(l);
      if (txId && countedSpoolerTxIds.has(txId)) continue;

      const t = l.type.toLowerCase();
      const isSpoolerFail =
        t === 'print_spooler_job_failed' ||
        t === 'spooler_failed' ||
        t === 'print_spooler_failed' ||
        t === 'print_spooler_monitor_timeout' ||
        (t.includes('spooler') && t.includes('fail'));
      if (isSpoolerFail) {
        spoolerFailures++;
        countedSpoolerLogIds.add(l.id);
        if (txId) countedSpoolerTxIds.add(txId);
      }
    }

    // ── Unresolved Owed Changes & Hopper Shortfalls ────────────────────────
    let unresolvedOwedChange = 0;
    let unresolvedOwedChangeCount = 0;

    const dateFromMs =
      typeof filters.dateFrom === 'string'
        ? Date.parse(filters.dateFrom)
        : NaN;
    const dateToMs =
      typeof filters.dateTo === 'string' ? Date.parse(filters.dateTo) : NaN;

    for (const oc of db.data?.owedChanges ?? []) {
      const ocTimeMs = Date.parse(oc.timestamp);
      if (Number.isFinite(dateFromMs) && ocTimeMs < dateFromMs) continue;
      if (Number.isFinite(dateToMs) && ocTimeMs > dateToMs) continue;

      const ocTxId =
        typeof oc.meta?.transactionId === 'string'
          ? oc.meta.transactionId.trim()
          : null;

      // Filter leakage guard: resolve linked transaction mode and status
      const linkedMode =
        (oc.meta?.mode as TransactionLogMode | undefined) ??
        (ocTxId ? txModeMap.get(ocTxId) : undefined);
      if (filters.mode && linkedMode && linkedMode !== filters.mode) {
        continue;
      }

      const linkedStatus = ocTxId ? txStatusMap.get(ocTxId) : undefined;
      if (filters.status && linkedStatus && linkedStatus !== filters.status) {
        continue;
      }

      if (!countedHopperLogIds.has(oc.id)) {
        if (!ocTxId || !countedHopperTxIds.has(ocTxId)) {
          hopperShortfalls++;
          if (ocTxId) countedHopperTxIds.add(ocTxId);
        }
        countedHopperLogIds.add(oc.id);
      }

      if (oc.status === 'open') {
        unresolvedOwedChange += oc.amount;
        unresolvedOwedChangeCount += 1;
      }
    }

    // Fulfillment rate percent
    const fulfillmentRatePercent =
      totalRequested > 0
        ? Math.round((totalPrinted / totalRequested) * 10000) / 100
        : 100;

    // Normalizing financials
    const round2 = (v: number) =>
      Math.round((v + Number.EPSILON) * 100) / 100;
    const finalGrossCharged = round2(grossCharged);
    const finalRefunds = round2(cashRefundsIssued);
    const finalNetRetained = round2(finalGrossCharged - finalRefunds);
    const finalUnresolvedOwedChange = round2(unresolvedOwedChange);

    return {
      scope: {
        totalTransactions,
        dateFrom,
        dateTo,
      },
      financials: {
        grossCharged: finalGrossCharged,
        cashRefundsIssued: finalRefunds,
        refundCount,
        netCashRetained: finalNetRetained,
        unresolvedOwedChange: finalUnresolvedOwedChange,
        unresolvedOwedChangeCount,
      },
      pages: {
        totalRequested,
        totalPrinted,
        totalFailed,
        fulfillmentRatePercent,
        colorPagesPrinted,
        bwPagesPrinted,
      },
      hardwareIncidents: {
        spoolerFailures,
        hopperShortfalls,
      },
    };
  }

  private groupLogsByTransaction(logs: AdminLogEntry[]): AdminLogEntry[] {
    const groups = new Map<
      string,
      { latest: AdminLogEntry; earliestTs: string }
    >();
    const withoutId: AdminLogEntry[] = [];

    for (const log of logs) {
      const id = this.getTransactionId(log);
      if (id) {
        const existing = groups.get(id);
        if (!existing) {
          groups.set(id, { latest: log, earliestTs: log.timestamp });
        } else {
          if (log.timestamp < existing.earliestTs) {
            existing.earliestTs = log.timestamp;
          }
        }
      } else {
        withoutId.push(log);
      }
    }

    const grouped: AdminLogEntry[] = [];
    for (const { latest, earliestTs } of groups.values()) {
      grouped.push({
        ...latest,
        timestamp: earliestTs,
      });
    }

    return [...grouped, ...withoutId].sort((a, b) =>
      b.timestamp < a.timestamp ? -1 : b.timestamp > a.timestamp ? 1 : 0,
    );
  }

  listLogs(limit: number): AdminLogEntry[] {
    return this.listSystemLogs(limit);
  }

  listAllLogs(): AdminLogEntry[] {
    return adminLogStore.listAll();
  }

  listLogsByTypes(types: ReadonlyArray<string>): AdminLogEntry[] {
    const normalized = Array.from(
      new Set(
        types.map((value) => value.trim()).filter((value) => value.length > 0),
      ),
    );
    if (normalized.length === 0) return [];
    return adminLogStore.listByTypes(normalized);
  }

  clearLogs(): void {
    adminLogStore.clear();
  }

  clearSystemLogs(): number {
    return adminLogStore.clearSystemLogs();
  }

  clearTransactionLogs(): number {
    return adminLogStore.clearTransactionLogs();
  }

  async incrementCoinStats(coinValue: number): Promise<void> {
    switch (coinValue) {
      case 1:
        db.data!.coinStats.one += 1;
        break;
      case 5:
        db.data!.coinStats.five += 1;
        break;
      case 10:
        db.data!.coinStats.ten += 1;
        break;
      case 20:
        db.data!.coinStats.twenty += 1;
        break;
      default:
        return;
    }

    await db.write();
  }

  async incrementJobStats(mode: PrintMode): Promise<void> {
    db.data!.jobStats.total += 1;
    switch (mode) {
      case 'print':
        db.data!.jobStats.print += 1;
        break;
      case 'copy':
        db.data!.jobStats.copy += 1;
        break;
      case 'scan':
        db.data!.jobStats.scan += 1;
        break;
    }
    await db.write();
  }

  computeEarningsBuckets(now = new Date()) {
    const allTime = db.data!.earnings;
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - 6);

    let today = 0;
    let week = 0;

    // Use date-bounded query to avoid transferring all payment logs
    const weekTimestamp = startOfWeek.toISOString();
    const seenTxIds = new Set<string>();
    const failedTxIds = new Set<string>();

    for (const log of adminLogStore.listByTypesSince(
      [
        'payment_confirmed',
        'copy_job_enqueued',
        'copy_job_completed',
        'copy_job_failed',
      ],
      weekTimestamp,
    )) {
      const txId =
        (typeof log.meta?.transactionId === 'string' &&
          log.meta.transactionId) ||
        (typeof log.meta?.jobId === 'string' && log.meta.jobId) ||
        null;
      if (txId) {
        if (log.type === 'copy_job_failed') {
          failedTxIds.add(txId);
          continue;
        }
        if (failedTxIds.has(txId)) continue;
        if (seenTxIds.has(txId)) continue;
        seenTxIds.add(txId);
      }

      const amountRaw = log.meta?.amount ?? log.meta?.chargedAmount;
      const amount =
        typeof amountRaw === 'number' ? amountRaw : Number(amountRaw);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const ts = new Date(log.timestamp);
      if (Number.isNaN(ts.getTime())) continue;

      if (ts >= startOfToday) today += amount;
      if (ts >= startOfWeek) week += amount;
    }

    return {
      today: Number(today.toFixed(2)),
      week: Number(week.toFixed(2)),
      allTime: Number(allTime.toFixed(2)),
    };
  }

  findUnreconciledCopyTransactions(
    completedReferenceIds: ReadonlySet<string>,
  ): UnreconciledCopyTransaction[] {
    const allLogs = adminLogStore.listAll();
    const failedJobIds = new Set<string>();
    const candidates = new Map<
      string,
      {
        timestamp: string;
        timestampMeta?: TrustedTimestampMeta;
        amount: number;
        hasCompletedLog: boolean;
        copies?: number;
        colorMode?: ColorMode;
      }
    >();

    for (const log of allLogs) {
      const type = log.type.toLowerCase();
      const txId = this.getTransactionId(log);
      if (!txId) continue;

      if (
        type.includes('failed') ||
        type.includes('error') ||
        type.includes('printer_malfunction')
      ) {
        if (type.startsWith('copy_') || log.meta?.mode === 'copy') {
          failedJobIds.add(txId);
        }
      }

      const isCopy =
        type === 'copy_job_completed' ||
        type === 'copy_job_enqueued' ||
        (type === 'payment_confirmed' &&
          (log.meta?.mode === 'copy' ||
            log.message.toLowerCase().includes('copy')));

      if (!isCopy) continue;

      const rawAmount = log.meta?.amount ?? log.meta?.chargedAmount;
      const amount =
        typeof rawAmount === 'number' ? rawAmount : Number(rawAmount);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const copiesRaw = log.meta?.copies;
      const copies =
        typeof copiesRaw === 'number' && Number.isFinite(copiesRaw)
          ? copiesRaw
          : undefined;
      const colorMode =
        log.meta?.colorMode === 'colored' || log.meta?.colorMode === 'grayscale'
          ? (log.meta.colorMode as ColorMode)
          : undefined;

      const existing = candidates.get(txId);
      if (!existing) {
        candidates.set(txId, {
          timestamp: log.timestamp,
          timestampMeta: log.timestampMeta,
          amount,
          hasCompletedLog: type === 'copy_job_completed',
          copies,
          colorMode,
        });
      } else {
        if (type === 'copy_job_completed') {
          existing.hasCompletedLog = true;
          existing.amount = amount;
          existing.timestamp = log.timestamp;
          if (log.timestampMeta) existing.timestampMeta = log.timestampMeta;
        } else if (!existing.hasCompletedLog) {
          existing.amount = amount;
        }
        if (copies !== undefined && existing.copies === undefined) {
          existing.copies = copies;
        }
        if (colorMode !== undefined && existing.colorMode === undefined) {
          existing.colorMode = colorMode;
        }
      }
    }

    const unreconciled: UnreconciledCopyTransaction[] = [];
    for (const [txId, candidate] of candidates.entries()) {
      if (completedReferenceIds.has(txId)) continue;
      if (failedJobIds.has(txId) && !candidate.hasCompletedLog) continue;

      unreconciled.push({
        txId,
        timestamp: candidate.timestamp,
        timestampMeta: candidate.timestampMeta,
        amount: candidate.amount,
        copies: candidate.copies,
        colorMode: candidate.colorMode,
      });
    }

    return unreconciled.sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
  }

  async reconcileMissingCopyTransactions(): Promise<number> {
    if (!db.data?.financialLedger) return 0;

    const completedReferenceIds = new Set<string>();
    for (const entry of db.data.financialLedger) {
      if (entry.eventType === 'job_completed') {
        if (
          typeof entry.referenceId === 'string' &&
          entry.referenceId.trim().length > 0
        ) {
          completedReferenceIds.add(entry.referenceId.trim());
        }
        const metaId =
          (typeof entry.meta?.transactionId === 'string' &&
            entry.meta.transactionId.trim()) ||
          (typeof entry.meta?.transaction_id === 'string' &&
            entry.meta.transaction_id.trim()) ||
          (typeof entry.meta?.jobId === 'string' && entry.meta.jobId.trim()) ||
          null;
        if (metaId) {
          completedReferenceIds.add(metaId);
        }
      }
    }

    const unreconciled = this.findUnreconciledCopyTransactions(
      completedReferenceIds,
    );
    if (unreconciled.length === 0) return 0;

    let count = 0;
    for (const item of unreconciled) {
      await financialLedgerService.append({
        eventType: 'job_completed',
        amount: item.amount,
        referenceId: item.txId,
        meta: {
          mode: 'copy',
          reconciled: true,
          source: 'historical_copy_reconciliation',
          ...(item.copies ? { copies: item.copies } : {}),
          ...(item.colorMode ? { colorMode: item.colorMode } : {}),
        },
        timestamp: item.timestamp,
        timestampMeta: item.timestampMeta,
      });
      count += 1;
    }

    return count;
  }

  private normalizeMoney(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Number(value.toFixed(2));
  }

  private startOfDay(input: Date): Date {
    const value = new Date(input);
    value.setHours(0, 0, 0, 0);
    return value;
  }

  private addDays(input: Date, days: number): Date {
    const value = new Date(input);
    value.setDate(value.getDate() + days);
    return value;
  }

  private toDateKey(input: Date): string {
    const year = input.getFullYear();
    const month = String(input.getMonth() + 1).padStart(2, '0');
    const day = String(input.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private resolveBucketKey(
    view: EarningsAnalyticsView,
    timestamp: Date,
  ): string {
    if (view === 'daily') {
      return String(timestamp.getHours());
    }
    if (view === 'yearly') {
      return String(timestamp.getMonth());
    }
    return this.toDateKey(this.startOfDay(timestamp));
  }

  private buildAnalyticsPeriod(
    view: EarningsAnalyticsView,
    anchorInput: Date,
  ): {
    start: Date;
    end: Date;
    label: string;
    buckets: EarningsAnalyticsBucket[];
  } {
    const anchor = this.startOfDay(anchorInput);

    if (view === 'daily') {
      const start = new Date(anchor);
      const end = this.addDays(start, 1);
      const buckets: EarningsAnalyticsBucket[] = [];
      for (let hour = 0; hour < 24; hour += 1) {
        const bucketStart = new Date(start);
        bucketStart.setHours(hour, 0, 0, 0);
        const bucketEnd = new Date(bucketStart);
        bucketEnd.setHours(hour + 1, 0, 0, 0);
        buckets.push({
          key: String(hour),
          label: `${String(hour).padStart(2, '0')}:00`,
          start: bucketStart.toISOString(),
          end: bucketEnd.toISOString(),
          amount: 0,
        });
      }
      return {
        start,
        end,
        label: this.dateShortFormatter.format(anchor),
        buckets,
      };
    }

    if (view === 'weekly') {
      const start = this.addDays(anchor, -6);
      const end = this.addDays(anchor, 1);
      const buckets: EarningsAnalyticsBucket[] = [];
      for (let day = 0; day < 7; day += 1) {
        const bucketStart = this.addDays(start, day);
        const bucketEnd = this.addDays(start, day + 1);
        buckets.push({
          key: this.toDateKey(bucketStart),
          label: `${new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(bucketStart)} ${bucketStart.getDate()}`,
          start: bucketStart.toISOString(),
          end: bucketEnd.toISOString(),
          amount: 0,
        });
      }
      return {
        start,
        end,
        label: `${this.dateShortFormatter.format(start)} - ${this.dateShortFormatter.format(this.addDays(end, -1))}`,
        buckets,
      };
    }

    if (view === 'monthly') {
      const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
      const buckets: EarningsAnalyticsBucket[] = [];
      const daysInMonth = new Date(
        start.getFullYear(),
        start.getMonth() + 1,
        0,
      ).getDate();
      for (let day = 1; day <= daysInMonth; day += 1) {
        const bucketStart = new Date(
          start.getFullYear(),
          start.getMonth(),
          day,
        );
        const bucketEnd = new Date(
          start.getFullYear(),
          start.getMonth(),
          day + 1,
        );
        buckets.push({
          key: this.toDateKey(bucketStart),
          label: String(day),
          start: bucketStart.toISOString(),
          end: bucketEnd.toISOString(),
          amount: 0,
        });
      }
      return {
        start,
        end,
        label: this.monthYearFormatter.format(start),
        buckets,
      };
    }

    const start = new Date(anchor.getFullYear(), 0, 1);
    const end = new Date(anchor.getFullYear() + 1, 0, 1);
    const buckets: EarningsAnalyticsBucket[] = [];
    for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
      const bucketStart = new Date(start.getFullYear(), monthIndex, 1);
      const bucketEnd = new Date(start.getFullYear(), monthIndex + 1, 1);
      buckets.push({
        key: String(monthIndex),
        label: this.monthFormatter.format(bucketStart),
        start: bucketStart.toISOString(),
        end: bucketEnd.toISOString(),
        amount: 0,
      });
    }
    return {
      start,
      end,
      label: String(start.getFullYear()),
      buckets,
    };
  }

  computeDetailedEarningsAnalytics(input: {
    view: EarningsAnalyticsView;
    anchor: Date;
    now?: Date;
  }): EarningsAnalyticsResult {
    const now = input.now ?? new Date();
    const startOfToday = this.startOfDay(now);
    const startOfWeek = this.addDays(startOfToday, -6);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const period = this.buildAnalyticsPeriod(input.view, input.anchor);
    const bucketTotals = new Map<string, number>();
    for (const bucket of period.buckets) {
      bucketTotals.set(bucket.key, 0);
    }
    const pendingRefundModes = new Map<string, EarningsMode>();
    for (const refund of db.data!.pendingRefunds) {
      const mode = refund.jobContext.mode;
      if (mode === 'print' || mode === 'copy' || mode === 'scan') {
        pendingRefundModes.set(refund.id, mode);
      }
    }

    let today = 0;
    let week = 0;
    let month = 0;
    let year = 0;
    const methodTotals: Record<EarningsMode, number> = {
      print: 0,
      copy: 0,
      scan: 0,
    };

    const completedReferenceIds = new Set<string>();

    for (const entry of db.data!.financialLedger) {
      if (entry.eventType === 'job_completed') {
        if (
          typeof entry.referenceId === 'string' &&
          entry.referenceId.trim().length > 0
        ) {
          completedReferenceIds.add(entry.referenceId.trim());
        }
        const metaId =
          (typeof entry.meta?.transactionId === 'string' &&
            entry.meta.transactionId.trim()) ||
          (typeof entry.meta?.transaction_id === 'string' &&
            entry.meta.transaction_id.trim()) ||
          (typeof entry.meta?.jobId === 'string' && entry.meta.jobId.trim()) ||
          null;
        if (metaId) {
          completedReferenceIds.add(metaId);
        }
      }

      if (
        entry.eventType !== 'job_completed' &&
        entry.eventType !== 'refund_issued'
      ) {
        continue;
      }

      const amount = Number(entry.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const timestamp = new Date(entry.timestamp);
      if (Number.isNaN(timestamp.getTime())) continue;

      const signedAmount =
        entry.eventType === 'refund_issued' ? -amount : amount;

      if (timestamp >= startOfToday) today += signedAmount;
      if (timestamp >= startOfWeek) week += signedAmount;
      if (timestamp >= startOfMonth) month += signedAmount;
      if (timestamp >= startOfYear) year += signedAmount;

      if (timestamp >= period.start && timestamp < period.end) {
        const bucketKey = this.resolveBucketKey(input.view, timestamp);
        const previous = bucketTotals.get(bucketKey);
        if (previous !== undefined) {
          bucketTotals.set(bucketKey, previous + signedAmount);
        }

        const mode =
          entry.eventType === 'refund_issued'
            ? (entry.meta?.originalMode ??
              entry.meta?.mode ??
              (typeof entry.referenceId === 'string'
                ? pendingRefundModes.get(entry.referenceId)
                : null))
            : entry.meta?.mode;

        if (mode === 'print' || mode === 'copy' || mode === 'scan') {
          methodTotals[mode] += signedAmount;
        }
      }
    }

    // In-memory reconciliation fallback: include any historical copy jobs recorded in
    // adminLogStore that haven't been persisted to financialLedger yet
    const unreconciledCopy = this.findUnreconciledCopyTransactions(
      completedReferenceIds,
    );
    if (unreconciledCopy.length > 0) {
      for (const item of unreconciledCopy) {
        const timestamp = new Date(item.timestamp);
        if (Number.isNaN(timestamp.getTime())) continue;
        const amount = item.amount;

        if (timestamp >= startOfToday) today += amount;
        if (timestamp >= startOfWeek) week += amount;
        if (timestamp >= startOfMonth) month += amount;
        if (timestamp >= startOfYear) year += amount;

        if (timestamp >= period.start && timestamp < period.end) {
          const bucketKey = this.resolveBucketKey(input.view, timestamp);
          const previous = bucketTotals.get(bucketKey);
          if (previous !== undefined) {
            bucketTotals.set(bucketKey, previous + amount);
          }
          methodTotals.copy += amount;
        }
      }

      void this.reconcileMissingCopyTransactions().catch((reconcileError) => {
        console.error(
          '[ADMIN] Background copy transaction reconciliation failed:',
          reconcileError,
        );
      });
    }

    const buckets = period.buckets.map((bucket) => ({
      ...bucket,
      amount: this.normalizeMoney(bucketTotals.get(bucket.key) ?? 0),
    }));
    const periodTotal = buckets.reduce((sum, bucket) => sum + bucket.amount, 0);

    const normalizedMethods = {
      print: this.normalizeMoney(methodTotals.print),
      copy: this.normalizeMoney(methodTotals.copy),
      scan: this.normalizeMoney(methodTotals.scan),
    };
    const methodTotal = this.normalizeMoney(
      normalizedMethods.print + normalizedMethods.copy + normalizedMethods.scan,
    );
    const topMode: EarningsMode | null =
      methodTotal <= 0
        ? null
        : (Object.entries(normalizedMethods).sort(
            (a, b) => b[1] - a[1],
          )[0][0] as EarningsMode);

    return {
      view: input.view,
      anchorDate: this.toDateKey(this.startOfDay(input.anchor)),
      period: {
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        label: period.label,
      },
      totals: {
        today: this.normalizeMoney(today),
        week: this.normalizeMoney(week),
        month: this.normalizeMoney(month),
        year: this.normalizeMoney(year),
        allTime: this.normalizeMoney(db.data!.earnings),
        period: this.normalizeMoney(periodTotal),
      },
      buckets,
      methods: {
        print: normalizedMethods.print,
        copy: normalizedMethods.copy,
        scan: normalizedMethods.scan,
        total: methodTotal,
        topMode,
      },
    };
  }

  private computePercentile(
    values: number[],
    percentile: number,
  ): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];
    const index = (percentile / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    const weight = index - lower;
    return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
  }

  private summarizeLatencies(values: number[]): DispatchLatencyPercentiles {
    const p50 = this.computePercentile(values, 50);
    const p95 = this.computePercentile(values, 95);
    return {
      p50: p50 === null ? null : Math.round(p50),
      p95: p95 === null ? null : Math.round(p95),
      sampleCount: values.length,
    };
  }

  computeDispatchLatencyMetrics(
    maxEvents = 5000,
  ): DispatchLatencyMetricsResult {
    const safeMaxEvents = Number.isFinite(maxEvents)
      ? Math.max(100, Math.min(20_000, Math.floor(maxEvents)))
      : 5000;
    const logs = adminLogStore
      .listByTypes([
        'print_dispatch_summary',
        'print_spooler_confirmed',
        'print_spooler_job_failed',
        'print_spooler_auto_refund',
        'print_spooler_monitor_timeout',
        'print_spooler_monitor_unavailable',
      ])
      .slice(0, safeMaxEvents);

    const dispatchByTransaction = new Map<
      string,
      {
        dispatchedAtMs: number;
        mimeType: string;
        engine: string;
      }
    >();
    const terminalByTransaction = new Map<string, number>();

    for (const log of logs) {
      const transactionId =
        typeof log.meta?.transactionId === 'string'
          ? log.meta.transactionId.trim()
          : '';
      if (!transactionId) continue;
      const timestampMs = Date.parse(log.timestamp);
      if (!Number.isFinite(timestampMs)) continue;

      if (log.type === 'print_dispatch_summary') {
        const engine =
          typeof log.meta?.selectedEngine === 'string'
            ? log.meta.selectedEngine
            : null;
        if (!engine) continue;
        const mimeType =
          typeof log.meta?.mimeType === 'string' && log.meta.mimeType.length > 0
            ? log.meta.mimeType
            : 'application/octet-stream';
        const existing = dispatchByTransaction.get(transactionId);
        if (!existing || timestampMs >= existing.dispatchedAtMs) {
          dispatchByTransaction.set(transactionId, {
            dispatchedAtMs: timestampMs,
            mimeType,
            engine,
          });
        }
        continue;
      }

      const existingTerminal = terminalByTransaction.get(transactionId);
      if (!existingTerminal || timestampMs >= existingTerminal) {
        terminalByTransaction.set(transactionId, timestampMs);
      }
    }

    const mimeSamples = new Map<string, number[]>();
    const engineSamples = new Map<string, number[]>();

    for (const [
      transactionId,
      dispatchMeta,
    ] of dispatchByTransaction.entries()) {
      const terminalAtMs = terminalByTransaction.get(transactionId);
      if (terminalAtMs === undefined || !Number.isFinite(terminalAtMs))
        continue;
      const latencyMs = terminalAtMs - dispatchMeta.dispatchedAtMs;
      if (!Number.isFinite(latencyMs) || latencyMs < 0) continue;

      const byMime = mimeSamples.get(dispatchMeta.mimeType) ?? [];
      byMime.push(latencyMs);
      mimeSamples.set(dispatchMeta.mimeType, byMime);

      const byEngine = engineSamples.get(dispatchMeta.engine) ?? [];
      byEngine.push(latencyMs);
      engineSamples.set(dispatchMeta.engine, byEngine);
    }

    const byMimeType = Array.from(mimeSamples.entries())
      .map(([mimeType, values]) => ({
        mimeType,
        ...this.summarizeLatencies(values),
      }))
      .sort((a, b) => b.sampleCount - a.sampleCount);

    const byEngine = Array.from(engineSamples.entries())
      .map(([engine, values]) => ({
        engine,
        ...this.summarizeLatencies(values),
      }))
      .sort((a, b) => b.sampleCount - a.sampleCount);

    const pdfBucket = byMimeType.find(
      (bucket) => bucket.mimeType === 'application/pdf',
    );
    const nonPdfP95Values = byMimeType
      .filter((bucket) => bucket.mimeType !== 'application/pdf')
      .map((bucket) => bucket.p95)
      .filter((value): value is number => value !== null);
    const worstNonPdfP95 =
      nonPdfP95Values.length > 0 ? Math.max(...nonPdfP95Values) : null;
    const thresholdPercent = 30;
    const baselinePdfP95 = pdfBucket?.p95 ?? null;
    const confirmed =
      baselinePdfP95 !== null &&
      worstNonPdfP95 !== null &&
      worstNonPdfP95 >= baselinePdfP95 * (1 + thresholdPercent / 100);

    return {
      generatedAt: new Date().toISOString(),
      sampleCount: Array.from(mimeSamples.values()).reduce(
        (sum, values) => sum + values.length,
        0,
      ),
      byMimeType,
      byEngine,
      speculation: {
        baselinePdfP95,
        worstNonPdfP95,
        thresholdPercent,
        confirmed,
      },
    };
  }

  getStorageUsage(uploadDir: string): { fileCount: number; bytes: number } {
    const dirPath = path.resolve(uploadDir);
    if (!fs.existsSync(dirPath)) {
      return { fileCount: 0, bytes: 0 };
    }

    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    let bytes = 0;
    let fileCount = 0;

    for (const item of items) {
      if (!item.isFile()) continue;
      const fullPath = path.join(dirPath, item.name);
      const stat = fs.statSync(fullPath);
      bytes += stat.size;
      fileCount += 1;
    }

    return { fileCount, bytes };
  }

  async resetInkRefillBaseline(
    colorPages: number,
    bwPages: number,
  ): Promise<void> {
    const trusted = getTrustedTimestamp();
    db.data!.inkRefillBaseline = {
      colorPages,
      bwPages,
      updatedAt: trusted.timestamp,
    };
    await db.write();
    await this.appendAdminLog(
      'ink_refill_reset',
      `Ink refill counters reset to ${colorPages} color and ${bwPages} B&W pages.`,
    );
  }

  logsToCsv(logs: AdminLogEntry[]): string {
    const escapeCsv = (value: unknown): string => {
      const text = value == null ? '' : String(value);
      const escaped = text.replace(/"/g, '""');
      return `"${escaped}"`;
    };

    const header = ['timestamp', 'type', 'message', 'meta'].join(',');
    const rows = logs.map((log) => {
      const metaText = log.meta ? JSON.stringify(log.meta) : '';
      return [
        escapeCsv(log.timestamp),
        escapeCsv(log.type),
        escapeCsv(log.message),
        escapeCsv(metaText),
      ].join(',');
    });

    return [header, ...rows].join('\n');
  }
}

export const adminService = new AdminService();
