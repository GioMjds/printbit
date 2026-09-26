import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {
  db,
  type AdminLogEntry,
  type ColorMode,
  type CoverageTier,
  type LogMeta,
  type PrintMode,
  type PricingSettings,
  type PrintQuality,
  type PipelineSettings,
  defaultPricingEngine,
} from './db';
import { getTrustedTimestamp } from './time-source';
import { adminLogStore } from '@/core/database/sqlite-storage';
import { adminService as moduleAdminService } from '@/modules/admin/admin.service';

const DEFAULT_PIPELINE_SETTINGS = {
  malwareScanningEnabled: true,
  documentConversionEnabled: true,
  colorDetectionEnabled: true,
} satisfies PipelineSettings;

interface SocketEmitter {
  emit: (event: string, ...args: unknown[]) => void;
}

export class AdminService {
  private readonly MAX_LOGS = 3000;
  private io: SocketEmitter | null = null;

  setSocketIo(io: SocketEmitter | null): void {
    this.io = io;
  }

  getPricingSettings(): PricingSettings {
    return db.data!.settings.pricing;
  }

  getPipelineSettings(): PipelineSettings {
    return db.data?.settings?.pipelineSettings ?? DEFAULT_PIPELINE_SETTINGS;
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
    duplex?: boolean,
  ): number {
    const safeCopies = Math.max(1, Math.floor(copies));
    const pricing = this.getPricingSettings();
    const engineCfg = db.data?.settings?.pricingEngine;

    if (mode === 'scan') {
      return pricing.scanDocument;
    }

    const profileKey =
      paperSize === 'Long' || (paperSize as string) === 'Legal'
        ? 'longBond'
        : paperSize === 'Short' || (paperSize as string) === 'Letter'
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
      Math.floor('imagePages' in counts && counts.imagePages ? counts.imagePages : 0),
    );
    const safeImageBwPages = Math.max(
      0,
      Math.floor(
        'imageBwPages' in counts && counts.imageBwPages ? counts.imageBwPages : 0,
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

    const duplexAllowed = Boolean(engineCfg?.duplexEnabled);
    const isDuplex = duplexAllowed && Boolean(duplex);
    const physicalSheetsPerCopy = isDuplex ? Math.ceil(totalPages / 2) : totalPages;
    const paperSubtotalPerCopy = physicalSheetsPerCopy * profile.paperCost;
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
    duplex?: boolean,
  ): number {
    return this.calculateJobAmount(mode, pageCounts, copies, paperSize, quality, duplex);
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

  listLogs(limit: number): AdminLogEntry[] {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(1000, Math.floor(limit)))
      : 200;
    return adminLogStore.list(safeLimit);
  }

  listAllLogs(): AdminLogEntry[] {
    return adminLogStore.listAll();
  }

  listLogsByTypes(types: ReadonlyArray<string>): AdminLogEntry[] {
    const normalized = Array.from(
      new Set(types.map((value) => value.trim()).filter((value) => value.length > 0)),
    );
    if (normalized.length === 0) return [];
    return adminLogStore.listByTypes(normalized);
  }

  clearLogs(): void {
    // Note: adminLogStore.clear() is synchronous (calls getSqliteDb().exec('DELETE FROM admin_logs'))
    // but we keep void return for API consistency with other mutation methods
    adminLogStore.clear();
  }

  async incrementCoinStats(coinValue: number): Promise<void> {
    // if (coinValue === 1) db.data!.coinStats.one += 1;
    // else if (coinValue === 5) db.data!.coinStats.five += 1;
    // else if (coinValue === 10) db.data!.coinStats.ten += 1;
    // else if (coinValue === 20) db.data!.coinStats.twenty += 1;
    // else return;
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
      ['payment_confirmed', 'copy_job_enqueued', 'copy_job_completed', 'copy_job_failed'],
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

  async reconcileMissingCopyTransactions(): Promise<number> {
    return moduleAdminService.reconcileMissingCopyTransactions();
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
