import { getSqliteDb, withTransaction } from '../sqlite-storage';
import { LogMeta, TrustedTimestampMeta, SupportedLanguage } from '../shared.schema';
import { AnomalySeverity } from './anomaly-incident.model';

export type AdminLockout = {
  failedAttempts: number;
  lockedUntil: string | null;
};

export interface PricingSettings {
  printPerPage: number;
  copyPerPage: number;
  scanDocument: number;
  colorSurcharge: number;
  highQualitySurcharge: number;
}

export type PricingEngineRoundingMode = 'whole_peso_total_only';

export interface PricingEnginePaperProfile {
  baseBwPrice: number;
  baseColorPrice: number;
}

export interface PricingEngineBulkDiscountTier {
  minPages: number;
  maxPages?: number;
  discountPerPage: number;
}

export interface PricingEngineSettings {
  paperProfiles: {
    a4: PricingEnginePaperProfile;
    shortBond: PricingEnginePaperProfile;
    longBond: PricingEnginePaperProfile;
  };
  bulkDiscountTiers: PricingEngineBulkDiscountTier[];
  rounding: PricingEngineRoundingMode;
  highQualitySurcharge: number;
}

export type InkTelemetryUnknownPolicy = 'warn_allow' | 'block';

export interface InkMonitoringSettings {
  enabled: boolean;
  targetPrinterName: string | null;
  lowThresholdPercent: number;
  criticalThresholdPercent: number;
  blockOnLow: boolean;
  blockOnEmpty: boolean;
  telemetryUnknownPolicy: InkTelemetryUnknownPolicy;
}

export interface ConsumablesForecastingSettings {
  enabled: boolean;
  rollingWindowDays: number;
  alertDaysThreshold: number;
  paperTrayCapacitySheets: number;
  paperCurrentSheets: number;
  paperRefillUpdatedAt: string | null;
}

export interface ConsumableEstimationCoefficients {
  bwBlack: number;
  colorCyan: number;
  colorMagenta: number;
  colorYellow: number;
  colorBlack: number;
}

export interface ConsumableEstimationSettings {
  defaultCoefficients: ConsumableEstimationCoefficients;
  printerOverrides: Record<string, Partial<ConsumableEstimationCoefficients>>;
}

export type ScanFilenameDateFormat = 'YYYY-MM-DD' | 'YYYYMMDD' | 'DD-MM-YYYY' | 'none';
export type ScanFilenameTimeFormat = 'HH-mm-ss' | 'HHmmss' | 'HHmm' | 'none';

export interface ScanFilenameFormatSettings {
  prefix: string;
  dateFormat: ScanFilenameDateFormat;
  timeFormat: ScanFilenameTimeFormat;
  includeRandomSuffix: boolean;
  customPatternEnabled: boolean;
  customPattern: string;
}

export interface KioskPreferences {
  language: SupportedLanguage;
  highContrast: boolean;
}

export interface AlertDashboardSettings {
  enabled: boolean;
}

export interface AlertEmailSettings {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  username: string;
  from: string;
  to: string;
}

export interface AlertDedupeSettings {
  printerMs: number;
  spoolerMs: number;
  serialMs: number;
  hopperMs: number;
  networkMs: number;
  securityMs: number;
}

export interface AlertSettings {
  severityThreshold: AnomalySeverity;
  dashboard: AlertDashboardSettings;
  email: AlertEmailSettings;
  dedupe: AlertDedupeSettings;
}

export interface AdminSettings {
  pricing: PricingSettings;
  pricingEngine: PricingEngineSettings;
  idleTimeoutSeconds: number;
  idleScreenTimeoutSeconds: number;
  adminPin: string;
  adminLocalOnly: boolean;
  kioskPreferences: KioskPreferences;
  alerts: AlertSettings;
  inkMonitoring: InkMonitoringSettings;
  consumablesForecasting: ConsumablesForecastingSettings;
  consumableEstimation: ConsumableEstimationSettings;
  scanFilenameFormat: ScanFilenameFormatSettings;
}

export interface AdminLogEntry {
  id: string;
  timestamp: string;
  timestampMeta?: TrustedTimestampMeta;
  type: string;
  message: string;
  meta?: LogMeta;
}

// Local helpers for parser normalizations
function parseJsonValue<T>(value: unknown): T | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function normalizeTrustedTimestampMeta(
  value: unknown,
): TrustedTimestampMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const source = candidate.source === 'ntp' ? 'ntp' : 'system';
  const synced =
    typeof candidate.synced === 'boolean' ? candidate.synced : false;
  const offsetMs =
    typeof candidate.offsetMs === 'number' &&
    Number.isFinite(candidate.offsetMs)
      ? candidate.offsetMs
      : null;
  const detail = typeof candidate.detail === 'string' ? candidate.detail : null;

  return {
    source,
    synced,
    offsetMs,
    detail,
  };
}

function normalizeLogMeta(value: unknown): LogMeta | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const out: LogMeta = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean' ||
      entry === null
    ) {
      out[key] = entry;
    }
  }
  return out;
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function changesFromRun(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const candidate = result as { changes?: unknown };
  return typeof candidate.changes === 'number' && Number.isInteger(candidate.changes)
    ? candidate.changes
    : 0;
}

export class AdminLogSqliteStore {
  append(entry: AdminLogEntry, maxRows: number): void {
    try {
      withTransaction(() => {
        const db = getSqliteDb();
        db.prepare(
          `INSERT INTO admin_logs (
            id,
            timestamp,
            timestamp_meta_json,
            type,
            message,
            meta_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.id,
          entry.timestamp,
          jsonOrNull(entry.timestampMeta),
          entry.type,
          entry.message,
          jsonOrNull(entry.meta),
        );
        db.prepare(
          `DELETE FROM admin_logs
           WHERE rowid NOT IN (
             SELECT rowid
             FROM admin_logs
             ORDER BY timestamp DESC, rowid DESC
             LIMIT ?
           )`,
        ).run(Math.max(1, Math.floor(maxRows)));
      });
    } catch (error) {
      console.error('[SQLITE] Failed to append admin log.', {
        error: error instanceof Error ? error.message : String(error),
        type: entry.type,
      });
      throw error;
    }
  }

  list(limit: number): AdminLogEntry[] {
    const db = getSqliteDb();
    const rows = db
      .prepare(
        `SELECT
          id,
          timestamp,
          timestamp_meta_json,
          type,
          message,
          meta_json
         FROM admin_logs
         ORDER BY timestamp DESC, rowid DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as Array<Record<string, unknown>>;

    return rows.map((row) => this.toLogEntry(row));
  }

  listAll(): AdminLogEntry[] {
    const db = getSqliteDb();
    const rows = db
      .prepare(
        `SELECT
          id,
          timestamp,
          timestamp_meta_json,
          type,
          message,
          meta_json
         FROM admin_logs
         ORDER BY timestamp DESC, rowid DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => this.toLogEntry(row));
  }

  listByTypes(types: ReadonlyArray<string>): AdminLogEntry[] {
    if (types.length === 0) return [];
    const db = getSqliteDb();
    const placeholders = types.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT
          id,
          timestamp,
          timestamp_meta_json,
          type,
          message,
          meta_json
         FROM admin_logs
         WHERE type IN (${placeholders})
         ORDER BY timestamp DESC, rowid DESC`,
      )
      .all(...types) as Array<Record<string, unknown>>;

    return rows.map((row) => this.toLogEntry(row));
  }

  listByTypesSince(
    types: ReadonlyArray<string>,
    sinceTimestamp: string,
  ): AdminLogEntry[] {
    if (types.length === 0) return [];
    const db = getSqliteDb();
    const placeholders = types.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT
          id,
          timestamp,
          timestamp_meta_json,
          type,
          message,
          meta_json
         FROM admin_logs
         WHERE type IN (${placeholders})
           AND timestamp >= ?
         ORDER BY timestamp DESC, rowid DESC`,
      )
      .all(...types, sinceTimestamp) as Array<Record<string, unknown>>;

    return rows.map((row) => this.toLogEntry(row));
  }

  clear(): void {
    getSqliteDb().exec('DELETE FROM admin_logs');
  }

  deleteByIds(ids: ReadonlyArray<string>): number {
    const normalizedIds = Array.from(
      new Set(
        ids.map((value) => value.trim()).filter((value) => value.length > 0),
      ),
    );
    if (normalizedIds.length === 0) return 0;

    return withTransaction(() => {
      const db = getSqliteDb();
      let deleted = 0;
      const chunkSize = 400;
      for (let index = 0; index < normalizedIds.length; index += chunkSize) {
        const chunk = normalizedIds.slice(index, index + chunkSize);
        const placeholders = chunk.map(() => '?').join(', ');
        const result = db
          .prepare(`DELETE FROM admin_logs WHERE id IN (${placeholders})`)
          .run(...chunk);
        deleted += changesFromRun(result);
      }
      return deleted;
    });
  }

  private toLogEntry(row: Record<string, unknown>): AdminLogEntry {
    const timestampMeta = normalizeTrustedTimestampMeta(
      parseJsonValue<unknown>(row.timestamp_meta_json),
    );
    const meta = normalizeLogMeta(parseJsonValue<unknown>(row.meta_json));
    return {
      id: String(row.id ?? ''),
      timestamp: String(row.timestamp ?? ''),
      timestampMeta,
      type: String(row.type ?? ''),
      message: String(row.message ?? ''),
      meta,
    };
  }
}

export const adminLogStore = new AdminLogSqliteStore();
