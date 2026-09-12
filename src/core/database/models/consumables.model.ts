import { getSqliteDb } from '../sqlite-storage';
import { db as runtimeDb } from '../db';

export interface ConsumableUsageEventEntry {
  id: string;
  timestamp: string;
  transactionId: string;
  mode: 'print' | 'copy';
  copies: number;
  duplex: boolean;
  selectedPages: number;
  billableColorPages: number;
  billableBwPages: number;
  estimatedSheetsUsed: number;
  estimatedInkUnits: Record<string, number>;
  billingPageDetection:
    | 'high-confidence-page-detection'
    | 'fallback-assumptions';
  analysisConfidence: 'high' | 'medium' | 'low' | 'unknown';
  source: string;
}

export interface ConsumableInkSnapshotSupply {
  name: string;
  level: number | null;
  status: 'ok' | 'low' | 'empty' | 'unknown';
}

export interface ConsumableInkSnapshotEntry {
  id: string;
  timestamp: string;
  printerName: string | null;
  inkDetectionMethod:
    | 'snmp'
    | 'vendor-wmi'
    | 'printer-property'
    | 'error-state'
    | 'none';
  inkTelemetryAvailable: boolean;
  inkTelemetryReason: string | null;
  supplies: ConsumableInkSnapshotSupply[];
}

export interface InkHistoryEntry {
  id: string;
  timestamp: string;
  printerName: string | null;
  printerStatus: string;
  inkDetectionMethod:
    | 'snmp'
    | 'vendor-wmi'
    | 'printer-property'
    | 'error-state'
    | 'none';
  inkTelemetryAvailable: boolean;
  inkTelemetryReason: string | null;
  supplies: Array<{
    name: string;
    level: number | null;
    status: 'ok' | 'low' | 'empty' | 'unknown';
  }>;
}

export interface InkRefillBaseline {
  colorPages: number;
  bwPages: number;
  updatedAt: string | null;
}

export const ADMIN_TEST_PAGE_USAGE_SOURCE = 'admin-test-page';

const DAY_MS = 24 * 60 * 60 * 1000;
const CONSUMABLE_TELEMETRY_RETENTION_DAYS = parsePositiveIntEnv(
  process.env.PRINTBIT_CONSUMABLE_TELEMETRY_RETENTION_DAYS,
  90,
);
const CONSUMABLE_TELEMETRY_CLEANUP_INTERVAL_MS = parsePositiveIntEnv(
  process.env.PRINTBIT_CONSUMABLE_TELEMETRY_CLEANUP_INTERVAL_MS,
  60 * 60 * 1000,
);

let lastConsumableTelemetryCleanupAtMs = 0;

function parsePositiveIntEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseJsonValue<T>(value: unknown): T | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export class ConsumablesSqliteStore {
  appendUsageEvent(entry: ConsumableUsageEventEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT OR REPLACE INTO consumable_usage_events (
          id,
          timestamp,
          transaction_id,
          mode,
          copies,
          duplex,
          selected_pages,
          billable_color_pages,
          billable_bw_pages,
          estimated_sheets_used,
          estimated_ink_units_json,
          source,
          billing_page_detection,
          analysis_confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.timestamp,
        entry.transactionId,
        entry.mode,
        entry.copies,
        entry.duplex ? 1 : 0,
        entry.selectedPages,
        entry.billableColorPages,
        entry.billableBwPages,
        entry.estimatedSheetsUsed,
        JSON.stringify(entry.estimatedInkUnits),
        entry.source,
        entry.billingPageDetection,
        entry.analysisConfidence,
      );
    this.maybePruneOldTelemetryRows();
  }

  listUsageEventsSince(sinceTimestamp: string): ConsumableUsageEventEntry[] {
    const rows = getSqliteDb()
      .prepare(
        `SELECT
          id,
          timestamp,
          transaction_id,
          mode,
          copies,
          duplex,
          selected_pages,
          billable_color_pages,
          billable_bw_pages,
          estimated_sheets_used,
          estimated_ink_units_json,
          source,
          billing_page_detection,
          analysis_confidence
         FROM consumable_usage_events
         WHERE timestamp >= ?
         ORDER BY timestamp DESC, rowid DESC`,
      )
      .all(sinceTimestamp) as Array<Record<string, unknown>>;

    return rows.map((row) => this.toUsageEventEntry(row));
  }

  sumUsagePagesBySource(
    source: string,
    sinceTimestamp?: string,
  ): { colorPages: number; bwPages: number } {
    const row = getSqliteDb()
      .prepare(
        `SELECT
          SUM(COALESCE(billable_color_pages, 0) * COALESCE(copies, 1)) AS color_sum,
          SUM(COALESCE(billable_bw_pages, 0) * COALESCE(copies, 1)) AS bw_sum
          FROM consumable_usage_events
          WHERE source = ?${sinceTimestamp ? ' AND timestamp >= ?' : ''}`,
      )
      .get(...(sinceTimestamp ? [source, sinceTimestamp] : [source])) as
      | Record<string, unknown>
      | undefined;

    return {
      colorPages: Number(row?.color_sum ?? 0),
      bwPages: Number(row?.bw_sum ?? 0),
    };
  }

  appendInkSnapshot(entry: ConsumableInkSnapshotEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT OR REPLACE INTO consumable_ink_snapshots (
          id,
          timestamp,
          printer_name,
          ink_detection_method,
          ink_telemetry_available,
          ink_telemetry_reason,
          supplies_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.timestamp,
        entry.printerName,
        entry.inkDetectionMethod,
        entry.inkTelemetryAvailable ? 1 : 0,
        entry.inkTelemetryReason,
        JSON.stringify(entry.supplies),
      );
    this.maybePruneOldTelemetryRows();
  }

  listInkSnapshotsSince(sinceTimestamp: string): ConsumableInkSnapshotEntry[] {
    const rows = getSqliteDb()
      .prepare(
        `SELECT
          id,
          timestamp,
          printer_name,
          ink_detection_method,
          ink_telemetry_available,
          ink_telemetry_reason,
          supplies_json
         FROM consumable_ink_snapshots
         WHERE timestamp >= ?
         ORDER BY timestamp DESC, rowid DESC`,
      )
      .all(sinceTimestamp) as Array<Record<string, unknown>>;

    return rows.map((row) => this.toInkSnapshotEntry(row));
  }

  async updatePaperRefill(
    nextCapacity: number,
    nextCurrentSheets: number,
    updatedAt: string,
  ): Promise<void> {
    const normalizedCapacity = Math.max(1, Math.floor(nextCapacity));
    const normalizedCurrentSheets = Math.max(
      0,
      Math.min(Math.floor(nextCurrentSheets), normalizedCapacity),
    );
    getSqliteDb();
    if (!runtimeDb.data) await runtimeDb.read();
    if (!runtimeDb.data)
      throw new Error('Runtime database was not initialized properly.');
    runtimeDb.data!.settings.consumablesForecasting.paperTrayCapacitySheets =
      normalizedCapacity;
    runtimeDb.data!.settings.consumablesForecasting.paperCurrentSheets =
      normalizedCurrentSheets;
    runtimeDb.data!.settings.consumablesForecasting.paperRefillUpdatedAt =
      updatedAt;
    await runtimeDb.write();
  }

  private maybePruneOldTelemetryRows(): void {
    const nowMs = Date.now();
    if (
      nowMs - lastConsumableTelemetryCleanupAtMs <
      CONSUMABLE_TELEMETRY_CLEANUP_INTERVAL_MS
    ) {
      return;
    }
    lastConsumableTelemetryCleanupAtMs = nowMs;
    const cutoffIso = new Date(
      nowMs - CONSUMABLE_TELEMETRY_RETENTION_DAYS * DAY_MS,
    ).toISOString();
    try {
      const db = getSqliteDb();
      db.prepare(
        `DELETE FROM consumable_usage_events
         WHERE timestamp < ? AND source <> ?`,
      ).run(cutoffIso, ADMIN_TEST_PAGE_USAGE_SOURCE);
      db.prepare(
        'DELETE FROM consumable_ink_snapshots WHERE timestamp < ?',
      ).run(cutoffIso);
    } catch (error) {
      console.warn(
        '[SQLITE-STORAGE] Failed to prune old consumables telemetry rows.',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private toUsageEventEntry(
    row: Record<string, unknown>,
  ): ConsumableUsageEventEntry {
    const mode = row.mode === 'copy' ? 'copy' : 'print';
    return {
      id: String(row.id ?? ''),
      timestamp: String(row.timestamp ?? ''),
      transactionId: String(row.transaction_id ?? ''),
      mode,
      copies: Number(row.copies ?? 0),
      duplex: Number(row.duplex ?? 0) === 1,
      selectedPages: Number(row.selected_pages ?? 0),
      billableColorPages: Number(row.billable_color_pages ?? 0),
      billableBwPages: Number(row.billable_bw_pages ?? 0),
      estimatedSheetsUsed: Number(row.estimated_sheets_used ?? 0),
      estimatedInkUnits: this.toEstimatedInkUnits(row.estimated_ink_units_json),
      source: String(row.source ?? ''),
      billingPageDetection:
        row.billing_page_detection === 'high-confidence-page-detection'
          ? 'high-confidence-page-detection'
          : 'fallback-assumptions',
      analysisConfidence:
        row.analysis_confidence === 'high' ||
        row.analysis_confidence === 'medium' ||
        row.analysis_confidence === 'low'
          ? row.analysis_confidence
          : 'unknown',
    };
  }

  private toEstimatedInkUnits(value: unknown): Record<string, number> {
    const parsed = parseJsonValue<unknown>(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const output: Record<string, number> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
        output[key] = raw;
      }
    }
    return output;
  }

  private toInkSnapshotEntry(
    row: Record<string, unknown>,
  ): ConsumableInkSnapshotEntry {
    const parsedSupplies =
      parseJsonValue<unknown>(row.supplies_json) ?? ([] as unknown[]);
    const supplies = Array.isArray(parsedSupplies)
      ? parsedSupplies
          .map((item) => {
            if (typeof item !== 'object' || item === null) return null;
            const candidate = item as Record<string, unknown>;
            const status =
              candidate.status === 'ok' ||
              candidate.status === 'low' ||
              candidate.status === 'empty'
                ? candidate.status
                : 'unknown';
            return {
              name: String(candidate.name ?? 'Supply'),
              level:
                typeof candidate.level === 'number' &&
                Number.isFinite(candidate.level)
                  ? candidate.level
                  : null,
              status,
            } as ConsumableInkSnapshotSupply;
          })
          .filter(
            (value): value is ConsumableInkSnapshotSupply => value !== null,
          )
      : [];
    const detectionMethod =
      row.ink_detection_method === 'snmp' ||
      row.ink_detection_method === 'vendor-wmi' ||
      row.ink_detection_method === 'printer-property' ||
      row.ink_detection_method === 'error-state'
        ? row.ink_detection_method
        : 'none';

    return {
      id: String(row.id ?? ''),
      timestamp: String(row.timestamp ?? ''),
      printerName:
        typeof row.printer_name === 'string' ? row.printer_name : null,
      inkDetectionMethod: detectionMethod,
      inkTelemetryAvailable: Number(row.ink_telemetry_available ?? 0) === 1,
      inkTelemetryReason:
        typeof row.ink_telemetry_reason === 'string'
          ? row.ink_telemetry_reason
          : null,
      supplies,
    };
  }
}

export const consumablesStore = new ConsumablesSqliteStore();
