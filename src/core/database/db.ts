import fs from 'node:fs';
import { finiteOr } from '@/utils';
import { ANALYSIS_ALGORITHM_VERSION } from '@/services/document-analysis';
import {
  clearLowDbImportMarker,
  clearStalePricingAnalysisCache,
  importLowDbSnapshotIfNeeded,
  initSqliteStorage,
  migrateSchemaSnapshotToRuntimeState,
  readRuntimeState,
  writeRuntimeState,
} from './sqlite-storage';
import { PrintJobState, PrintJobEntry } from './models/print-job.model';
import {
  SpoolerLifecycleState,
  SpoolerLifecycleTransitionEntry,
  SpoolerLifecycleRecord,
} from './models/spooler-lifecycle.model';
import {
  OwedChangeEntry,
  PendingRefundEntry,
  FinancialEventType,
  FinancialLedgerEntry,
} from './models/payment.model';
import {
  ReceiptMode,
  ReceiptRecordStatus,
  ReceiptChangeState,
  ReceiptChangeSnapshot,
  ReceiptDetailsSnapshot,
  ReceiptPrintConfigurationSnapshot,
  ReceiptRecordEntry,
  ReceiptAccessTokenEntry,
} from './models/receipt.model';
import {
  ConsumableUsageEventEntry,
  ConsumableInkSnapshotSupply,
  ConsumableInkSnapshotEntry,
  InkHistoryEntry,
  InkRefillBaseline,
} from './models/consumables.model';
import {
  RecoverySessionPhase,
  RecoveryReconciliationAction,
  RecoverySessionEntry,
  RecoveryLifecycleState,
  RecoveryState,
} from './models/recovery.model';
import {
  FeedbackCategory,
  FeedbackStatus,
  FeedbackEntry,
  FeedbackSessionEntry,
} from './models/feedback.model';
import {
  ReportIssueCategory,
  ReportIssueStatus,
  ReportIssueSessionEntry,
  ReportIssueAttachmentEntry,
  ReportIssueEntry,
} from './models/report-issue.model';

import {
  AdminLockout,
  PricingSettings,
  PricingEngineRoundingMode,
  PricingEnginePaperProfile,
  PricingEngineBulkDiscountTier,
  PricingEngineSettings,
  InkTelemetryUnknownPolicy,
  InkMonitoringSettings,
  ConsumablesForecastingSettings,
  ConsumableEstimationCoefficients,
  ConsumableEstimationSettings,
  AdminSettings,
  KioskPreferences,
  AlertDashboardSettings,
  AlertEmailSettings,
  AlertDedupeSettings,
  AlertSettings,
  AdminLogEntry,
} from './models/admin.model';

import {
  AlertChannel,
  AnomalySeverity,
  AnomalyStatus,
  AnomalyCategory,
  AnomalyIncidentEntry,
} from './models/anomaly-incident.model';

import { SupportedLanguage, PrintQuality } from './shared.schema';

export {
  AdminLockout,
  PricingSettings,
  PricingEngineRoundingMode,
  PricingEnginePaperProfile,
  PricingEngineBulkDiscountTier,
  PricingEngineSettings,
  InkTelemetryUnknownPolicy,
  InkMonitoringSettings,
  ConsumablesForecastingSettings,
  ConsumableEstimationCoefficients,
  ConsumableEstimationSettings,
  AdminSettings,
  KioskPreferences,
  AlertDashboardSettings,
  AlertEmailSettings,
  AlertDedupeSettings,
  AlertSettings,
  AdminLogEntry,
};

export {
  AlertChannel,
  AnomalySeverity,
  AnomalyStatus,
  AnomalyCategory,
  AnomalyIncidentEntry,
};

export { SupportedLanguage, PrintQuality };

export { PrintJobState, PrintJobEntry };
export {
  SpoolerLifecycleState,
  SpoolerLifecycleTransitionEntry,
  SpoolerLifecycleRecord,
};
export {
  OwedChangeEntry,
  PendingRefundEntry,
  FinancialEventType,
  FinancialLedgerEntry,
};
export {
  ReceiptMode,
  ReceiptRecordStatus,
  ReceiptChangeState,
  ReceiptChangeSnapshot,
  ReceiptDetailsSnapshot,
  ReceiptPrintConfigurationSnapshot,
  ReceiptRecordEntry,
  ReceiptAccessTokenEntry,
};
export {
  ConsumableUsageEventEntry,
  ConsumableInkSnapshotSupply,
  ConsumableInkSnapshotEntry,
  InkHistoryEntry,
  InkRefillBaseline,
};
export {
  RecoverySessionPhase,
  RecoveryReconciliationAction,
  RecoverySessionEntry,
  RecoveryLifecycleState,
  RecoveryState,
};
export {
  FeedbackCategory,
  FeedbackStatus,
  FeedbackEntry,
  FeedbackSessionEntry,
};
export {
  ReportIssueCategory,
  ReportIssueStatus,
  ReportIssueSessionEntry,
  ReportIssueAttachmentEntry,
  ReportIssueEntry,
};

export type PrintMode = 'print' | 'copy' | 'scan';
export type ColorMode = 'colored' | 'grayscale';
export interface CoinStats {
  one: number;
  five: number;
  ten: number;
  twenty: number;
}

export interface JobStats {
  total: number;
  print: number;
  copy: number;
  scan: number;
}

export interface HopperSettings {
  enabled: boolean;
  timeoutMs: number;
  retryCount: number;
  dispenseCommandPrefix: string;
  selfTestCommand: string;
}

export interface HopperStats {
  dispenseAttempts: number;
  dispenseSuccess: number;
  dispenseFailures: number;
  totalDispensed: number;
  lastDispensedAt: string | null;
  lastError: string | null;
  selfTestPassed: boolean | null;
  lastSelfTestAt: string | null;
}

export type LogMeta = Record<string, string | number | boolean | null>;

export type TrustedTimestampSource = 'ntp' | 'system';

export interface TrustedTimestampMeta {
  source: TrustedTimestampSource;
  synced: boolean;
  offsetMs: number | null;
  detail: string | null;
}

export type Schema = {
  adminLockout: AdminLockout;
  balance: number;
  earnings: number;
  settings: AdminSettings;
  coinStats: CoinStats;
  jobStats: JobStats;
  hopperSettings: HopperSettings;
  hopperStats: HopperStats;
  owedChanges: OwedChangeEntry[];
  logs: AdminLogEntry[];
  feedback: FeedbackEntry[];
  feedbackSessions: FeedbackSessionEntry[];
  reportIssues: ReportIssueEntry[];
  reportIssueSessions: ReportIssueSessionEntry[];
  reportIssueAttachments: ReportIssueAttachmentEntry[];
  pendingRefunds: PendingRefundEntry[];
  anomalyIncidents: AnomalyIncidentEntry[];
  financialLedger: FinancialLedgerEntry[];
  inkHistory: InkHistoryEntry[];
  spoolerLifecycle: SpoolerLifecycleRecord[];
  recovery: RecoveryState;
  receiptRecords: ReceiptRecordEntry[];
  receiptAccessTokens: ReceiptAccessTokenEntry[];
  inkRefillBaseline: InkRefillBaseline;
};

const DEFAULT_DATA: Schema = {
  adminLockout: {
    failedAttempts: 0,
    lockedUntil: null,
  },
  balance: 0,
  earnings: 0,
  settings: {
    pricing: {
      printPerPage: 5,
      copyPerPage: 3,
      scanDocument: 5,
      colorSurcharge: 2,
      highQualitySurcharge: 2,
    },
    pricingEngine: {
      paperProfiles: {
        a4: {
          baseBwPrice: 3,
          baseColorPrice: 18,
        },
        shortBond: {
          baseBwPrice: 3,
          baseColorPrice: 18,
        },
        longBond: {
          baseBwPrice: 4,
          baseColorPrice: 20,
        },
      },
      bulkDiscountTiers: [],
      rounding: 'whole_peso_total_only',
      highQualitySurcharge: 2,
    },
    idleTimeoutSeconds: 120,
    idleScreenTimeoutSeconds: 30,
    adminPin:
      '$argon2id$v=19$m=65536,t=3,p=4$gqSpsbLttLcalBC6SYKG0A$T34vxa4BxPcJ++fLZ+19qp9FGaQufJCCCqWu1fb35TQ',
    adminLocalOnly: true,
    kioskPreferences: {
      language: 'en',
      highContrast: false,
    },
    alerts: {
      severityThreshold: 'warning',
      dashboard: {
        enabled: true,
      },
      email: {
        enabled: false,
        smtpHost: '',
        smtpPort: 587,
        secure: false,
        username: '',
        from: '',
        to: '',
      },
      dedupe: {
        printerMs: 5 * 60 * 1_000,
        spoolerMs: 5 * 60 * 1_000,
        serialMs: 2 * 60 * 1_000,
        hopperMs: 2 * 60 * 1_000,
        networkMs: 5 * 60 * 1_000,
        securityMs: 2 * 60 * 1_000,
      },
    },
    inkMonitoring: {
      enabled: true,
      targetPrinterName: null,
      lowThresholdPercent: 20,
      criticalThresholdPercent: 5,
      blockOnLow: false,
      blockOnEmpty: true,
      telemetryUnknownPolicy: 'warn_allow',
    },
    consumablesForecasting: {
      enabled: false,
      rollingWindowDays: 14,
      alertDaysThreshold: 7,
      paperTrayCapacitySheets: 100,
      paperCurrentSheets: 100,
      paperRefillUpdatedAt: null,
    },
    consumableEstimation: {
      defaultCoefficients: {
        bwBlack: 0.015,
        colorCyan: 0.012,
        colorMagenta: 0.012,
        colorYellow: 0.012,
        colorBlack: 0.006,
      },
      printerOverrides: {},
    },
  },
  coinStats: {
    one: 0,
    five: 0,
    ten: 0,
    twenty: 0,
  },
  jobStats: {
    total: 0,
    print: 0,
    copy: 0,
    scan: 0,
  },
  hopperSettings: {
    enabled: true,
    timeoutMs: 8000,
    retryCount: 1,
    dispenseCommandPrefix: 'HOPPER DISPENSE',
    selfTestCommand: 'HOPPER SELFTEST',
  },
  hopperStats: {
    dispenseAttempts: 0,
    dispenseSuccess: 0,
    dispenseFailures: 0,
    totalDispensed: 0,
    lastDispensedAt: null,
    lastError: null,
    selfTestPassed: null,
    lastSelfTestAt: null,
  },
  owedChanges: [],
  logs: [],
  feedback: [],
  feedbackSessions: [],
  reportIssues: [],
  reportIssueSessions: [],
  reportIssueAttachments: [],
  pendingRefunds: [],
  anomalyIncidents: [],
  financialLedger: [],
  inkHistory: [],
  spoolerLifecycle: [],
  recovery: {
    lifecycle: {
      bootCount: 0,
      unexpectedRestartCount: 0,
      lastStartupAt: null,
      lastStartupPid: null,
      lastStartupReason: null,
      lastShutdownAt: null,
      lastShutdownPid: null,
      lastShutdownSignal: null,
      lastUnexpectedRestartAt: null,
    },
    sessions: [],
  },
  receiptRecords: [],
  receiptAccessTokens: [],
  inkRefillBaseline: {
    colorPages: 0,
    bwPages: 0,
    updatedAt: null,
  },
};

/**
 * Round a pricing value to a whole peso. The hopper only dispenses 1-peso
 * coins so all prices must be integers. Legacy fractional values from older
 * persisted state are silently rounded up on startup so the operator never
 * under-charges.
 */
function wholePeso(value: number): number {
  const nonNegative = Math.max(0, value);
  const rounded = Math.ceil(nonNegative);
  if (rounded !== value) {
    console.warn(
      `[DB] ⚠ Pricing value ${value} is not a whole peso — rounded to ${rounded}. Update admin settings to remove this warning.`,
    );
  }
  return rounded;
}

function normalizeTargetPrinterName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return sanitized ? sanitized : null;
}

function normalizeEstimatorCoefficient(
  value: unknown,
  fallback: number,
): number {
  return Math.max(0, finiteOr(value, fallback));
}

function normalizeConsumableEstimationOverrideKey(value: string): string {
  const compact = value.trim().toLowerCase();
  if (!compact) return '';
  return compact.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizePricingEngineBulkDiscountTiers(
  raw: unknown,
  fallback: PricingEngineBulkDiscountTier[],
): PricingEngineBulkDiscountTier[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fallback.map((entry) => ({ ...entry }));
  }
  const normalized: PricingEngineBulkDiscountTier[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Partial<PricingEngineBulkDiscountTier>;
    const minPages = Math.max(1, Math.floor(finiteOr(candidate.minPages, 0)));
    const discountPerPage = Math.max(0, finiteOr(candidate.discountPerPage, 0));
    const maxPages =
      typeof candidate.maxPages === 'number' &&
      Number.isFinite(candidate.maxPages)
        ? Math.max(minPages, Math.floor(candidate.maxPages))
        : undefined;
    normalized.push({
      minPages,
      ...(maxPages !== undefined ? { maxPages } : {}),
      discountPerPage,
    });
  }
  if (normalized.length === 0) {
    return fallback.map((entry) => ({ ...entry }));
  }
  normalized.sort((a, b) => a.minPages - b.minPages);
  return normalized;
}

function normalizeSchema(data: Partial<Schema> | undefined): Schema {
  const pricing = data?.settings?.pricing;
  const pricingEngine = data?.settings?.pricingEngine;
  const alertSettings = data?.settings?.alerts;
  const inkMonitoring = data?.settings?.inkMonitoring;
  const consumablesForecasting = data?.settings?.consumablesForecasting;
  const consumableEstimation = data?.settings?.consumableEstimation;
  const normalizedPaperTrayCapacitySheets = Math.max(
    1,
    Math.floor(
      finiteOr(
        consumablesForecasting?.paperTrayCapacitySheets,
        DEFAULT_DATA.settings.consumablesForecasting.paperTrayCapacitySheets,
      ),
    ),
  );
  const normalizedPaperCurrentSheets = Math.max(
    0,
    Math.floor(
      finiteOr(
        consumablesForecasting?.paperCurrentSheets,
        DEFAULT_DATA.settings.consumablesForecasting.paperCurrentSheets,
      ),
    ),
  );
  const kioskPreferences = data?.settings?.kioskPreferences;
  const hopperSettings = data?.hopperSettings;
  const hopperStats = data?.hopperStats;
  const normalizeAnomalyIncidents = (raw: unknown): AnomalyIncidentEntry[] => {
    if (!Array.isArray(raw)) return DEFAULT_DATA.anomalyIncidents;
    const incidents: AnomalyIncidentEntry[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        console.warn(
          '[DB] Skipping malformed anomaly incident row (not an object).',
        );
        continue;
      }
      const candidate = entry as Partial<AnomalyIncidentEntry>;
      if (
        typeof candidate.id !== 'string' ||
        typeof candidate.type !== 'string' ||
        typeof candidate.source !== 'string' ||
        typeof candidate.fingerprint !== 'string'
      ) {
        console.warn(
          '[DB] Skipping malformed anomaly incident row (missing required keys).',
        );
        continue;
      }
      incidents.push({
        id: candidate.id,
        type: candidate.type,
        source: candidate.source,
        category:
          candidate.category === 'printer' ||
          candidate.category === 'spooler' ||
          candidate.category === 'serial' ||
          candidate.category === 'hopper' ||
          candidate.category === 'network' ||
          candidate.category === 'security'
            ? candidate.category
            : 'printer',
        severity: candidate.severity === 'critical' ? 'critical' : 'warning',
        status:
          candidate.status === 'acknowledged' || candidate.status === 'resolved'
            ? candidate.status
            : 'open',
        fingerprint: candidate.fingerprint,
        message: typeof candidate.message === 'string' ? candidate.message : '',
        context:
          typeof candidate.context === 'object' && candidate.context !== null
            ? candidate.context
            : undefined,
        occurrenceCount: finiteOr(candidate.occurrenceCount, 1),
        firstDetectedAt:
          typeof candidate.firstDetectedAt === 'string'
            ? candidate.firstDetectedAt
            : new Date(0).toISOString(),
        lastDetectedAt:
          typeof candidate.lastDetectedAt === 'string'
            ? candidate.lastDetectedAt
            : new Date(0).toISOString(),
        createdAt:
          typeof candidate.createdAt === 'string'
            ? candidate.createdAt
            : new Date(0).toISOString(),
        updatedAt:
          typeof candidate.updatedAt === 'string'
            ? candidate.updatedAt
            : new Date(0).toISOString(),
        acknowledgedAt:
          typeof candidate.acknowledgedAt === 'string'
            ? candidate.acknowledgedAt
            : null,
        resolvedAt:
          typeof candidate.resolvedAt === 'string'
            ? candidate.resolvedAt
            : null,
        lastNotificationAt:
          typeof candidate.lastNotificationAt === 'string'
            ? candidate.lastNotificationAt
            : null,
        lastNotifiedChannels: Array.isArray(candidate.lastNotifiedChannels)
          ? candidate.lastNotifiedChannels.filter(
              (channel): channel is AlertChannel =>
                channel === 'dashboard' || channel === 'email',
            )
          : [],
      });
    }
    return incidents;
  };
  const normalizeSpoolerLifecycleRecords = (
    raw: unknown,
  ): SpoolerLifecycleRecord[] => {
    if (!Array.isArray(raw)) return [];
    const records: SpoolerLifecycleRecord[] = [];
    const normalizeMeta = (input: unknown): LogMeta => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {};
      }
      const output: LogMeta = {};
      for (const [key, value] of Object.entries(input)) {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null
        ) {
          output[key] = value;
        }
      }
      return output;
    };

    for (const row of raw) {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('transactionId' in row) ||
        typeof (row as { transactionId: unknown }).transactionId !== 'string'
      ) {
        continue;
      }
      const transactionId = (row as { transactionId: string }).transactionId;
      const candidate = row as Partial<SpoolerLifecycleRecord>;
      const currentStateCandidate = candidate.currentState;
      const currentState: SpoolerLifecycleState | null =
        currentStateCandidate === 'queued' ||
        currentStateCandidate === 'processing' ||
        currentStateCandidate === 'paused' ||
        currentStateCandidate === 'printed' ||
        currentStateCandidate === 'failed'
          ? currentStateCandidate
          : null;
      const transitions = Array.isArray(candidate.transitions)
        ? candidate.transitions
            .filter(
              (entry): entry is SpoolerLifecycleTransitionEntry =>
                typeof entry === 'object' &&
                entry !== null &&
                ((entry as SpoolerLifecycleTransitionEntry).state ===
                  'queued' ||
                  (entry as SpoolerLifecycleTransitionEntry).state ===
                    'processing' ||
                  (entry as SpoolerLifecycleTransitionEntry).state ===
                    'paused' ||
                  (entry as SpoolerLifecycleTransitionEntry).state ===
                    'printed' ||
                  (entry as SpoolerLifecycleTransitionEntry).state ===
                    'failed') &&
                typeof (entry as SpoolerLifecycleTransitionEntry).timestamp ===
                  'string',
            )
            .map((entry) => ({
              state: entry.state,
              timestamp: entry.timestamp,
              reason: typeof entry.reason === 'string' ? entry.reason : null,
              printerName:
                typeof entry.printerName === 'string'
                  ? entry.printerName
                  : null,
              spoolerCorrelationKey:
                typeof entry.spoolerCorrelationKey === 'string'
                  ? entry.spoolerCorrelationKey
                  : null,
              spoolerJobId:
                typeof entry.spoolerJobId === 'number' &&
                Number.isFinite(entry.spoolerJobId)
                  ? Math.floor(entry.spoolerJobId)
                  : null,
              jobStatus:
                typeof entry.jobStatus === 'string' ? entry.jobStatus : null,
              pagesPrinted:
                typeof entry.pagesPrinted === 'number' &&
                Number.isFinite(entry.pagesPrinted)
                  ? entry.pagesPrinted
                  : null,
              totalPages:
                typeof entry.totalPages === 'number' &&
                Number.isFinite(entry.totalPages)
                  ? entry.totalPages
                  : null,
              meta: normalizeMeta(entry.meta),
            }))
        : [];

      records.push({
        transactionId,
        mode: candidate.mode === 'copy' ? 'copy' : 'print',
        createdAt:
          typeof candidate.createdAt === 'string'
            ? candidate.createdAt
            : new Date(0).toISOString(),
        updatedAt:
          typeof candidate.updatedAt === 'string'
            ? candidate.updatedAt
            : new Date(0).toISOString(),
        currentState,
        queuedAt:
          typeof candidate.queuedAt === 'string' ? candidate.queuedAt : null,
        processingAt:
          typeof candidate.processingAt === 'string'
            ? candidate.processingAt
            : null,
        pausedAt:
          typeof candidate.pausedAt === 'string' ? candidate.pausedAt : null,
        printedAt:
          typeof candidate.printedAt === 'string' ? candidate.printedAt : null,
        failedAt:
          typeof candidate.failedAt === 'string' ? candidate.failedAt : null,
        sessionId:
          typeof candidate.sessionId === 'string' ? candidate.sessionId : null,
        documentId:
          typeof candidate.documentId === 'string'
            ? candidate.documentId
            : null,
        requiredAmount: Math.max(0, finiteOr(candidate.requiredAmount, 0)),
        spoolerCorrelationKey:
          typeof candidate.spoolerCorrelationKey === 'string'
            ? candidate.spoolerCorrelationKey
            : null,
        spoolerJobId:
          typeof candidate.spoolerJobId === 'number' &&
          Number.isFinite(candidate.spoolerJobId)
            ? Math.floor(candidate.spoolerJobId)
            : null,
        printerName:
          typeof candidate.printerName === 'string'
            ? candidate.printerName
            : null,
        reason: typeof candidate.reason === 'string' ? candidate.reason : null,
        jobStatus:
          typeof candidate.jobStatus === 'string' ? candidate.jobStatus : null,
        pagesPrinted:
          typeof candidate.pagesPrinted === 'number' &&
          Number.isFinite(candidate.pagesPrinted)
            ? candidate.pagesPrinted
            : null,
        totalPages:
          typeof candidate.totalPages === 'number' &&
          Number.isFinite(candidate.totalPages)
            ? candidate.totalPages
            : null,
        transitions,
      });
    }

    return records;
  };
  const normalizeRecoveryState = (raw: unknown): RecoveryState => {
    const fallback = DEFAULT_DATA.recovery;
    if (typeof raw !== 'object' || raw === null) {
      return structuredClone(fallback);
    }

    const candidate = raw as Partial<RecoveryState>;
    const lifecycleCandidate =
      typeof candidate.lifecycle === 'object' && candidate.lifecycle !== null
        ? (candidate.lifecycle as Partial<RecoveryLifecycleState>)
        : {};

    const normalizedLifecycle: RecoveryLifecycleState = {
      bootCount: Math.max(0, finiteOr(lifecycleCandidate.bootCount, 0)),
      unexpectedRestartCount: Math.max(
        0,
        finiteOr(lifecycleCandidate.unexpectedRestartCount, 0),
      ),
      lastStartupAt:
        typeof lifecycleCandidate.lastStartupAt === 'string'
          ? lifecycleCandidate.lastStartupAt
          : null,
      lastStartupPid:
        typeof lifecycleCandidate.lastStartupPid === 'number' &&
        Number.isFinite(lifecycleCandidate.lastStartupPid)
          ? Math.floor(lifecycleCandidate.lastStartupPid)
          : null,
      lastStartupReason:
        typeof lifecycleCandidate.lastStartupReason === 'string'
          ? lifecycleCandidate.lastStartupReason
          : null,
      lastShutdownAt:
        typeof lifecycleCandidate.lastShutdownAt === 'string'
          ? lifecycleCandidate.lastShutdownAt
          : null,
      lastShutdownPid:
        typeof lifecycleCandidate.lastShutdownPid === 'number' &&
        Number.isFinite(lifecycleCandidate.lastShutdownPid)
          ? Math.floor(lifecycleCandidate.lastShutdownPid)
          : null,
      lastShutdownSignal:
        typeof lifecycleCandidate.lastShutdownSignal === 'string'
          ? lifecycleCandidate.lastShutdownSignal
          : null,
      lastUnexpectedRestartAt:
        typeof lifecycleCandidate.lastUnexpectedRestartAt === 'string'
          ? lifecycleCandidate.lastUnexpectedRestartAt
          : null,
    };

    const normalizedSessions: RecoverySessionEntry[] = Array.isArray(
      candidate.sessions,
    )
      ? candidate.sessions
          .filter(
            (entry): entry is RecoverySessionEntry =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as RecoverySessionEntry).id === 'string' &&
              ((entry as RecoverySessionEntry).mode === 'print' ||
                (entry as RecoverySessionEntry).mode === 'copy'),
          )
          .map((entry) => {
            const phaseCandidate = entry.phase;
            const phase: RecoverySessionPhase =
              phaseCandidate === 'initiated' ||
              phaseCandidate === 'preflight_passed' ||
              phaseCandidate === 'job_dispatched' ||
              phaseCandidate === 'settled' ||
              phaseCandidate === 'spooler_confirmed' ||
              phaseCandidate === 'spooler_failed' ||
              phaseCandidate === 'spooler_timeout' ||
              phaseCandidate === 'reconciled'
                ? phaseCandidate
                : 'initiated';

            const actionCandidate = entry.reconciliationAction;
            const reconciliationAction: RecoveryReconciliationAction =
              actionCandidate === 'none' ||
              actionCandidate === 'void' ||
              actionCandidate === 'auto_refund' ||
              actionCandidate === 'pending_admin_review'
                ? actionCandidate
                : 'none';

            const safeContext: LogMeta = {};
            for (const [key, value] of Object.entries(entry.context ?? {})) {
              if (
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean' ||
                value === null
              ) {
                safeContext[key] = value;
              }
            }

            return {
              id: entry.id,
              mode: entry.mode,
              createdAt:
                typeof entry.createdAt === 'string'
                  ? entry.createdAt
                  : new Date(0).toISOString(),
              updatedAt:
                typeof entry.updatedAt === 'string'
                  ? entry.updatedAt
                  : new Date(0).toISOString(),
              phase,
              requiredAmount: Math.max(0, finiteOr(entry.requiredAmount, 0)),
              chargedAmount: Math.max(0, finiteOr(entry.chargedAmount, 0)),
              sessionId:
                typeof entry.sessionId === 'string' ? entry.sessionId : null,
              documentId:
                typeof entry.documentId === 'string' ? entry.documentId : null,
              spoolerCorrelationKey:
                typeof entry.spoolerCorrelationKey === 'string'
                  ? entry.spoolerCorrelationKey
                  : null,
              spoolerJobId:
                typeof entry.spoolerJobId === 'number' &&
                Number.isFinite(entry.spoolerJobId)
                  ? Math.floor(entry.spoolerJobId)
                  : null,
              jobDispatchedAt:
                typeof entry.jobDispatchedAt === 'string'
                  ? entry.jobDispatchedAt
                  : null,
              settledAt:
                typeof entry.settledAt === 'string' ? entry.settledAt : null,
              spoolerTerminalAt:
                typeof entry.spoolerTerminalAt === 'string'
                  ? entry.spoolerTerminalAt
                  : null,
              reconciledAt:
                typeof entry.reconciledAt === 'string'
                  ? entry.reconciledAt
                  : null,
              startupReconciled: entry.startupReconciled === true,
              reconciliationAction,
              reconciliationReason:
                typeof entry.reconciliationReason === 'string'
                  ? entry.reconciliationReason
                  : null,
              lastError:
                typeof entry.lastError === 'string' ? entry.lastError : null,
              wasPresentAtStartup:
                typeof entry.wasPresentAtStartup === 'boolean'
                  ? entry.wasPresentAtStartup
                  : undefined,
              context: safeContext,
            };
          })
      : [];

    return {
      lifecycle: normalizedLifecycle,
      sessions: normalizedSessions,
    };
  };
  const normalizeReceiptRecords = (raw: unknown): ReceiptRecordEntry[] => {
    if (!Array.isArray(raw)) return [];
    const records: ReceiptRecordEntry[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const candidate = entry as Partial<ReceiptRecordEntry>;
      if (
        typeof candidate.id !== 'string' ||
        typeof candidate.transactionId !== 'string'
      ) {
        continue;
      }

      const statusCandidate = candidate.status;
      const status: ReceiptRecordStatus =
        statusCandidate === 'settled_pending_terminal' ||
        statusCandidate === 'printed' ||
        statusCandidate === 'failed' ||
        statusCandidate === 'refunded' ||
        statusCandidate === 'refunded_pending_review'
          ? statusCandidate
          : 'settled_pending_terminal';
      const changeCandidate =
        typeof candidate.change === 'object' && candidate.change !== null
          ? (candidate.change as Partial<ReceiptChangeSnapshot>)
          : null;
      const changeStateCandidate = changeCandidate?.state;
      const changeState: ReceiptChangeState =
        changeStateCandidate === 'dispensed' ||
        changeStateCandidate === 'failed' ||
        changeStateCandidate === 'none'
          ? changeStateCandidate
          : 'none';
      const changeRequested = Math.max(
        0,
        Math.floor(finiteOr(changeCandidate?.requested, 0)),
      );
      const rawChangeDispensed = Math.max(
        0,
        Math.floor(finiteOr(changeCandidate?.dispensed, 0)),
      );
      const changeDispensed = Math.min(rawChangeDispensed, changeRequested);
      const changeAttempts = Math.max(
        0,
        Math.floor(finiteOr(changeCandidate?.attempts, 0)),
      );
      const changeOwedId =
        typeof changeCandidate?.owedChangeId === 'string' &&
        changeCandidate.owedChangeId.trim().length > 0
          ? changeCandidate.owedChangeId.trim()
          : null;
      const changeMessage =
        typeof changeCandidate?.message === 'string' &&
        changeCandidate.message.trim().length > 0
          ? changeCandidate.message.trim()
          : null;

      records.push({
        id: candidate.id,
        transactionId: candidate.transactionId,
        mode: candidate.mode === 'copy' ? 'copy' : 'print',
        chargedAmount: Math.max(0, finiteOr(candidate.chargedAmount, 0)),
        status,
        change: {
          requested: changeRequested,
          dispensed: changeDispensed,
          state: changeState,
          attempts: changeAttempts,
          owedChangeId: changeState === 'failed' ? changeOwedId : null,
          message: changeState === 'failed' ? changeMessage : null,
        },
        settledAt:
          typeof candidate.settledAt === 'string' ? candidate.settledAt : null,
        terminalAt:
          typeof candidate.terminalAt === 'string'
            ? candidate.terminalAt
            : null,
        createdAt:
          typeof candidate.createdAt === 'string'
            ? candidate.createdAt
            : new Date(0).toISOString(),
        updatedAt:
          typeof candidate.updatedAt === 'string'
            ? candidate.updatedAt
            : new Date(0).toISOString(),
        expiresAt:
          typeof candidate.expiresAt === 'string'
            ? candidate.expiresAt
            : new Date(0).toISOString(),
      });
    }
    return records;
  };
  const normalizeReceiptAccessTokens = (
    raw: unknown,
  ): ReceiptAccessTokenEntry[] => {
    if (!Array.isArray(raw)) return [];
    const tokens: ReceiptAccessTokenEntry[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const candidate = entry as Partial<ReceiptAccessTokenEntry>;
      if (
        typeof candidate.id !== 'string' ||
        typeof candidate.receiptId !== 'string' ||
        typeof candidate.tokenHash !== 'string'
      ) {
        continue;
      }
      tokens.push({
        id: candidate.id,
        receiptId: candidate.receiptId,
        tokenHash: candidate.tokenHash,
        createdAt:
          typeof candidate.createdAt === 'string'
            ? candidate.createdAt
            : new Date(0).toISOString(),
        expiresAt:
          typeof candidate.expiresAt === 'string'
            ? candidate.expiresAt
            : new Date(0).toISOString(),
        revokedAt:
          typeof candidate.revokedAt === 'string' ? candidate.revokedAt : null,
      });
    }
    return tokens;
  };

  return {
    adminLockout: {
      failedAttempts: finiteOr(data?.adminLockout?.failedAttempts, 0),
      lockedUntil:
        typeof data?.adminLockout?.lockedUntil === 'string'
          ? data.adminLockout.lockedUntil
          : DEFAULT_DATA.adminLockout.lockedUntil,
    },
    balance: finiteOr(data?.balance, DEFAULT_DATA.balance),
    earnings: finiteOr(data?.earnings, DEFAULT_DATA.earnings),
    settings: {
      pricing: {
        printPerPage: wholePeso(
          finiteOr(
            pricing?.printPerPage,
            DEFAULT_DATA.settings.pricing.printPerPage,
          ),
        ),
        copyPerPage: wholePeso(
          finiteOr(
            pricing?.copyPerPage,
            DEFAULT_DATA.settings.pricing.copyPerPage,
          ),
        ),
        scanDocument: wholePeso(
          finiteOr(
            pricing?.scanDocument,
            DEFAULT_DATA.settings.pricing.scanDocument,
          ),
        ),
        colorSurcharge: wholePeso(
          finiteOr(
            pricing?.colorSurcharge,
            DEFAULT_DATA.settings.pricing.colorSurcharge,
          ),
        ),
        highQualitySurcharge: wholePeso(
          finiteOr(
            pricing?.highQualitySurcharge,
            DEFAULT_DATA.settings.pricing.highQualitySurcharge,
          ),
        ),
      },
      pricingEngine: (() => {
        const defaultPricingEngine = DEFAULT_DATA.settings.pricingEngine;
        const a4 = pricingEngine?.paperProfiles?.a4;
        const shortBond = pricingEngine?.paperProfiles?.shortBond;
        const longBond = pricingEngine?.paperProfiles?.longBond;

        return {
          paperProfiles: {
            a4: {
              baseBwPrice: Math.max(
                0,
                finiteOr(
                  a4?.baseBwPrice,
                  defaultPricingEngine.paperProfiles.a4.baseBwPrice,
                ),
              ),
              baseColorPrice: Math.max(
                0,
                finiteOr(
                  a4?.baseColorPrice,
                  defaultPricingEngine.paperProfiles.a4.baseColorPrice,
                ),
              ),
            },
            shortBond: {
              baseBwPrice: Math.max(
                0,
                finiteOr(
                  shortBond?.baseBwPrice,
                  defaultPricingEngine.paperProfiles.shortBond.baseBwPrice,
                ),
              ),
              baseColorPrice: Math.max(
                0,
                finiteOr(
                  shortBond?.baseColorPrice,
                  defaultPricingEngine.paperProfiles.shortBond.baseColorPrice,
                ),
              ),
            },
            longBond: {
              baseBwPrice: Math.max(
                0,
                finiteOr(
                  longBond?.baseBwPrice,
                  defaultPricingEngine.paperProfiles.longBond.baseBwPrice,
                ),
              ),
              baseColorPrice: Math.max(
                0,
                finiteOr(
                  longBond?.baseColorPrice,
                  defaultPricingEngine.paperProfiles.longBond.baseColorPrice,
                ),
              ),
            },
          },
          bulkDiscountTiers: normalizePricingEngineBulkDiscountTiers(
            pricingEngine?.bulkDiscountTiers,
            defaultPricingEngine.bulkDiscountTiers,
          ),
          rounding: 'whole_peso_total_only',
          highQualitySurcharge: wholePeso(
            finiteOr(
              pricingEngine?.highQualitySurcharge,
              defaultPricingEngine.highQualitySurcharge,
            ),
          ),
        };
      })(),
      idleTimeoutSeconds: finiteOr(
        data?.settings?.idleTimeoutSeconds,
        DEFAULT_DATA.settings.idleTimeoutSeconds,
      ),
      idleScreenTimeoutSeconds: finiteOr(
        (data?.settings as { idleScreenTimeoutSeconds?: number })
          ?.idleScreenTimeoutSeconds,
        DEFAULT_DATA.settings.idleScreenTimeoutSeconds,
      ),
      adminPin:
        typeof data?.settings?.adminPin === 'string' &&
        data.settings.adminPin.trim()
          ? data.settings.adminPin
          : DEFAULT_DATA.settings.adminPin,
      adminLocalOnly:
        typeof data?.settings?.adminLocalOnly === 'boolean'
          ? data.settings.adminLocalOnly
          : DEFAULT_DATA.settings.adminLocalOnly,
      kioskPreferences: {
        language: kioskPreferences?.language === 'fil' ? 'fil' : 'en',
        highContrast:
          typeof kioskPreferences?.highContrast === 'boolean'
            ? kioskPreferences.highContrast
            : DEFAULT_DATA.settings.kioskPreferences.highContrast,
      },
      alerts: {
        severityThreshold:
          alertSettings?.severityThreshold === 'critical'
            ? 'critical'
            : DEFAULT_DATA.settings.alerts.severityThreshold,
        dashboard: {
          enabled:
            typeof alertSettings?.dashboard?.enabled === 'boolean'
              ? alertSettings.dashboard.enabled
              : DEFAULT_DATA.settings.alerts.dashboard.enabled,
        },
        email: {
          enabled:
            typeof alertSettings?.email?.enabled === 'boolean'
              ? alertSettings.email.enabled
              : DEFAULT_DATA.settings.alerts.email.enabled,
          smtpHost:
            typeof alertSettings?.email?.smtpHost === 'string'
              ? alertSettings.email.smtpHost
              : DEFAULT_DATA.settings.alerts.email.smtpHost,
          smtpPort: finiteOr(
            alertSettings?.email?.smtpPort,
            DEFAULT_DATA.settings.alerts.email.smtpPort,
          ),
          secure:
            typeof alertSettings?.email?.secure === 'boolean'
              ? alertSettings.email.secure
              : DEFAULT_DATA.settings.alerts.email.secure,
          username:
            typeof alertSettings?.email?.username === 'string'
              ? alertSettings.email.username
              : DEFAULT_DATA.settings.alerts.email.username,
          from:
            typeof alertSettings?.email?.from === 'string'
              ? alertSettings.email.from
              : DEFAULT_DATA.settings.alerts.email.from,
          to:
            typeof alertSettings?.email?.to === 'string'
              ? alertSettings.email.to
              : DEFAULT_DATA.settings.alerts.email.to,
        },
        dedupe: {
          printerMs: finiteOr(
            alertSettings?.dedupe?.printerMs,
            DEFAULT_DATA.settings.alerts.dedupe.printerMs,
          ),
          spoolerMs: finiteOr(
            alertSettings?.dedupe?.spoolerMs,
            DEFAULT_DATA.settings.alerts.dedupe.spoolerMs,
          ),
          serialMs: finiteOr(
            alertSettings?.dedupe?.serialMs,
            DEFAULT_DATA.settings.alerts.dedupe.serialMs,
          ),
          hopperMs: finiteOr(
            alertSettings?.dedupe?.hopperMs,
            DEFAULT_DATA.settings.alerts.dedupe.hopperMs,
          ),
          networkMs: finiteOr(
            alertSettings?.dedupe?.networkMs,
            DEFAULT_DATA.settings.alerts.dedupe.networkMs,
          ),
          securityMs: finiteOr(
            alertSettings?.dedupe?.securityMs,
            DEFAULT_DATA.settings.alerts.dedupe.securityMs,
          ),
        },
      },
      inkMonitoring: {
        enabled:
          typeof inkMonitoring?.enabled === 'boolean'
            ? inkMonitoring.enabled
            : DEFAULT_DATA.settings.inkMonitoring.enabled,
        targetPrinterName: normalizeTargetPrinterName(
          inkMonitoring?.targetPrinterName,
        ),
        lowThresholdPercent: Math.max(
          0,
          Math.min(
            100,
            finiteOr(
              inkMonitoring?.lowThresholdPercent,
              DEFAULT_DATA.settings.inkMonitoring.lowThresholdPercent,
            ),
          ),
        ),
        criticalThresholdPercent: Math.max(
          0,
          Math.min(
            100,
            finiteOr(
              inkMonitoring?.criticalThresholdPercent,
              DEFAULT_DATA.settings.inkMonitoring.criticalThresholdPercent,
            ),
          ),
        ),
        blockOnLow:
          typeof inkMonitoring?.blockOnLow === 'boolean'
            ? inkMonitoring.blockOnLow
            : DEFAULT_DATA.settings.inkMonitoring.blockOnLow,
        blockOnEmpty:
          typeof inkMonitoring?.blockOnEmpty === 'boolean'
            ? inkMonitoring.blockOnEmpty
            : DEFAULT_DATA.settings.inkMonitoring.blockOnEmpty,
        telemetryUnknownPolicy:
          inkMonitoring?.telemetryUnknownPolicy === 'block'
            ? 'block'
            : 'warn_allow',
      },
      consumablesForecasting: {
        enabled:
          typeof consumablesForecasting?.enabled === 'boolean'
            ? consumablesForecasting.enabled
            : DEFAULT_DATA.settings.consumablesForecasting.enabled,
        rollingWindowDays: Math.max(
          1,
          Math.min(
            90,
            Math.floor(
              finiteOr(
                consumablesForecasting?.rollingWindowDays,
                DEFAULT_DATA.settings.consumablesForecasting.rollingWindowDays,
              ),
            ),
          ),
        ),
        alertDaysThreshold: Math.max(
          1,
          Math.min(
            60,
            Math.floor(
              finiteOr(
                consumablesForecasting?.alertDaysThreshold,
                DEFAULT_DATA.settings.consumablesForecasting.alertDaysThreshold,
              ),
            ),
          ),
        ),
        paperTrayCapacitySheets: normalizedPaperTrayCapacitySheets,
        paperCurrentSheets: Math.min(
          normalizedPaperTrayCapacitySheets,
          normalizedPaperCurrentSheets,
        ),
        paperRefillUpdatedAt:
          typeof consumablesForecasting?.paperRefillUpdatedAt === 'string'
            ? consumablesForecasting.paperRefillUpdatedAt
            : DEFAULT_DATA.settings.consumablesForecasting.paperRefillUpdatedAt,
      },
      consumableEstimation: {
        defaultCoefficients: {
          bwBlack: normalizeEstimatorCoefficient(
            consumableEstimation?.defaultCoefficients?.bwBlack,
            DEFAULT_DATA.settings.consumableEstimation.defaultCoefficients
              .bwBlack,
          ),
          colorCyan: normalizeEstimatorCoefficient(
            consumableEstimation?.defaultCoefficients?.colorCyan,
            DEFAULT_DATA.settings.consumableEstimation.defaultCoefficients
              .colorCyan,
          ),
          colorMagenta: normalizeEstimatorCoefficient(
            consumableEstimation?.defaultCoefficients?.colorMagenta,
            DEFAULT_DATA.settings.consumableEstimation.defaultCoefficients
              .colorMagenta,
          ),
          colorYellow: normalizeEstimatorCoefficient(
            consumableEstimation?.defaultCoefficients?.colorYellow,
            DEFAULT_DATA.settings.consumableEstimation.defaultCoefficients
              .colorYellow,
          ),
          colorBlack: normalizeEstimatorCoefficient(
            consumableEstimation?.defaultCoefficients?.colorBlack,
            DEFAULT_DATA.settings.consumableEstimation.defaultCoefficients
              .colorBlack,
          ),
        },
        printerOverrides: Object.fromEntries(
          Object.entries(consumableEstimation?.printerOverrides ?? {})
            .map(([key, value]) => {
              const normalizedKey =
                normalizeConsumableEstimationOverrideKey(key);
              if (
                !normalizedKey ||
                typeof value !== 'object' ||
                value === null
              ) {
                return null;
              }
              const candidate =
                value as Partial<ConsumableEstimationCoefficients>;
              return [
                normalizedKey,
                {
                  bwBlack:
                    candidate.bwBlack === undefined
                      ? undefined
                      : normalizeEstimatorCoefficient(candidate.bwBlack, 0),
                  colorCyan:
                    candidate.colorCyan === undefined
                      ? undefined
                      : normalizeEstimatorCoefficient(candidate.colorCyan, 0),
                  colorMagenta:
                    candidate.colorMagenta === undefined
                      ? undefined
                      : normalizeEstimatorCoefficient(
                          candidate.colorMagenta,
                          0,
                        ),
                  colorYellow:
                    candidate.colorYellow === undefined
                      ? undefined
                      : normalizeEstimatorCoefficient(candidate.colorYellow, 0),
                  colorBlack:
                    candidate.colorBlack === undefined
                      ? undefined
                      : normalizeEstimatorCoefficient(candidate.colorBlack, 0),
                } as Partial<ConsumableEstimationCoefficients>,
              ] as const;
            })
            .filter(
              (
                entry,
              ): entry is readonly [
                string,
                Partial<ConsumableEstimationCoefficients>,
              ] => entry !== null,
            ),
        ),
      },
    },
    coinStats: {
      one: finiteOr(data?.coinStats?.one, DEFAULT_DATA.coinStats.one),
      five: finiteOr(data?.coinStats?.five, DEFAULT_DATA.coinStats.five),
      ten: finiteOr(data?.coinStats?.ten, DEFAULT_DATA.coinStats.ten),
      twenty: finiteOr(data?.coinStats?.twenty, DEFAULT_DATA.coinStats.twenty),
    },
    jobStats: {
      total: finiteOr(data?.jobStats?.total, DEFAULT_DATA.jobStats.total),
      print: finiteOr(data?.jobStats?.print, DEFAULT_DATA.jobStats.print),
      copy: finiteOr(data?.jobStats?.copy, DEFAULT_DATA.jobStats.copy),
      scan: finiteOr(data?.jobStats?.scan, DEFAULT_DATA.jobStats.scan),
    },
    hopperSettings: {
      enabled:
        typeof hopperSettings?.enabled === 'boolean'
          ? hopperSettings.enabled
          : DEFAULT_DATA.hopperSettings.enabled,
      timeoutMs: finiteOr(
        hopperSettings?.timeoutMs,
        DEFAULT_DATA.hopperSettings.timeoutMs,
      ),
      retryCount: finiteOr(
        hopperSettings?.retryCount,
        DEFAULT_DATA.hopperSettings.retryCount,
      ),
      dispenseCommandPrefix:
        typeof hopperSettings?.dispenseCommandPrefix === 'string' &&
        hopperSettings.dispenseCommandPrefix.trim()
          ? hopperSettings.dispenseCommandPrefix
          : DEFAULT_DATA.hopperSettings.dispenseCommandPrefix,
      selfTestCommand:
        typeof hopperSettings?.selfTestCommand === 'string' &&
        hopperSettings.selfTestCommand.trim()
          ? hopperSettings.selfTestCommand
          : DEFAULT_DATA.hopperSettings.selfTestCommand,
    },
    hopperStats: {
      dispenseAttempts: finiteOr(
        hopperStats?.dispenseAttempts,
        DEFAULT_DATA.hopperStats.dispenseAttempts,
      ),
      dispenseSuccess: finiteOr(
        hopperStats?.dispenseSuccess,
        DEFAULT_DATA.hopperStats.dispenseSuccess,
      ),
      dispenseFailures: finiteOr(
        hopperStats?.dispenseFailures,
        DEFAULT_DATA.hopperStats.dispenseFailures,
      ),
      totalDispensed: finiteOr(
        hopperStats?.totalDispensed,
        DEFAULT_DATA.hopperStats.totalDispensed,
      ),
      lastDispensedAt:
        typeof hopperStats?.lastDispensedAt === 'string'
          ? hopperStats.lastDispensedAt
          : DEFAULT_DATA.hopperStats.lastDispensedAt,
      lastError:
        typeof hopperStats?.lastError === 'string'
          ? hopperStats.lastError
          : DEFAULT_DATA.hopperStats.lastError,
      selfTestPassed:
        typeof hopperStats?.selfTestPassed === 'boolean'
          ? hopperStats.selfTestPassed
          : DEFAULT_DATA.hopperStats.selfTestPassed,
      lastSelfTestAt:
        typeof hopperStats?.lastSelfTestAt === 'string'
          ? hopperStats.lastSelfTestAt
          : DEFAULT_DATA.hopperStats.lastSelfTestAt,
    },
    owedChanges: Array.isArray(data?.owedChanges)
      ? data.owedChanges
      : DEFAULT_DATA.owedChanges,
    logs: Array.isArray(data?.logs) ? data.logs : DEFAULT_DATA.logs,
    feedback: Array.isArray(data?.feedback)
      ? data.feedback
      : DEFAULT_DATA.feedback,
    feedbackSessions: Array.isArray(data?.feedbackSessions)
      ? data.feedbackSessions
      : DEFAULT_DATA.feedbackSessions,
    reportIssues: Array.isArray(data?.reportIssues)
      ? data.reportIssues
      : DEFAULT_DATA.reportIssues,
    reportIssueSessions: Array.isArray(data?.reportIssueSessions)
      ? data.reportIssueSessions
      : DEFAULT_DATA.reportIssueSessions,
    reportIssueAttachments: Array.isArray(data?.reportIssueAttachments)
      ? data.reportIssueAttachments
      : DEFAULT_DATA.reportIssueAttachments,
    pendingRefunds: Array.isArray(data?.pendingRefunds)
      ? data.pendingRefunds
      : DEFAULT_DATA.pendingRefunds,
    anomalyIncidents: normalizeAnomalyIncidents(data?.anomalyIncidents),
    financialLedger: Array.isArray(data?.financialLedger)
      ? data.financialLedger
      : DEFAULT_DATA.financialLedger,
    inkHistory: Array.isArray(data?.inkHistory)
      ? data.inkHistory.filter(
          (entry): entry is InkHistoryEntry =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as InkHistoryEntry).id === 'string' &&
            typeof (entry as InkHistoryEntry).timestamp === 'string',
        )
      : DEFAULT_DATA.inkHistory,
    spoolerLifecycle: normalizeSpoolerLifecycleRecords(data?.spoolerLifecycle),
    recovery: normalizeRecoveryState(data?.recovery),
    receiptRecords: normalizeReceiptRecords(data?.receiptRecords),
    receiptAccessTokens: normalizeReceiptAccessTokens(
      data?.receiptAccessTokens,
    ),
    inkRefillBaseline: {
      colorPages: finiteOr(data?.inkRefillBaseline?.colorPages, 0),
      bwPages: finiteOr(data?.inkRefillBaseline?.bwPages, 0),
      updatedAt:
        typeof data?.inkRefillBaseline?.updatedAt === 'string'
          ? data.inkRefillBaseline.updatedAt
          : null,
    },
  };
}

function cloneDefaultData(): Schema {
  return structuredClone(DEFAULT_DATA);
}

async function readLegacyDbJson(): Promise<Partial<Schema> | undefined> {
  const legacyPath = 'db.json';
  if (!fs.existsSync(legacyPath)) return undefined;
  const raw = await fs.promises.readFile(legacyPath, 'utf-8');
  if (!raw.trim()) return undefined;
  return JSON.parse(raw) as Partial<Schema>;
}

function buildLowDbImportSnapshot(data: Schema) {
  return {
    logs: data.logs.slice(),
    feedback: data.feedback.slice(),
    feedbackSessions: data.feedbackSessions.slice(),
    reportIssues: data.reportIssues.slice(),
    reportIssueSessions: data.reportIssueSessions.slice(),
    reportIssueAttachments: data.reportIssueAttachments.slice(),
    receiptRecords: data.receiptRecords.slice(),
    receiptAccessTokens: data.receiptAccessTokens.slice(),
  };
}

export async function migrateLegacyDbJsonToSqlite(options?: {
  force?: boolean;
}): Promise<{
  imported: boolean;
  source: 'db.json' | 'runtime_state' | 'none';
  result: ReturnType<typeof importLowDbSnapshotIfNeeded>;
}> {
  initSqliteStorage();
  migrateSchemaSnapshotToRuntimeState();

  if (options?.force) {
    clearLowDbImportMarker();
  }

  const legacyData = await readLegacyDbJson();
  if (legacyData) {
    const normalizedLegacy = normalizeSchema(legacyData);
    const result = importLowDbSnapshotIfNeeded(
      buildLowDbImportSnapshot(normalizedLegacy),
      { force: options?.force },
    );
    return {
      imported: !result.skipped,
      source: 'db.json',
      result,
    };
  }

  const runtimeStateData = readRuntimeState<Schema>();
  if (runtimeStateData) {
    const normalizedSnapshot = normalizeSchema(runtimeStateData);
    const result = importLowDbSnapshotIfNeeded(
      buildLowDbImportSnapshot(normalizedSnapshot),
      { force: options?.force },
    );
    return {
      imported: !result.skipped,
      source: 'runtime_state',
      result,
    };
  }

  return {
    imported: false,
    source: 'none',
    result: {
      skipped: true,
      attempted: {
        receiptRecords: 0,
        receiptAccessTokens: 0,
        feedbackSessions: 0,
        feedback: 0,
        reportIssueSessions: 0,
        reportIssues: 0,
        reportIssueAttachments: 0,
        logs: 0,
      },
      inserted: {
        receiptRecords: 0,
        receiptAccessTokens: 0,
        feedbackSessions: 0,
        feedback: 0,
        reportIssueSessions: 0,
        reportIssues: 0,
        reportIssueAttachments: 0,
        logs: 0,
      },
      skippedOrphans: {
        receiptAccessTokens: 0,
        feedback: 0,
        reportIssues: 0,
        reportIssueAttachments: 0,
      },
    },
  };
}

export const db: {
  data: Schema | null;
  read: () => Promise<void>;
  write: () => Promise<void>;
} = {
  data: null,
  async read() {
    initSqliteStorage();
    migrateSchemaSnapshotToRuntimeState();

    const runtimeState = readRuntimeState<Schema>();
    if (runtimeState) {
      db.data = normalizeSchema(runtimeState);
      return;
    }

    const legacyData = await readLegacyDbJson();
    db.data = normalizeSchema(legacyData);
  },
  async write() {
    if (!db.data) {
      db.data = cloneDefaultData();
    }
    writeRuntimeState(db.data);
  },
};

export async function initDB() {
  try {
    await db.read();
  } catch {
    db.data = cloneDefaultData();
    await db.write();
    await migrateLegacyDbJsonToSqlite();
    return;
  }

  try {
    db.data = normalizeSchema(db.data ?? undefined);
  } catch (error) {
    console.error('[DB] Failed to normalize database after db.read().', {
      error: error instanceof Error ? error.message : String(error),
    });
    db.data = cloneDefaultData();
  }
  await db.write();
  await migrateLegacyDbJsonToSqlite();

  clearStalePricingAnalysisCache(ANALYSIS_ALGORITHM_VERSION);
}

// ── Balance mutex ─────────────────────────────────────────────────────────────
export { withBalanceLock } from './balance-lock';
export {
  type IdempotencyEntry,
  acquireIdempotencyKey,
  storeIdempotencyKey,
  releaseIdempotencyKey,
} from './idempotency';
