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
} from './db';

class AdminService {
  private readonly MAX_LOGS = 3000;

  getPricingSettings(): PricingSettings {
    return db.data!.settings.pricing;
  }

  calculateJobAmount(
    mode: PrintMode,
    colorMode: ColorMode,
    copies: number,
  ): number {
    const safeCopies = Math.max(1, Math.floor(copies));
    const pricing = this.getPricingSettings();

    if (mode === 'scan') {
      return pricing.scanDocument;
    }

    const base = mode === 'print' ? pricing.printPerPage : pricing.copyPerPage;
    const color = colorMode === 'colored' ? pricing.colorSurcharge : 0;
    return (base + color) * safeCopies;
  }

  async appendAdminLog(
    type: string,
    message: string,
    meta?: LogMeta,
  ): Promise<AdminLogEntry> {
    const entry: AdminLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      message,
      meta,
    };

    db.data!.logs.unshift(entry);
    if (db.data!.logs.length > this.MAX_LOGS) {
      db.data!.logs.length = this.MAX_LOGS;
    }
    await db.write();
    return entry;
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

    for (const log of db.data!.logs) {
      if (log.type !== 'payment_confirmed') continue;
      const amountRaw = log.meta?.amount;
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
