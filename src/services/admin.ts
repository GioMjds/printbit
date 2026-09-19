import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {
  db,
  type AdminLogEntry,
  type ColorMode,
  type LogMeta,
  type PrintMode,
  type PricingSettings,
  type PrintQuality,
  type PipelineSettings,
} from './db';
import { getTrustedTimestamp } from './time-source';
import { adminLogStore } from '@/core/database/sqlite-storage';
import { adminService as moduleAdminService } from '@/modules/admin/admin.service';

const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = {
  malwareScanningEnabled: true,
  documentConversionEnabled: true,
  colorDetectionEnabled: true,
};

interface SocketEmitter {
  emit: (event: string, ...args: unknown[]) => void;
}

class AdminService {
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
    colorOrPageCounts: ColorMode | { colorPages: number; bwPages: number },
    copies: number,
    paperSize: 'A4' | 'Letter' | 'Legal' = 'A4',
    quality: PrintQuality = 'standard',
  ): number {
    const safeCopies = Math.max(1, Math.floor(copies));
    const pricing = this.getPricingSettings();
    const engineCfg = db.data?.settings?.pricingEngine;

    if (mode === 'scan') {
      return pricing.scanDocument;
    }

    // Pricing Engine logic is now mandatory
    const profileKey =
      paperSize === 'Legal' ? 'longBond' : paperSize === 'Letter' ? 'shortBond' : 'a4';
    const profile = engineCfg?.paperProfiles?.[profileKey] ?? {
      baseBwPrice: profileKey === 'longBond' ? 4 : 3,
      baseColorPrice: profileKey === 'longBond' ? 20 : 18,
      baseImagePrice: profileKey === 'longBond' ? 30 : 25,
    };
    const baseImagePrice =
      profile.baseImagePrice ?? (profileKey === 'longBond' ? 30 : 25);

    const counts =
      typeof colorOrPageCounts === 'string'
        ? {
            colorPages: colorOrPageCounts === 'colored' ? 1 : 0,
            bwPages: colorOrPageCounts === 'colored' ? 0 : 1,
            imagePages: 0,
          }
        : colorOrPageCounts;
    const safeColorPages = Math.max(0, Math.floor(counts.colorPages ?? 0));
    const safeBwPages = Math.max(0, Math.floor(counts.bwPages ?? 0));
    const safeImagePages = Math.max(
      0,
      Math.floor('imagePages' in counts && counts.imagePages ? counts.imagePages : 0),
    );
    const surchargePerPg =
      quality === 'high'
        ? (engineCfg?.highQualitySurcharge ?? pricing?.highQualitySurcharge ?? 2)
        : 0;
    const totalPages = safeColorPages + safeBwPages + safeImagePages;
    const subtotalExact =
      (safeColorPages * profile.baseColorPrice +
        safeBwPages * profile.baseBwPrice +
        safeImagePages * baseImagePrice +
        totalPages * surchargePerPg) *
      safeCopies;
    return Math.ceil(subtotalExact);
  }

  calculateDocumentAmount(
    mode: Exclude<PrintMode, 'scan'>,
    pageCounts: { colorPages: number; bwPages: number; imagePages?: number },
    copies: number,
    paperSize: 'A4' | 'Letter' | 'Legal' = 'A4',
    quality: PrintQuality = 'standard',
  ): number {
    return this.calculateJobAmount(mode, pageCounts, copies, paperSize, quality);
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
