import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router, Request, Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import {
  requireAdminLocalAccess,
  requireAdminPin,
} from '@/middleware/admin-auth';
import { createRateLimit } from '@/middleware/rate-limit';
import {
  AdminService,
  type EarningsAnalyticsView,
  type TransactionLogFilters,
  type TransactionLogMode,
  type TransactionLogStatus,
} from './admin.service';
import {
  db,
  type AdminLogEntry,
  type LogMeta,
  type PendingRefundEntry,
  type RecoverySessionEntry,
  type SpoolerLifecycleTransitionEntry,
} from '@/services/db';
import {
  PendingRefundServiceError,
  dismissPendingRefund,
  processPendingRefund,
} from '@/services/pending-refund';
import { anomalyService } from '@/modules/anomaly/anomaly.service';
import { generateTestPagePdf } from '@/services/test-page';
import {
  listInstalledPrinters,
  runInkTelemetryDiagnostics,
  getPrinterTelemetry,
  refreshPrinterTelemetry,
} from '@/services/printer-state-projection';
import { getExternalWatchdogState } from '@/services/watchdog-health';
import { detectDefaultPrinter } from '@/services/printer';
import { handoffToWorker } from '@/infrastructure/worker';
import { WORKER_QUEUE_DIR } from '@/config';
import { getScannerStatus } from '@/services/scanner';
import {
  getTrustedTimeStatus,
  verifyTrustedClockSync,
} from '@/services/time-source';
import {
  checkpointRecoverySession,
  getRecoveryStatusSnapshot,
  getSpoolerLifecycleRecord,
} from '@/services/recovery';
import {
  checkLockout,
  clearLockout,
  formatRemainingTime,
  recordFailedAttempt,
  MAX_ATTEMPTS,
} from '@/utils/lockout';
import { hashPassword, verifyPassword } from '@/utils/hash';
import { createAdminSession, destroyAdminSession } from '@/utils/admin-session';
import type { AlertSettings } from './admin.schema';
import type { AdminQueueView } from '@/modules/anomaly/anomaly.schema';
import { ConsumablesService } from './consumables.service';
import { ReceiptService, type ReceiptPayload } from '@/modules/receipt';
import {
  ADMIN_TEST_PAGE_USAGE_SOURCE,
  consumablesStore,
  getSqliteDb,
  writeRuntimeState,
} from '@/core/database/sqlite-storage';
import { requestWindowsShutdown } from '@/services/windows-power';

export interface AdminControllerDeps {
  io: SocketIOServer;
  uploadDir: string;
  getSerialStatus: () => {
    connected: boolean;
    portPath: string | null;
    lastError: string | null;
  };
  getHopperStatus: () => {
    connected: boolean;
    pending: boolean;
    portPath: string | null;
    lastError: string | null;
    lastSuccessAt: string | null;
  };
  runHopperSelfTest: () => Promise<{
    ok: boolean;
    amount: number;
    message: string;
    attempts: number;
    owedChangeId?: string;
  }>;
  shutdownWindows?: () => Promise<void>;
}

// ── Validation helpers ─────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWholePeso(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function normalizeTargetPrinterName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return sanitized ? sanitized : null;
}

function isEarningsAnalyticsView(
  value: unknown,
): value is EarningsAnalyticsView {
  return (
    value === 'daily' ||
    value === 'weekly' ||
    value === 'monthly' ||
    value === 'yearly'
  );
}

function isAnomalySeverity(value: unknown): value is 'warning' | 'critical' {
  return value === 'warning' || value === 'critical';
}

function isAnomalyStatus(
  value: unknown,
): value is 'open' | 'acknowledged' | 'resolved' {
  return value === 'open' || value === 'acknowledged' || value === 'resolved';
}

function isAnomalyCategory(
  value: unknown,
): value is
  | 'printer'
  | 'spooler'
  | 'serial'
  | 'hopper'
  | 'network'
  | 'security' {
  return (
    value === 'printer' ||
    value === 'spooler' ||
    value === 'serial' ||
    value === 'hopper' ||
    value === 'network' ||
    value === 'security'
  );
}

function isTransactionLogMode(value: unknown): value is TransactionLogMode {
  return value === 'print' || value === 'copy' || value === 'scan';
}

function isTransactionLogStatus(value: unknown): value is TransactionLogStatus {
  return (
    value === 'created' ||
    value === 'processing' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'refund'
  );
}

function parseIsoTimestampQuery(
  queryValue: unknown,
  fieldName: string,
): { value?: string; error?: string } {
  if (queryValue === undefined || queryValue === null || queryValue === '') {
    return {};
  }
  if (typeof queryValue !== 'string') {
    return { error: `${fieldName} must be a valid ISO timestamp.` };
  }
  const parsed = Date.parse(queryValue);
  if (!Number.isFinite(parsed)) {
    return { error: `${fieldName} must be a valid ISO timestamp.` };
  }
  return { value: new Date(parsed).toISOString() };
}

function parseAlertSettingsPayload(
  body: unknown,
  current: AlertSettings,
): { next?: AlertSettings; error?: string } {
  const payload = body as {
    severityThreshold?: unknown;
    dashboard?: { enabled?: unknown };
    email?: {
      enabled?: unknown;
      smtpHost?: unknown;
      smtpPort?: unknown;
      secure?: unknown;
      username?: unknown;
      from?: unknown;
      to?: unknown;
    };
    dedupe?: {
      printerMs?: unknown;
      spoolerMs?: unknown;
      serialMs?: unknown;
      hopperMs?: unknown;
      networkMs?: unknown;
      securityMs?: unknown;
    };
  };

  const next = {
    severityThreshold: current.severityThreshold,
    dashboard: { ...current.dashboard },
    email: { ...current.email },
    dedupe: { ...current.dedupe },
  };

  if (payload.severityThreshold !== undefined) {
    if (!isAnomalySeverity(payload.severityThreshold)) {
      return { error: 'severityThreshold must be "warning" or "critical".' };
    }
    next.severityThreshold = payload.severityThreshold;
  }

  if (payload.dashboard?.enabled !== undefined) {
    if (typeof payload.dashboard.enabled !== 'boolean') {
      return { error: 'dashboard.enabled must be boolean.' };
    }
    next.dashboard.enabled = payload.dashboard.enabled;
  }

  if (payload.email) {
    if (payload.email.enabled !== undefined) {
      if (typeof payload.email.enabled !== 'boolean') {
        return { error: 'email.enabled must be boolean.' };
      }
      next.email.enabled = payload.email.enabled;
    }
    if (payload.email.smtpHost !== undefined) {
      if (typeof payload.email.smtpHost !== 'string') {
        return { error: 'Invalid smtpHost.' };
      }
      next.email.smtpHost = payload.email.smtpHost.trim();
    }
    if (payload.email.smtpPort !== undefined) {
      const smtpPort = Number(payload.email.smtpPort);
      if (!Number.isFinite(smtpPort) || smtpPort <= 0) {
        return { error: 'Invalid smtpPort.' };
      }
      next.email.smtpPort = Math.floor(smtpPort);
    }
    if (payload.email.secure !== undefined) {
      if (typeof payload.email.secure !== 'boolean') {
        return { error: 'email.secure must be boolean.' };
      }
      next.email.secure = payload.email.secure;
    }
    if (payload.email.username !== undefined) {
      if (typeof payload.email.username !== 'string') {
        return { error: 'Invalid email username.' };
      }
      next.email.username = payload.email.username.trim();
    }
    if (
      Object.prototype.hasOwnProperty.call(
        payload.email as Record<string, unknown>,
        'password',
      )
    ) {
      return {
        error:
          'SMTP password is not accepted in settings payload. Set PRINTBIT_ALERT_SMTP_PASSWORD in the environment.',
      };
    }
    if (payload.email.from !== undefined) {
      if (typeof payload.email.from !== 'string') {
        return { error: 'Invalid email from.' };
      }
      next.email.from = payload.email.from.trim();
    }
    if (payload.email.to !== undefined) {
      if (typeof payload.email.to !== 'string') {
        return { error: 'Invalid email to.' };
      }
      next.email.to = payload.email.to.trim();
    }
  }

  if (payload.dedupe) {
    const dedupeEntries: Array<
      [
        (
          | 'printerMs'
          | 'spoolerMs'
          | 'serialMs'
          | 'hopperMs'
          | 'networkMs'
          | 'securityMs'
        ),
        unknown,
      ]
    > = [
      ['printerMs', payload.dedupe.printerMs],
      ['spoolerMs', payload.dedupe.spoolerMs],
      ['serialMs', payload.dedupe.serialMs],
      ['hopperMs', payload.dedupe.hopperMs],
      ['networkMs', payload.dedupe.networkMs],
      ['securityMs', payload.dedupe.securityMs],
    ];
    for (const [key, raw] of dedupeEntries) {
      if (raw === undefined) continue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { error: `Invalid ${key} value.` };
      }
      next.dedupe[key] = Math.floor(parsed);
    }
  }

  return { next };
}

function toSafeAlertSettings(alerts: AlertSettings): {
  severityThreshold: 'warning' | 'critical';
  dashboard: { enabled: boolean };
  email: {
    enabled: boolean;
    smtpHost: string;
    smtpPort: number;
    secure: boolean;
    username: string;
    from: string;
    to: string;
  };
  dedupe: {
    printerMs: number;
    spoolerMs: number;
    serialMs: number;
    hopperMs: number;
    networkMs: number;
    securityMs: number;
  };
} {
  return {
    severityThreshold: alerts.severityThreshold,
    dashboard: { ...alerts.dashboard },
    email: {
      ...alerts.email,
    },
    dedupe: { ...alerts.dedupe },
  };
}

const adminAuthRateLimit = createRateLimit({
  keyPrefix: 'admin-auth',
  windowMs: 60_000,
  max: 5,
});

const adminTimeSyncRateLimit = createRateLimit({
  keyPrefix: 'admin-system-time-sync',
  windowMs: 60_000,
  max: 30,
});

const adminTestPrintRateLimit = createRateLimit({
  keyPrefix: 'admin-printer-test-print',
  windowMs: 60_000,
  max: 5,
});

const adminStorageClearRateLimit = createRateLimit({
  keyPrefix: 'admin-storage-clear',
  windowMs: 10 * 60_000,
  max: 3,
});

const adminShutdownRateLimit = createRateLimit({
  keyPrefix: 'admin-system-shutdown',
  windowMs: 10 * 60_000,
  max: 3,
});

export class AdminController {
  public readonly router: Router;
  private readonly adminService: AdminService;
  private readonly consumablesService: ConsumablesService;
  private readonly receiptService: ReceiptService;
  private readonly deps: AdminControllerDeps;

  constructor(
    adminService: AdminService,
    consumablesService: ConsumablesService,
    deps: AdminControllerDeps,
  ) {
    this.router = Router();
    this.adminService = adminService;
    this.consumablesService = consumablesService;
    this.receiptService = new ReceiptService();
    this.deps = deps;
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    // ── Authentication routes ──────────────────────────────────────────────────
    this.router.post(
      '/auth',
      requireAdminLocalAccess,
      adminAuthRateLimit,
      this.handleAuth,
    );
    this.router.post(
      '/logout',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleLogout,
    );
    this.router.post(
      '/verify',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleVerify,
    );

    // ── Summary and status routes ──────────────────────────────────────────────
    this.router.get(
      '/summary',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetSummary,
    );
    this.router.get(
      '/status',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetStatus,
    );
    this.router.post(
      '/system/shutdown',
      requireAdminLocalAccess,
      requireAdminPin,
      adminShutdownRateLimit,
      this.handleSystemShutdown,
    );
    this.router.get(
      '/earnings/analytics',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetEarningsAnalytics,
    );
    this.router.get(
      '/print-dispatch/latency',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetPrintDispatchLatency,
    );
    this.router.get(
      '/system/time-sync',
      requireAdminLocalAccess,
      requireAdminPin,
      adminTimeSyncRateLimit,
      this.handleGetTimeSync,
    );
    this.router.get(
      '/consumables/forecast',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetConsumablesForecast,
    );
    this.router.post(
      '/consumables/paper-refill',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handlePaperRefill,
    );

    // ── Hopper routes ──────────────────────────────────────────────────────────
    this.router.post(
      '/hopper/self-test',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleHopperSelfTest,
    );

    // ── Settings routes ────────────────────────────────────────────────────────
    this.router.get(
      '/settings',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetSettings,
    );
    this.router.put(
      '/settings',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleUpdateSettings,
    );

    // ── Alert settings routes ──────────────────────────────────────────────────
    this.router.get(
      '/alert-settings',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetAlertSettings,
    );
    this.router.put(
      '/alert-settings',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleUpdateAlertSettings,
    );
    this.router.post(
      '/alert-settings/test',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleTestAlertSettings,
    );

    // ── Printer routes ─────────────────────────────────────────────────────────
    this.router.get(
      '/printer/list',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetPrinterList,
    );
    this.router.get(
      '/printer/ink-diagnostics',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetInkDiagnostics,
    );
    this.router.get(
      '/printer/ink-history',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetInkHistory,
    );
    this.router.post(
      '/printer/reset-ink-counters',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleResetInkCounters,
    );
    this.router.post(
      '/printer/re-detect',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handlePrinterReDetect,
    );
    this.router.post(
      '/printer/test-print',
      requireAdminLocalAccess,
      requireAdminPin,
      adminTestPrintRateLimit,
      this.handleTestPrint,
    );

    // ── Anomaly incidents routes ───────────────────────────────────────────────
    this.router.get(
      '/anomaly-incidents',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetAnomalyIncidents,
    );
    this.router.get(
      '/anomaly-incidents/:id',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetAnomalyIncidentById,
    );
    this.router.patch(
      '/anomaly-incidents/:id/status',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleUpdateAnomalyIncidentStatus,
    );

    // ── Logs routes ────────────────────────────────────────────────────────────
    this.router.get(
      '/logs',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetSystemLogs,
    );
    this.router.get(
      '/logs/system',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetSystemLogs,
    );
    this.router.get(
      '/logs/transactions',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetTransactionLogs,
    );
    this.router.get(
      '/transactions/:transactionId',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetTransactionById,
    );
    this.router.get(
      '/transactions/:transactionId/context',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetTransactionContextById,
    );
    this.router.get(
      '/logs/export.csv',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleExportSystemLogs,
    );
    this.router.get(
      '/logs/system/export.csv',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleExportSystemLogs,
    );
    this.router.get(
      '/logs/transactions/export.csv',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleExportTransactionLogs,
    );
    this.router.delete(
      '/logs',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleDeleteSystemLogs,
    );
    this.router.delete(
      '/logs/system',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleDeleteSystemLogs,
    );
    this.router.delete(
      '/logs/transactions',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleDeleteTransactionLogs,
    );

    // ── Balance and storage routes ─────────────────────────────────────────────
    this.router.post(
      '/balance/reset',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleResetBalance,
    );
    this.router.post(
      '/storage/clear',
      requireAdminLocalAccess,
      requireAdminPin,
      adminStorageClearRateLimit,
      this.handleClearStorage,
    );

    // ── Owed changes routes ────────────────────────────────────────────────────
    this.router.get(
      '/owed-changes',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetOwedChanges,
    );
    this.router.post(
      '/owed-changes/:id/resolve',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleResolveOwedChange,
    );
    this.router.post(
      '/owed-changes/resolve-all',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleResolveAllOwedChanges,
    );

    // ── Pending refunds routes ─────────────────────────────────────────────────
    this.router.get(
      '/pending-refunds',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleGetPendingRefunds,
    );
    this.router.post(
      '/pending-refunds/:id/refund',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleProcessPendingRefund,
    );
    this.router.post(
      '/pending-refunds/:id/dismiss',
      requireAdminLocalAccess,
      requireAdminPin,
      this.handleDismissPendingRefund,
    );
  }

  // ── Authentication handlers ────────────────────────────────────────────────

  private handleAuth = async (req: Request, res: Response) => {
    const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';

    const lockStatus = checkLockout();
    if (lockStatus.locked) {
      await this.adminService.appendAdminLog(
        'admin_auth_blocked',
        `Admin login blocked - account is locked.`,
      );
      return res.status(423).json({
        ok: false,
        error: `Too many failed attempts. Try again in ${formatRemainingTime(lockStatus.remainingMs!)}.`,
      });
    }

    if (!pin) {
      return res.status(400).json({ ok: false, error: 'PIN is required.' });
    }

    const storedPin = db.data!.settings.adminPin;
    let valid: boolean;

    try {
      valid = await verifyPassword(storedPin, pin);
    } catch {
      valid = storedPin === pin;
    }

    if (!valid) {
      const attempts = await recordFailedAttempt();
      const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attempts);

      await this.adminService.appendAdminLog(
        'admin_auth_failed',
        `Admin login failed (attempt ${attempts}/${MAX_ATTEMPTS}).`,
      );

      const message =
        attemptsLeft > 0
          ? `Incorrect PIN. ${attemptsLeft} attempt${attemptsLeft !== 1 ? 's' : ''} remaining.`
          : 'Too many failed attempts. Kiosk locked for 10 minutes.';

      return res.status(401).json({ ok: false, error: message });
    }

    await clearLockout();
    const sessionToken = createAdminSession();

    res.cookie('adminToken', sessionToken, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.json({ ok: true });
  };

  private handleLogout = async (_req: Request, res: Response) => {
    destroyAdminSession();
    await this.adminService.appendAdminLog('admin_logout', 'Admin logged out.');
    res.clearCookie('adminToken');
    return res.json({ ok: true });
  };

  private handleVerify = (_req: Request, res: Response) => {
    res.json({ ok: true });
  };

  // ── Summary and status handlers ────────────────────────────────────────────

  private handleGetSummary = (req: Request, res: Response) => {
    const storage = this.adminService.getStorageUsage(this.deps.uploadDir);
    const host = req.get('host') ?? 'unknown';
    const wifiActive =
      !host.startsWith('localhost') && !host.startsWith('127.0.0.1');
    const printer = getPrinterTelemetry();
    const scanner = getScannerStatus();
    const anomalyOpenCount = db.data!.anomalyIncidents.filter(
      (entry) => entry.status === 'open',
    ).length;
    const feedbackOpenCount = (db.data!.feedback ?? []).filter(
      (entry) => entry.status === 'open',
    ).length;
    const reportIssuesOpenCount = (db.data!.reportIssues ?? []).filter(
      (entry) => entry.status === 'open',
    ).length;
    const pendingRefunds = db.data!.pendingRefunds ?? [];
    const openRefunds = pendingRefunds.filter(
      (entry) => entry.status === 'open',
    );
    const refundedEntries = pendingRefunds.filter(
      (entry) => entry.status === 'refunded',
    );
    const dismissedEntries = pendingRefunds.filter(
      (entry) => entry.status === 'dismissed',
    );
    const autoRefundedEntries = refundedEntries.filter(
      (entry) => entry.jobContext.refundDisposition === 'auto_refunded',
    );
    const jamLogTypes = new Set([
      'print_spooler_job_failed',
      'print_spooler_auto_refund',
      'printer_malfunction_detected',
      'printer_midjob_malfunction',
    ]);
    const jamEvents = this.adminService
      .listLogsByTypes([...jamLogTypes])
      .filter((entry) => jamLogTypes.has(entry.type));
    const nowMs = Date.now();
    const recentJamEvents = jamEvents.filter((entry) => {
      const tsMs = Date.parse(entry.timestamp);
      return Number.isFinite(tsMs) && nowMs - tsMs <= 24 * 60 * 60 * 1000;
    });
    const recovery = getRecoveryStatusSnapshot();
    const consumablesForecast = this.consumablesService.getForecast();

    // Compute page counts (color / bw) for today and all-time from receipt_records
    try {
      const sqlite = getSqliteDb();
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const startIso = startOfToday.toISOString();
      const todayRow = sqlite
        .prepare(
          `SELECT SUM(COALESCE(color_pages, 0)) AS colorSum, SUM(COALESCE(bw_pages, 0)) AS bwSum
           FROM receipt_records WHERE mode IN ('print','copy') AND created_at >= ?`,
        )
        .get(startIso) as Record<string, unknown> | undefined;
      const totalRow = sqlite
        .prepare(
          `SELECT SUM(COALESCE(color_pages, 0)) AS colorSum, SUM(COALESCE(bw_pages, 0)) AS bwSum
           FROM receipt_records WHERE mode IN ('print','copy')`,
        )
        .get() as Record<string, unknown> | undefined;

      const baseline = db.data!.inkRefillBaseline;
      const todayAdminTestPages = consumablesStore.sumUsagePagesBySource(
        ADMIN_TEST_PAGE_USAGE_SOURCE,
        startIso,
      );
      const totalAdminTestPages = consumablesStore.sumUsagePagesBySource(
        ADMIN_TEST_PAGE_USAGE_SOURCE,
      );
      const totalColor =
        Number(totalRow?.colorSum ?? 0) + totalAdminTestPages.colorPages;
      const totalBw = Number(totalRow?.bwSum ?? 0) + totalAdminTestPages.bwPages;

      const pageCounts = {
        todayColorPages:
          Number(todayRow?.colorSum ?? 0) + todayAdminTestPages.colorPages,
        todayBwPages:
          Number(todayRow?.bwSum ?? 0) + todayAdminTestPages.bwPages,
        totalColorPages: totalColor,
        totalBwPages: totalBw,
        refillColorPages: Math.max(0, totalColor - baseline.colorPages),
        refillBwPages: Math.max(0, totalBw - baseline.bwPages),
        lastRefillAt: baseline.updatedAt,
      };

      // ── Page-count-based ink depletion estimation ──────────────
      const INK_GRAYSCALE_MAX_PAGES = 4500;
      const INK_COLOR_MAX_PAGES = 7500; // combined yield for C+M+Y
      const INK_ALERT_THRESHOLD = 30;

      const refillColor = pageCounts.refillColorPages;
      const refillBw = pageCounts.refillBwPages;

      const computeTank = (pagesUsed: number, maxPages: number) => {
        const remaining = Math.max(
          0,
          Math.min(100, 100 - (pagesUsed / maxPages) * 100),
        );
        return {
          pagesUsed,
          maxPages,
          remainingPercent: Math.round(remaining * 10) / 10,
          alertTriggered: remaining <= INK_ALERT_THRESHOLD,
        };
      };

      // Grayscale ink tracks BW pages only
      const grayscaleTank = computeTank(refillBw, INK_GRAYSCALE_MAX_PAGES);
      // Color ink (C+M+Y combined) tracks color pages only
      const colorTank = computeTank(refillColor, INK_COLOR_MAX_PAGES);

      const inkEstimation = {
        grayscale: grayscaleTank,
        color: colorTank,
        alertThresholdPercent: INK_ALERT_THRESHOLD,
        anyAlertTriggered:
          grayscaleTank.alertTriggered || colorTank.alertTriggered,
      };

      res.json({
        balance: db.data!.balance,
        earnings: this.adminService.computeEarningsBuckets(),
        coinStats: db.data!.coinStats,
        jobStats: db.data!.jobStats,
        hopperStats: db.data!.hopperStats,
        owedChangeOpenCount: db.data!.owedChanges.filter(
          (entry) => entry.status === 'open',
        ).length,
        pendingRefundOpenCount: openRefunds.length,
        refundStats: {
          totalCount: pendingRefunds.length,
          openCount: openRefunds.length,
          refundedCount: refundedEntries.length,
          dismissedCount: dismissedEntries.length,
          autoRefundedCount: autoRefundedEntries.length,
        },
        anomalyStats: {
          totalCount: db.data!.anomalyIncidents.length,
          openCount: anomalyOpenCount,
        },
        feedbackStats: {
          totalCount: (db.data!.feedback ?? []).length,
          openCount: feedbackOpenCount,
        },
        reportStats: {
          totalCount: (db.data!.reportIssues ?? []).length,
          openCount: reportIssuesOpenCount,
        },
        recoveryStats: {
          bootCount: recovery.lifecycle.bootCount,
          unexpectedRestartCount: recovery.lifecycle.unexpectedRestartCount,
          lastStartupAt: recovery.lifecycle.lastStartupAt,
          lastShutdownAt: recovery.lifecycle.lastShutdownAt,
          inFlightCount: recovery.sessionStats.inFlight,
          startupPendingCount: recovery.sessionStats.startupPending,
          autoRefundedCount: recovery.sessionStats.autoRefunded,
          pendingAdminReviewCount: recovery.sessionStats.pendingAdminReview,
          voidedCount: recovery.sessionStats.voided,
        },
        jamStats: {
          totalEvents: jamEvents.length,
          recent24h: recentJamEvents.length,
          lastJamAt: jamEvents[0]?.timestamp ?? null,
        },
        consumables: consumablesForecast,
        storage,
        status: {
          serverRunning: true,
          uptimeSeconds: Math.floor(process.uptime()),
          serial: this.deps.getSerialStatus(),
          hopper: this.deps.getHopperStatus(),
          printer,
          scanner,
          watchdog: getExternalWatchdogState(),
          trustedTime: getTrustedTimeStatus(),
          host,
          wifiActive,
        },
        pageCounts,
        inkEstimation,
      });
    } catch {
      // Fallback: return summary without pageCounts if DB query fails
      res.json({
        balance: db.data!.balance,
        earnings: this.adminService.computeEarningsBuckets(),
        coinStats: db.data!.coinStats,
        jobStats: db.data!.jobStats,
        hopperStats: db.data!.hopperStats,
        owedChangeOpenCount: db.data!.owedChanges.filter(
          (entry) => entry.status === 'open',
        ).length,
        pendingRefundOpenCount: openRefunds.length,
        refundStats: {
          totalCount: pendingRefunds.length,
          openCount: openRefunds.length,
          refundedCount: refundedEntries.length,
          dismissedCount: dismissedEntries.length,
          autoRefundedCount: autoRefundedEntries.length,
        },
        anomalyStats: {
          totalCount: db.data!.anomalyIncidents.length,
          openCount: anomalyOpenCount,
        },
        feedbackStats: {
          totalCount: (db.data!.feedback ?? []).length,
          openCount: feedbackOpenCount,
        },
        reportStats: {
          totalCount: (db.data!.reportIssues ?? []).length,
          openCount: reportIssuesOpenCount,
        },
        recoveryStats: {
          bootCount: recovery.lifecycle.bootCount,
          unexpectedRestartCount: recovery.lifecycle.unexpectedRestartCount,
          lastStartupAt: recovery.lifecycle.lastStartupAt,
          lastShutdownAt: recovery.lifecycle.lastShutdownAt,
          inFlightCount: recovery.sessionStats.inFlight,
          startupPendingCount: recovery.sessionStats.startupPending,
          autoRefundedCount: recovery.sessionStats.autoRefunded,
          pendingAdminReviewCount: recovery.sessionStats.pendingAdminReview,
          voidedCount: recovery.sessionStats.voided,
        },
        jamStats: {
          totalEvents: jamEvents.length,
          recent24h: recentJamEvents.length,
          lastJamAt: jamEvents[0]?.timestamp ?? null,
        },
        consumables: consumablesForecast,
        storage,
        status: {
          serverRunning: true,
          uptimeSeconds: Math.floor(process.uptime()),
          serial: this.deps.getSerialStatus(),
          hopper: this.deps.getHopperStatus(),
          printer,
          scanner,
          watchdog: getExternalWatchdogState(),
          trustedTime: getTrustedTimeStatus(),
          host,
          wifiActive,
        },
      });
    }
  };

  private handleGetStatus = (req: Request, res: Response) => {
    const storage = this.adminService.getStorageUsage(this.deps.uploadDir);
    const host = req.get('host') ?? 'unknown';
    const wifiActive =
      !host.startsWith('localhost') && !host.startsWith('127.0.0.1');
    const printer = getPrinterTelemetry();
    const scanner = getScannerStatus();
    res.json({
      serverRunning: true,
      uptimeSeconds: Math.floor(process.uptime()),
      serial: this.deps.getSerialStatus(),
      hopper: this.deps.getHopperStatus(),
      printer,
      scanner,
      watchdog: getExternalWatchdogState(),
      trustedTime: getTrustedTimeStatus(),
      storage,
      host,
      wifiActive,
    });
  };

  private handleSystemShutdown = async (_req: Request, res: Response) => {
    const recovery = getRecoveryStatusSnapshot();
    const hopper = this.deps.getHopperStatus();

    if (recovery.sessionStats.inFlight > 0 || hopper.pending) {
      return res.status(409).json({
        ok: false,
        error: 'Cannot shut down while a customer operation is in progress.',
      });
    }

    try {
      await this.adminService.appendAdminLog(
        'admin_system_shutdown_requested',
        'Administrator requested a Windows shutdown from the System Control Center.',
      );
      await (this.deps.shutdownWindows ?? requestWindowsShutdown)();
      return res.status(202).json({
        ok: true,
        message: 'Windows shutdown scheduled.',
      });
    } catch (error) {
      await this.adminService.appendAdminLog(
        'admin_system_shutdown_failed',
        `Windows shutdown could not be scheduled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return res.status(503).json({
        ok: false,
        error: 'Windows shutdown could not be scheduled.',
      });
    }
  };

  private handleGetEarningsAnalytics = (req: Request, res: Response) => {
    const viewParam =
      typeof req.query.view === 'string' ? req.query.view : undefined;
    const view: EarningsAnalyticsView = isEarningsAnalyticsView(viewParam)
      ? viewParam
      : 'weekly';
    const anchorRaw =
      typeof req.query.anchor === 'string' ? req.query.anchor : undefined;
    const anchor = anchorRaw ? new Date(anchorRaw) : new Date();
    if (Number.isNaN(anchor.getTime())) {
      return res.status(400).json({
        error: 'Invalid anchor date. Use ISO date format (YYYY-MM-DD).',
      });
    }

    const analytics = this.adminService.computeDetailedEarningsAnalytics({
      view,
      anchor,
    });

    return res.json(analytics);
  };

  private handleGetPrintDispatchLatency = (req: Request, res: Response) => {
    const maxEventsRaw =
      typeof req.query.maxEvents === 'string' ? req.query.maxEvents : undefined;
    const maxEvents = maxEventsRaw ? Number(maxEventsRaw) : 5000;
    const metrics = this.adminService.computeDispatchLatencyMetrics(maxEvents);
    return res.json(metrics);
  };

  private handleGetTimeSync = async (_req: Request, res: Response) => {
    const trustedTime = await verifyTrustedClockSync();
    const ok =
      trustedTime.synced &&
      !trustedTime.driftExceeded &&
      (trustedTime.offsetMs !== null || !trustedTime.enforceForFinancial);
    res.status(ok ? 200 : 503).json({
      ok,
      trustedTime,
    });
  };

  private handleGetConsumablesForecast = (_req: Request, res: Response) => {
    res.json(this.consumablesService.getForecast());
  };

  private handlePaperRefill = async (req: Request, res: Response) => {
    const body = req.body as {
      currentSheets?: unknown;
      paperTrayCapacitySheets?: unknown;
    };
    const currentSheetsRaw = body.currentSheets;
    const trayCapacityRaw = body.paperTrayCapacitySheets;

    if (
      !isFiniteNumber(currentSheetsRaw) ||
      !Number.isInteger(currentSheetsRaw)
    ) {
      return res.status(400).json({
        error: 'currentSheets must be a whole number.',
      });
    }
    if (currentSheetsRaw < 0) {
      return res.status(400).json({
        error: 'currentSheets must be >= 0.',
      });
    }
    if (
      trayCapacityRaw !== undefined &&
      (!isFiniteNumber(trayCapacityRaw) ||
        !Number.isInteger(trayCapacityRaw) ||
        trayCapacityRaw < 1)
    ) {
      return res.status(400).json({
        error: 'paperTrayCapacitySheets must be a whole number >= 1.',
      });
    }

    const currentSheets = Math.floor(currentSheetsRaw);
    const trayCapacitySheets =
      trayCapacityRaw === undefined ? undefined : Math.floor(trayCapacityRaw);
    const targetCapacity =
      trayCapacitySheets ??
      db.data!.settings.consumablesForecasting.paperTrayCapacitySheets;

    if (currentSheets > targetCapacity) {
      return res.status(400).json({
        error: 'currentSheets cannot exceed paperTrayCapacitySheets.',
      });
    }

    const updated = await this.consumablesService.applyPaperRefill({
      currentSheets,
      trayCapacitySheets,
    });

    await this.adminService.appendAdminLog(
      'consumables_paper_refilled',
      'Paper inventory was updated from admin refill action.',
      {
        currentSheets: updated.currentSheets,
        trayCapacitySheets: updated.trayCapacitySheets,
        updatedAt: updated.updatedAt,
      },
    );

    return res.json({
      ok: true,
      paper: updated,
      forecast: this.consumablesService.getForecast(),
    });
  };

  // ── Hopper handlers ────────────────────────────────────────────────────────

  private handleHopperSelfTest = async (_req: Request, res: Response) => {
    const result = await this.deps.runHopperSelfTest();
    res.status(result.ok ? 200 : 503).json(result);
  };

  // ── Settings handlers ──────────────────────────────────────────────────────

  private handleGetSettings = (_req: Request, res: Response) => {
    res.json(db.data!.settings);
  };

  private handleUpdateSettings = async (req: Request, res: Response) => {
    const body = req.body as {
      pricing?: {
        printPerPage?: number;
        copyPerPage?: number;
        scanDocument?: number;
        colorSurcharge?: number;
        highQualitySurcharge?: number;
      };
      idleTimeoutSeconds?: number;
      idleScreenTimeoutSeconds?: number;
      adminPin?: string;
      adminLocalOnly?: boolean;
      inkMonitoring?: {
        enabled?: boolean;
        targetPrinterName?: string | null;
        lowThresholdPercent?: number;
        criticalThresholdPercent?: number;
        blockOnLow?: boolean;
        blockOnEmpty?: boolean;
        telemetryUnknownPolicy?: 'warn_allow' | 'block';
      };
      consumablesForecasting?: {
        enabled?: boolean;
        rollingWindowDays?: number;
        alertDaysThreshold?: number;
        paperTrayCapacitySheets?: number;
        paperCurrentSheets?: number;
      };
      consumableEstimation?: {
        defaultCoefficients?: {
          bwBlack?: number;
          colorCyan?: number;
          colorMagenta?: number;
          colorYellow?: number;
          colorBlack?: number;
        };
        printerOverrides?: Record<
          string,
          {
            bwBlack?: number;
            colorCyan?: number;
            colorMagenta?: number;
            colorYellow?: number;
            colorBlack?: number;
          }
        >;
      };
      pricingEngine?: {
        paperProfiles?: {
          a4?: { baseBwPrice?: number; baseColorPrice?: number };
          shortBond?: { baseBwPrice?: number; baseColorPrice?: number };
          longBond?: { baseBwPrice?: number; baseColorPrice?: number };
        };
        bulkDiscountTiers?: {
          minPages?: number;
          maxPages?: number;
          discountPerPage?: number;
        }[];
        rounding?: 'whole_peso_total_only';
        highQualitySurcharge?: number;
      };
    };

    const printPerPage = body.pricing?.printPerPage;
    const copyPerPage = body.pricing?.copyPerPage;
    const scanDocument = body.pricing?.scanDocument;
    const colorSurcharge = body.pricing?.colorSurcharge;
    const highQualitySurcharge = body.pricing?.highQualitySurcharge;

    if (
      printPerPage !== undefined &&
      (!isFiniteNumber(printPerPage) || !isWholePeso(printPerPage))
    ) {
      return res.status(400).json({
        error: 'printPerPage must be a whole peso value (no decimals).',
      });
    }
    if (
      copyPerPage !== undefined &&
      (!isFiniteNumber(copyPerPage) || !isWholePeso(copyPerPage))
    ) {
      return res.status(400).json({
        error: 'copyPerPage must be a whole peso value (no decimals).',
      });
    }
    if (
      scanDocument !== undefined &&
      (!isFiniteNumber(scanDocument) || !isWholePeso(scanDocument))
    ) {
      return res.status(400).json({
        error: 'scanDocument must be a whole peso value (no decimals).',
      });
    }
    if (
      colorSurcharge !== undefined &&
      (!isFiniteNumber(colorSurcharge) || !isWholePeso(colorSurcharge))
    ) {
      return res.status(400).json({
        error: 'colorSurcharge must be a whole peso value (no decimals).',
      });
    }
    if (
      highQualitySurcharge !== undefined &&
      (!isFiniteNumber(highQualitySurcharge) ||
        !isWholePeso(highQualitySurcharge))
    ) {
      return res.status(400).json({
        error: 'highQualitySurcharge must be a whole peso value (no decimals).',
      });
    }

    if (
      body.idleTimeoutSeconds !== undefined &&
      (!isFiniteNumber(body.idleTimeoutSeconds) ||
        body.idleTimeoutSeconds < 60 ||
        body.idleTimeoutSeconds > 3600)
    ) {
      return res.status(400).json({
        error: 'idleTimeoutSeconds must be a whole number between 60 and 3600.',
      });
    }

    if (
      body.idleScreenTimeoutSeconds !== undefined &&
      (!isFiniteNumber(body.idleScreenTimeoutSeconds) ||
        body.idleScreenTimeoutSeconds < 10 ||
        body.idleScreenTimeoutSeconds > 600)
    ) {
      return res.status(400).json({
        error:
          'idleScreenTimeoutSeconds must be a whole number between 10 and 600.',
      });
    }

    if (
      body.adminPin !== undefined &&
      (typeof body.adminPin !== 'string' || body.adminPin.trim().length < 4)
    ) {
      return res
        .status(400)
        .json({ error: 'Admin PIN must be at least 4 characters.' });
    }

    const originalSettings = db.data!.settings;
    const nextSettings = {
      ...originalSettings,
      pricing: { ...originalSettings.pricing },
      kioskPreferences: { ...originalSettings.kioskPreferences },
      inkMonitoring: { ...originalSettings.inkMonitoring },
      consumablesForecasting: { ...originalSettings.consumablesForecasting },
      pricingEngine: {
        paperProfiles: {
          a4: {
            ...originalSettings.pricingEngine.paperProfiles.a4,
          },
          shortBond: {
            ...originalSettings.pricingEngine.paperProfiles.shortBond,
          },
          longBond: {
            ...originalSettings.pricingEngine.paperProfiles.longBond,
          },
        },
        bulkDiscountTiers: originalSettings.pricingEngine.bulkDiscountTiers.map(
          (entry) => ({
            ...entry,
          }),
        ),
        rounding: originalSettings.pricingEngine.rounding,
        highQualitySurcharge:
          originalSettings.pricingEngine.highQualitySurcharge,
      },
      consumableEstimation: {
        defaultCoefficients: {
          ...originalSettings.consumableEstimation.defaultCoefficients,
        },
        printerOverrides: {
          ...originalSettings.consumableEstimation.printerOverrides,
        },
      },
    };

    if (body.pricing) {
      if (printPerPage !== undefined)
        nextSettings.pricing.printPerPage = printPerPage;
      if (copyPerPage !== undefined)
        nextSettings.pricing.copyPerPage = copyPerPage;
      if (scanDocument !== undefined)
        nextSettings.pricing.scanDocument = scanDocument;
      if (colorSurcharge !== undefined)
        nextSettings.pricing.colorSurcharge = colorSurcharge;
      if (highQualitySurcharge !== undefined) {
        nextSettings.pricing.highQualitySurcharge = highQualitySurcharge;
        nextSettings.pricingEngine.highQualitySurcharge = highQualitySurcharge;
      }
    }

    if (body.idleTimeoutSeconds !== undefined) {
      nextSettings.idleTimeoutSeconds = Math.floor(body.idleTimeoutSeconds);
    }

    if (body.idleScreenTimeoutSeconds !== undefined) {
      nextSettings.idleScreenTimeoutSeconds = Math.floor(
        body.idleScreenTimeoutSeconds,
      );
    }

    if (body.adminPin && body.adminPin.trim()) {
      nextSettings.adminPin = await hashPassword(body.adminPin.trim());
    }

    if (body.adminLocalOnly !== undefined) {
      nextSettings.adminLocalOnly = Boolean(body.adminLocalOnly);
    }

    let refreshInkTelemetry = false;
    let refreshConsumablesAlerts = false;
    if (body.inkMonitoring) {
      const incoming = body.inkMonitoring;
      const current = nextSettings.inkMonitoring;
      const next = { ...current };
      if (incoming.enabled !== undefined) {
        if (typeof incoming.enabled !== 'boolean') {
          return res
            .status(400)
            .json({ error: 'inkMonitoring.enabled must be boolean.' });
        }
        next.enabled = incoming.enabled;
      }
      if (incoming.targetPrinterName !== undefined) {
        if (
          incoming.targetPrinterName !== null &&
          typeof incoming.targetPrinterName !== 'string'
        ) {
          return res.status(400).json({
            error: 'inkMonitoring.targetPrinterName must be string or null.',
          });
        }
        next.targetPrinterName = normalizeTargetPrinterName(
          incoming.targetPrinterName,
        );
      }
      if (incoming.lowThresholdPercent !== undefined) {
        if (
          !isFiniteNumber(incoming.lowThresholdPercent) ||
          incoming.lowThresholdPercent < 0 ||
          incoming.lowThresholdPercent > 100
        ) {
          return res.status(400).json({
            error: 'inkMonitoring.lowThresholdPercent must be 0..100.',
          });
        }
        next.lowThresholdPercent = Math.floor(incoming.lowThresholdPercent);
      }
      if (incoming.criticalThresholdPercent !== undefined) {
        if (
          !isFiniteNumber(incoming.criticalThresholdPercent) ||
          incoming.criticalThresholdPercent < 0 ||
          incoming.criticalThresholdPercent > 100
        ) {
          return res.status(400).json({
            error: 'inkMonitoring.criticalThresholdPercent must be 0..100.',
          });
        }
        next.criticalThresholdPercent = Math.floor(
          incoming.criticalThresholdPercent,
        );
      }
      if (next.criticalThresholdPercent > next.lowThresholdPercent) {
        return res.status(400).json({
          error:
            'inkMonitoring.criticalThresholdPercent cannot be greater than lowThresholdPercent.',
        });
      }
      if (incoming.blockOnLow !== undefined) {
        if (typeof incoming.blockOnLow !== 'boolean') {
          return res
            .status(400)
            .json({ error: 'inkMonitoring.blockOnLow must be boolean.' });
        }
        next.blockOnLow = incoming.blockOnLow;
      }
      if (incoming.blockOnEmpty !== undefined) {
        if (typeof incoming.blockOnEmpty !== 'boolean') {
          return res
            .status(400)
            .json({ error: 'inkMonitoring.blockOnEmpty must be boolean.' });
        }
        next.blockOnEmpty = incoming.blockOnEmpty;
      }
      if (incoming.telemetryUnknownPolicy !== undefined) {
        if (
          incoming.telemetryUnknownPolicy !== 'warn_allow' &&
          incoming.telemetryUnknownPolicy !== 'block'
        ) {
          return res.status(400).json({
            error:
              'inkMonitoring.telemetryUnknownPolicy must be "warn_allow" or "block".',
          });
        }
        next.telemetryUnknownPolicy = incoming.telemetryUnknownPolicy;
      }

      nextSettings.inkMonitoring = next;
      refreshInkTelemetry =
        originalSettings.inkMonitoring.targetPrinterName !==
        nextSettings.inkMonitoring.targetPrinterName;
    }

    if (body.consumablesForecasting) {
      const incoming = body.consumablesForecasting;
      const current = nextSettings.consumablesForecasting;
      const next = { ...current };

      if (incoming.enabled !== undefined) {
        if (typeof incoming.enabled !== 'boolean') {
          return res.status(400).json({
            error: 'consumablesForecasting.enabled must be boolean.',
          });
        }
        next.enabled = incoming.enabled;
      }

      if (incoming.rollingWindowDays !== undefined) {
        if (
          !isFiniteNumber(incoming.rollingWindowDays) ||
          !Number.isInteger(incoming.rollingWindowDays) ||
          incoming.rollingWindowDays < 1 ||
          incoming.rollingWindowDays > 90
        ) {
          return res.status(400).json({
            error: 'consumablesForecasting.rollingWindowDays must be 1..90.',
          });
        }
        next.rollingWindowDays = Math.floor(incoming.rollingWindowDays);
      }

      if (incoming.alertDaysThreshold !== undefined) {
        if (
          !isFiniteNumber(incoming.alertDaysThreshold) ||
          !Number.isInteger(incoming.alertDaysThreshold) ||
          incoming.alertDaysThreshold < 1 ||
          incoming.alertDaysThreshold > 60
        ) {
          return res.status(400).json({
            error: 'consumablesForecasting.alertDaysThreshold must be 1..60.',
          });
        }
        next.alertDaysThreshold = Math.floor(incoming.alertDaysThreshold);
      }

      if (incoming.paperTrayCapacitySheets !== undefined) {
        if (
          !isFiniteNumber(incoming.paperTrayCapacitySheets) ||
          !Number.isInteger(incoming.paperTrayCapacitySheets) ||
          incoming.paperTrayCapacitySheets < 1
        ) {
          return res.status(400).json({
            error:
              'consumablesForecasting.paperTrayCapacitySheets must be a whole number >= 1.',
          });
        }
        next.paperTrayCapacitySheets = Math.floor(
          incoming.paperTrayCapacitySheets,
        );
      }

      if (incoming.paperCurrentSheets !== undefined) {
        if (
          !isFiniteNumber(incoming.paperCurrentSheets) ||
          !Number.isInteger(incoming.paperCurrentSheets) ||
          incoming.paperCurrentSheets < 0
        ) {
          return res.status(400).json({
            error:
              'consumablesForecasting.paperCurrentSheets must be a whole number >= 0.',
          });
        }
        next.paperCurrentSheets = Math.floor(incoming.paperCurrentSheets);
      }

      if (next.paperCurrentSheets > next.paperTrayCapacitySheets) {
        return res.status(400).json({
          error:
            'consumablesForecasting.paperCurrentSheets cannot exceed paperTrayCapacitySheets.',
        });
      }

      if (
        incoming.paperCurrentSheets !== undefined &&
        next.paperCurrentSheets !==
          originalSettings.consumablesForecasting.paperCurrentSheets
      ) {
        next.paperRefillUpdatedAt = new Date().toISOString();
      }

      nextSettings.consumablesForecasting = next;
      refreshConsumablesAlerts =
        originalSettings.consumablesForecasting.enabled !== next.enabled ||
        originalSettings.consumablesForecasting.rollingWindowDays !==
          next.rollingWindowDays ||
        originalSettings.consumablesForecasting.alertDaysThreshold !==
          next.alertDaysThreshold ||
        originalSettings.consumablesForecasting.paperTrayCapacitySheets !==
          next.paperTrayCapacitySheets ||
        originalSettings.consumablesForecasting.paperCurrentSheets !==
          next.paperCurrentSheets;
    }

    if (body.consumableEstimation) {
      const incoming = body.consumableEstimation;
      const next = {
        defaultCoefficients: {
          ...nextSettings.consumableEstimation.defaultCoefficients,
        },
        printerOverrides: {
          ...nextSettings.consumableEstimation.printerOverrides,
        },
      };

      const validateCoefficient = (
        value: unknown,
        field: string,
      ): { value?: number; error?: string } => {
        if (value === undefined) return {};
        if (!isFiniteNumber(value) || value < 0) {
          return { error: `${field} must be a finite number >= 0.` };
        }
        return { value };
      };

      if (incoming.defaultCoefficients) {
        const fields: Array<keyof typeof next.defaultCoefficients> = [
          'bwBlack',
          'colorCyan',
          'colorMagenta',
          'colorYellow',
          'colorBlack',
        ];
        for (const field of fields) {
          const parsed = validateCoefficient(
            incoming.defaultCoefficients[field],
            `consumableEstimation.defaultCoefficients.${field}`,
          );
          if (parsed.error) {
            return res.status(400).json({ error: parsed.error });
          }
          if (parsed.value !== undefined) {
            next.defaultCoefficients[field] = parsed.value;
          }
        }
      }

      if (incoming.printerOverrides !== undefined) {
        if (
          typeof incoming.printerOverrides !== 'object' ||
          incoming.printerOverrides === null ||
          Array.isArray(incoming.printerOverrides)
        ) {
          return res.status(400).json({
            error: 'consumableEstimation.printerOverrides must be an object.',
          });
        }

        const normalizedOverrides: Record<
          string,
          typeof next.defaultCoefficients
        > = {};
        for (const [rawKey, rawValue] of Object.entries(
          incoming.printerOverrides,
        )) {
          const normalizedKey = rawKey
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
          if (!normalizedKey) continue;
          if (
            typeof rawValue !== 'object' ||
            rawValue === null ||
            Array.isArray(rawValue)
          ) {
            return res.status(400).json({
              error: `consumableEstimation.printerOverrides.${rawKey} must be an object.`,
            });
          }
          const candidate = rawValue as Record<string, unknown>;
          const merged = {
            ...next.defaultCoefficients,
            ...(next.printerOverrides[normalizedKey] ?? {}),
          };
          const fields: Array<keyof typeof next.defaultCoefficients> = [
            'bwBlack',
            'colorCyan',
            'colorMagenta',
            'colorYellow',
            'colorBlack',
          ];
          for (const field of fields) {
            const parsed = validateCoefficient(
              candidate[field],
              `consumableEstimation.printerOverrides.${rawKey}.${field}`,
            );
            if (parsed.error) {
              return res.status(400).json({ error: parsed.error });
            }
            if (parsed.value !== undefined) {
              merged[field] = parsed.value;
            }
          }
          normalizedOverrides[normalizedKey] = merged;
        }
        next.printerOverrides = normalizedOverrides;
      }

      nextSettings.consumableEstimation = next;
    }

    if (body.pricingEngine) {
      const incoming = body.pricingEngine;
      const next = {
        paperProfiles: {
          a4: {
            ...originalSettings.pricingEngine.paperProfiles.a4,
          },
          shortBond: {
            ...originalSettings.pricingEngine.paperProfiles.shortBond,
          },
          longBond: {
            ...originalSettings.pricingEngine.paperProfiles.longBond,
          },
        },
        bulkDiscountTiers: originalSettings.pricingEngine.bulkDiscountTiers.map(
          (entry) => ({
            ...entry,
          }),
        ),
        rounding: originalSettings.pricingEngine.rounding,
        highQualitySurcharge: nextSettings.pricingEngine.highQualitySurcharge,
      };

      const removedPricingEngineFields = [
        'enabledMode',
        'thresholds',
        'decileSurcharges',
        'suggestionThreshold',
        'nearBlankBwMax',
        'colorMultiplier',
        'blankPagePolicy',
      ] as const;
      for (const fieldName of removedPricingEngineFields) {
        if (Object.prototype.hasOwnProperty.call(incoming, fieldName)) {
          return res.status(400).json({
            error: `pricingEngine.${fieldName} is no longer supported.`,
          });
        }
      }

      if (incoming.paperProfiles?.a4) {
        if (
          !isFiniteNumber(incoming.paperProfiles.a4.baseBwPrice) ||
          !isWholePeso(incoming.paperProfiles.a4.baseBwPrice)
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.a4.baseBwPrice must be a whole peso value >= 0 (no decimals).',
          });
        }
        if (
          !isFiniteNumber(incoming.paperProfiles.a4.baseColorPrice) ||
          !isWholePeso(incoming.paperProfiles.a4.baseColorPrice)
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.a4.baseColorPrice must be a whole peso value >= 0 (no decimals).',
          });
        }
        next.paperProfiles.a4.baseBwPrice =
          incoming.paperProfiles.a4.baseBwPrice;
        next.paperProfiles.a4.baseColorPrice =
          incoming.paperProfiles.a4.baseColorPrice;
      }
      if (
        next.paperProfiles.a4.baseColorPrice <
        next.paperProfiles.a4.baseBwPrice
      ) {
        return res.status(400).json({
          error:
            'pricingEngine.paperProfiles.a4.baseColorPrice cannot be less than baseBwPrice.',
        });
      }

      if (incoming.paperProfiles?.shortBond) {
        if (
          !isFiniteNumber(incoming.paperProfiles.shortBond.baseBwPrice) ||
          !isWholePeso(incoming.paperProfiles.shortBond.baseBwPrice)
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.shortBond.baseBwPrice must be a whole peso value >= 0 (no decimals).',
          });
        }
        if (
          !isFiniteNumber(incoming.paperProfiles.shortBond.baseColorPrice) ||
          !isWholePeso(incoming.paperProfiles.shortBond.baseColorPrice)
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.shortBond.baseColorPrice must be a whole peso value >= 0 (no decimals).',
          });
        }
        next.paperProfiles.shortBond.baseBwPrice =
          incoming.paperProfiles.shortBond.baseBwPrice;
        next.paperProfiles.shortBond.baseColorPrice =
          incoming.paperProfiles.shortBond.baseColorPrice;
      }
      if (
        next.paperProfiles.shortBond.baseColorPrice <
        next.paperProfiles.shortBond.baseBwPrice
      ) {
        return res.status(400).json({
          error:
            'pricingEngine.paperProfiles.shortBond.baseColorPrice cannot be less than baseBwPrice.',
        });
      }

      if (incoming.paperProfiles?.longBond) {
        if (
          !isFiniteNumber(incoming.paperProfiles.longBond.baseBwPrice) ||
          !isWholePeso(incoming.paperProfiles.longBond.baseBwPrice)
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.longBond.baseBwPrice must be a whole peso value >= 0 (no decimals).',
          });
        }
        if (
          !isFiniteNumber(incoming.paperProfiles.longBond.baseColorPrice) ||
          !isWholePeso(incoming.paperProfiles.longBond.baseColorPrice)
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.paperProfiles.longBond.baseColorPrice must be a whole peso value >= 0 (no decimals).',
          });
        }
        next.paperProfiles.longBond.baseBwPrice =
          incoming.paperProfiles.longBond.baseBwPrice;
        next.paperProfiles.longBond.baseColorPrice =
          incoming.paperProfiles.longBond.baseColorPrice;
      }
      if (
        next.paperProfiles.longBond.baseColorPrice <
        next.paperProfiles.longBond.baseBwPrice
      ) {
        return res.status(400).json({
          error:
            'pricingEngine.paperProfiles.longBond.baseColorPrice cannot be less than baseBwPrice.',
        });
      }

      if (incoming.bulkDiscountTiers !== undefined) {
        if (!Array.isArray(incoming.bulkDiscountTiers)) {
          return res.status(400).json({
            error: 'pricingEngine.bulkDiscountTiers must be an array.',
          });
        }
        const parsedTiers: {
          minPages: number;
          maxPages?: number;
          discountPerPage: number;
        }[] = [];
        for (let i = 0; i < incoming.bulkDiscountTiers.length; i += 1) {
          const candidate = incoming.bulkDiscountTiers[i];
          if (typeof candidate !== 'object' || candidate === null) {
            return res.status(400).json({
              error: `pricingEngine.bulkDiscountTiers[${i}] must be an object.`,
            });
          }
          const minPages = candidate.minPages;
          const maxPages = candidate.maxPages;
          const discountPerPage = candidate.discountPerPage;
          if (
            !isFiniteNumber(minPages) ||
            !Number.isInteger(minPages) ||
            minPages < 1
          ) {
            return res.status(400).json({
              error: `pricingEngine.bulkDiscountTiers[${i}].minPages must be a whole number >= 1.`,
            });
          }
          if (
            maxPages !== undefined &&
            (!isFiniteNumber(maxPages) ||
              !Number.isInteger(maxPages) ||
              maxPages < minPages)
          ) {
            return res.status(400).json({
              error: `pricingEngine.bulkDiscountTiers[${i}].maxPages must be a whole number >= minPages.`,
            });
          }
          if (!isFiniteNumber(discountPerPage) || discountPerPage < 0) {
            return res.status(400).json({
              error: `pricingEngine.bulkDiscountTiers[${i}].discountPerPage must be >= 0.`,
            });
          }
          parsedTiers.push({
            minPages,
            ...(maxPages !== undefined ? { maxPages } : {}),
            discountPerPage,
          });
        }
        parsedTiers.sort((a, b) => a.minPages - b.minPages);
        next.bulkDiscountTiers = parsedTiers;
      }

      if (
        incoming.rounding !== undefined &&
        incoming.rounding !== 'whole_peso_total_only'
      ) {
        return res.status(400).json({
          error: 'pricingEngine.rounding must be "whole_peso_total_only".',
        });
      }

      if (incoming.highQualitySurcharge !== undefined) {
        if (
          !isFiniteNumber(incoming.highQualitySurcharge) ||
          !isWholePeso(incoming.highQualitySurcharge) ||
          incoming.highQualitySurcharge < 0
        ) {
          return res.status(400).json({
            error:
              'pricingEngine.highQualitySurcharge must be a whole peso value >= 0 (no decimals).',
          });
        }
        next.highQualitySurcharge = incoming.highQualitySurcharge;
        nextSettings.pricing.highQualitySurcharge =
          incoming.highQualitySurcharge;
      }

      nextSettings.pricingEngine = next;
    }

    db.data!.settings = nextSettings;
    await db.write();
    if (refreshConsumablesAlerts) {
      await this.consumablesService.evaluateAndPublishForecastAlerts();
    }
    if (refreshInkTelemetry) {
      try {
        await refreshPrinterTelemetry();
      } catch (error) {
        console.warn(
          '[ADMIN] Failed to refresh printer telemetry after target printer update.',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    await this.adminService.appendAdminLog(
      'admin_settings_updated',
      'Admin settings updated.',
    );

    res.json(db.data!.settings);
  };

  // ── Alert settings handlers ────────────────────────────────────────────────

  private handleGetAlertSettings = (_req: Request, res: Response) => {
    res.json(toSafeAlertSettings(db.data!.settings.alerts));
  };

  private handleUpdateAlertSettings = async (req: Request, res: Response) => {
    const current = db.data!.settings.alerts;
    const parsed = parseAlertSettingsPayload(req.body, current);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    await anomalyService.updateAlertSettings(parsed.next!);
    await this.adminService.appendAdminLog(
      'admin_alert_settings_updated',
      'Admin alert settings updated.',
    );
    res.json(toSafeAlertSettings(db.data!.settings.alerts));
  };

  private handleTestAlertSettings = async (req: Request, res: Response) => {
    const parsed = parseAlertSettingsPayload(
      req.body,
      db.data!.settings.alerts,
    );
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const result = await anomalyService.sendEmailTestAlert(parsed.next!);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    res.json({ ok: true });
  };

  // ── Printer handlers ───────────────────────────────────────────────────────

  private handleGetPrinterList = async (_req: Request, res: Response) => {
    const printers = (await listInstalledPrinters()).map((printer) => ({
      name: printer.Name,
      driverName: printer.DriverName,
      portName: printer.PortName,
      isDefault: Boolean(printer.Default),
      printerStatus: printer.PrinterStatus,
      printerState: printer.PrinterState,
      pnpInstanceId: printer.PnpInstanceId ?? null,
      pnpFriendlyName: printer.PnpFriendlyName ?? null,
      deviceSerialNumber: printer.DeviceSerialNumber ?? null,
    }));
    res.json({
      printers,
      targetPrinterName: db.data!.settings.inkMonitoring.targetPrinterName,
    });
  };

  private handleGetInkDiagnostics = async (_req: Request, res: Response) => {
    const diagnostics = await runInkTelemetryDiagnostics();
    res.json(diagnostics);
  };

  private handleGetInkHistory = (req: Request, res: Response) => {
    const requestedLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
      : 100;
    res.json({
      total: db.data!.inkHistory.length,
      items: db.data!.inkHistory.slice(0, limit),
    });
  };

  private handlePrinterReDetect = async (_req: Request, res: Response) => {
    await detectDefaultPrinter();
    const telemetry = await refreshPrinterTelemetry();

    await this.adminService.appendAdminLog(
      'admin_printer_redetected',
      `Admin triggered printer re-detection. Result: "${telemetry.name ?? 'none'}" — ${telemetry.status}.`,
      {
        printerName: telemetry.name ?? null,
        printerStatus: telemetry.status,
        connected: telemetry.connected,
        driverName: telemetry.driverName ?? null,
        portName: telemetry.portName ?? null,
        connectionType: telemetry.connectionType,
      },
    );

    res.json({
      ok: true,
      printer: telemetry,
    });
  };

  private handleTestPrint = async (_req: Request, res: Response) => {
    const telemetry = getPrinterTelemetry();
    const startedAtMs = Date.now();

    if (!telemetry.connected || !telemetry.name) {
      await this.adminService.appendAdminLog(
        'admin_test_print_failed',
        'Admin test print skipped: no printer connected.',
        { printerStatus: telemetry.status },
      );
      return res.status(503).json({
        ok: false,
        error: 'No printer is currently connected or detected.',
        printerStatus: telemetry.status,
      });
    }

    const tmpFilename = `test-print-${Date.now()}.pdf`;
    const tmpAbsPath = path.resolve(this.deps.uploadDir, tmpFilename);

    try {
      const pdfBuffer = generateTestPagePdf(new Date());
      fs.writeFileSync(tmpAbsPath, pdfBuffer);

      const queueDir =
        WORKER_QUEUE_DIR || path.resolve('../printbit-worker/queue');
      const transactionId = randomUUID();
      const spoolerCorrelationKey = randomUUID();

      await checkpointRecoverySession({
        transactionId,
        mode: 'print',
        phase: 'preflight_passed',
        requiredAmount: 0,
        spoolerCorrelationKey,
        context: {
          adminTestPrint: true,
          copies: 1,
          duplex: false,
          selectedPages: 1,
          billableColorPages: 0,
          billableBwPages: 1,
          estimatedSheetsUsed: 1,
          colorMode: 'grayscale',
        },
      });

      const handoffResult = await handoffToWorker({
        sourcePath: tmpAbsPath,
        queueDir,
        transactionId,
        spoolerCorrelationKey,
        printSettings: {
          copies: 1,
          color: false,
          orientation: 'portrait',
          quality: 'standard',
        },
      });
      await checkpointRecoverySession({
        transactionId,
        mode: 'print',
        phase: 'job_dispatched',
        requiredAmount: 0,
        spoolerCorrelationKey,
        jobDispatchedAt: new Date().toISOString(),
      });
      const totalElapsedMs = Date.now() - startedAtMs;

      await this.adminService.appendAdminLog(
        'admin_test_print',
        `Admin triggered test print on "${telemetry.name}".`,
        {
          printerName: telemetry.name,
          printerStatus: telemetry.status,
          driverName: telemetry.driverName ?? null,
          portName: telemetry.portName ?? null,
          totalElapsedMs,
          queueFileName: handoffResult.fileName,
          transactionId,
          spoolerCorrelationKey,
        },
      );

      res.json({
        ok: true,
        printerName: telemetry.name,
        printerStatus: telemetry.status,
        message: `Test page queued for "${telemetry.name}". Check the printer output tray.`,
        timing: {
          totalElapsedMs,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const totalElapsedMs = Date.now() - startedAtMs;
      await this.adminService.appendAdminLog(
        'admin_test_print_failed',
        `Admin test print failed on "${telemetry.name}".`,
        {
          printerName: telemetry.name,
          error: message,
          totalElapsedMs,
        },
      );
      res.status(500).json({
        ok: false,
        error: message,
        printerName: telemetry.name,
        timing: {
          totalElapsedMs,
        },
      });
    } finally {
      try {
        fs.unlinkSync(tmpAbsPath);
      } catch {
        /* ignore — file may not exist if writeFileSync itself failed */
      }
    }
  };

  // ── Anomaly incidents handlers ─────────────────────────────────────────────

  private handleGetAnomalyIncidents = (req: Request, res: Response) => {
    const rawView = req.query.view;
    let view: AdminQueueView | undefined;

    if (rawView !== undefined) {
      if (rawView !== 'active' && rawView !== 'archived' && rawView !== 'all') {
        return res
          .status(400)
          .json({ error: 'view must be active, archived, or all.' });
      }
      view = rawView as AdminQueueView;
    }

    const statusRaw = req.query.status;
    const severityRaw = req.query.severity;
    const categoryRaw = req.query.category;
    const limitRaw = req.query.limit;
    const offsetRaw = req.query.offset;

    const status = isAnomalyStatus(statusRaw) ? statusRaw : undefined;
    const severity = isAnomalySeverity(severityRaw) ? severityRaw : undefined;
    const category = isAnomalyCategory(categoryRaw) ? categoryRaw : undefined;
    const limit = Number.isFinite(Number(limitRaw))
      ? Number(limitRaw)
      : undefined;
    const offset = Number.isFinite(Number(offsetRaw))
      ? Number(offsetRaw)
      : undefined;

    res.json(
      anomalyService.listIncidents({
        status,
        severity,
        category,
        view,
        limit,
        offset,
      }),
    );
  };

  private handleGetAnomalyIncidentById = (req: Request, res: Response) => {
    const incident = anomalyService.getIncidentById(req.params.id as string);
    if (!incident) {
      return res.status(404).json({ error: 'Anomaly incident not found.' });
    }
    res.json({ incident });
  };

  private handleUpdateAnomalyIncidentStatus = async (
    req: Request,
    res: Response,
  ) => {
    const status = req.body?.status;
    if (!isAnomalyStatus(status)) {
      return res.status(400).json({
        error: 'Valid status required: open | acknowledged | resolved',
      });
    }

    const incident = await anomalyService.updateIncidentStatus(
      req.params.id as string,
      status,
    );
    if (!incident) {
      return res.status(404).json({ error: 'Anomaly incident not found.' });
    }

    res.json({ ok: true, incident });
  };

  // ── Logs handlers ──────────────────────────────────────────────────────────

  private parseLogLimit(rawLimit: unknown, fallback = 200): number {
    const numericLimit = Number(rawLimit ?? fallback);
    return Number.isFinite(numericLimit)
      ? Math.max(1, Math.min(1000, Math.floor(numericLimit)))
      : fallback;
  }

  private parseTransactionLogFilters(req: Request): {
    filters?: TransactionLogFilters;
    error?: string;
  } {
    const transactionId =
      typeof req.query.transactionId === 'string'
        ? req.query.transactionId.trim()
        : '';
    const eventType =
      typeof req.query.eventType === 'string' ? req.query.eventType.trim() : '';

    let mode: TransactionLogMode | undefined;
    if (req.query.mode !== undefined && req.query.mode !== '') {
      if (!isTransactionLogMode(req.query.mode)) {
        return { error: 'mode must be one of: print, copy, scan.' };
      }
      mode = req.query.mode;
    }

    let status: TransactionLogStatus | undefined;
    if (req.query.status !== undefined && req.query.status !== '') {
      if (!isTransactionLogStatus(req.query.status)) {
        return {
          error:
            'status must be one of: created, processing, completed, failed, refund.',
        };
      }
      status = req.query.status;
    }

    const dateFrom = parseIsoTimestampQuery(req.query.dateFrom, 'dateFrom');
    if (dateFrom.error) return { error: dateFrom.error };

    const dateTo = parseIsoTimestampQuery(req.query.dateTo, 'dateTo');
    if (dateTo.error) return { error: dateTo.error };

    if (
      dateFrom.value &&
      dateTo.value &&
      Date.parse(dateFrom.value) > Date.parse(dateTo.value)
    ) {
      return { error: 'dateFrom must be earlier than or equal to dateTo.' };
    }

    const filters: TransactionLogFilters = {};
    if (transactionId) filters.transactionId = transactionId;
    if (mode) filters.mode = mode;
    if (status) filters.status = status;
    if (eventType) filters.eventType = eventType;
    if (dateFrom.value) filters.dateFrom = dateFrom.value;
    if (dateTo.value) filters.dateTo = dateTo.value;

    return { filters };
  }

  private handleGetSystemLogs = (req: Request, res: Response) => {
    const limit = this.parseLogLimit(req.query.limit, 200);
    res.json({ logs: this.adminService.listSystemLogs(limit) });
  };

  private handleGetTransactionLogs = (req: Request, res: Response) => {
    const parsed = this.parseTransactionLogFilters(req);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    const limit = this.parseLogLimit(req.query.limit, 200);
    res.json({
      logs: this.adminService.listTransactionLogs(limit, parsed.filters ?? {}),
    });
  };

  private handleGetTransactionById = (req: Request, res: Response) => {
    const transactionId = String(req.params.transactionId ?? '').trim();
    if (!transactionId) {
      return res.status(400).json({ error: 'transactionId is required.' });
    }

    const context = this.buildTransactionContextResponse(transactionId);
    if (!context) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    return res.json({
      transactionId: context.transactionId,
      mode: context.mode,
      chargedAmount: context.chargedAmount,
      settledAt: context.settledAt,
      spoolerPhase: context.settlement.spoolerPhase,
      reconciliationAction: context.settlement.reconciliationAction,
      spoolerLifecycle: context.spoolerLifecycle,
      pendingRefunds: context.pendingRefunds,
      ledgerEntries: context.ledgerEntries,
      relatedLogs: context.relatedLogs.slice(0, 30).map((entry) => ({
        id: entry.id,
        type: entry.type,
        message: entry.message,
        timestamp: entry.timestamp,
      })),
    });
  };

  private handleGetTransactionContextById = (req: Request, res: Response) => {
    const transactionId = String(req.params.transactionId ?? '').trim();
    if (!transactionId) {
      return res.status(400).json({ error: 'transactionId is required.' });
    }

    const context = this.buildTransactionContextResponse(transactionId);
    if (!context) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    return res.json(context);
  };

  private buildTransactionContextResponse(transactionId: string): {
    transactionId: string;
    mode: string | null;
    chargedAmount: number | null;
    colorPages: number | null;
    bwPages: number | null;
    status: string | null;
    change: {
      requested: number | null;
      dispensed: number | null;
      remaining: number | null;
      state: string | null;
      attempts: number | null;
      owedChangeId: string | null;
      message: string | null;
    };
    settledAt: string | null;
    terminalAt: string | null;
    generatedAt: string;
    receipt: {
      available: boolean;
      expired: boolean;
      source: 'snapshot' | 'derived';
    };
    contextFlags: {
      hasIncompleteContext: boolean;
      hasReceiptSnapshot: boolean;
      hasTransactionLogs: boolean;
      missingTransactionMeta: boolean;
      missingReasons: string[];
    };
    settlement: {
      spoolerPhase: string | null;
      reconciliationAction: string | null;
      pendingRefundCount: number;
      hasOutstandingReview: boolean;
      hint: string | null;
    };
    spoolerLifecycle: {
      currentState: string | null;
      queuedAt: string | null;
      processingAt: string | null;
      printedAt: string | null;
      failedAt: string | null;
      transitions: SpoolerLifecycleTransitionEntry[];
    } | null;
    pendingRefunds: Array<{
      id: string;
      status: string;
      chargedAmount: number;
      reason: string;
      closedAt: string | null;
    }>;
    ledgerEntries: Array<{
      id: string;
      eventType: string;
      amount: number;
      timestamp: string;
    }>;
    relatedLogs: Array<{
      id: string;
      type: string;
      message: string;
      timestamp: string;
      meta: LogMeta;
    }>;
  } | null {
    const logs = this.adminService.listAllTransactionLogs({ transactionId });
    const ledgerEntries = db.data!.financialLedger.filter(
      (entry) => entry.referenceId === transactionId,
    );
    const recoverySession =
      db.data!.recovery.sessions.find(
        (session) => session.id === transactionId,
      ) ?? null;
    const lifecycleRecord = getSpoolerLifecycleRecord(transactionId);
    const pendingRefunds = db.data!.pendingRefunds.filter((entry) => {
      const ref = entry.jobContext.transactionId;
      return typeof ref === 'string' && ref === transactionId;
    });

    const receiptResolution =
      this.receiptService.resolveByTransactionId(transactionId);
    const receiptPayload: ReceiptPayload | null =
      receiptResolution.status === 'ok' ? receiptResolution.payload : null;
    const receiptExpired = receiptResolution.status === 'expired';

    const found =
      logs.length > 0 ||
      ledgerEntries.length > 0 ||
      recoverySession !== null ||
      lifecycleRecord !== null ||
      pendingRefunds.length > 0 ||
      receiptResolution.status === 'ok' ||
      receiptResolution.status === 'expired';
    if (!found) return null;

    const chargedAmount =
      receiptPayload?.chargedAmount ??
      ledgerEntries.find((entry) => entry.eventType === 'job_completed')
        ?.amount ??
      recoverySession?.chargedAmount ??
      pendingRefunds[0]?.chargedAmount ??
      null;
    const mode =
      receiptPayload?.mode ??
      lifecycleRecord?.mode ??
      recoverySession?.mode ??
      (typeof logs[0]?.meta?.mode === 'string' ? logs[0].meta.mode : null) ??
      null;
    const status = this.deriveTransactionStatus(
      receiptPayload,
      recoverySession,
      lifecycleRecord,
      pendingRefunds,
      logs,
    );
    const settledAt =
      receiptPayload?.settledAt ??
      recoverySession?.settledAt ??
      logs.find((entry) => entry.type === 'payment_confirmed')?.timestamp ??
      null;
    const terminalAt =
      receiptPayload?.terminalAt ??
      recoverySession?.spoolerTerminalAt ??
      lifecycleRecord?.printedAt ??
      lifecycleRecord?.failedAt ??
      null;
    const generatedAt = receiptPayload?.generatedAt ?? new Date().toISOString();
    const pendingRefundCount = pendingRefunds.filter(
      (entry) => entry.status === 'open',
    ).length;
    const hasOutstandingReview =
      pendingRefundCount > 0 ||
      recoverySession?.reconciliationAction === 'pending_admin_review' ||
      status === 'refunded_pending_review';
    const hint =
      pendingRefundCount > 0
        ? 'Pending refund/reconciliation requires admin review.'
        : recoverySession?.reconciliationAction === 'pending_admin_review'
          ? 'Recovery marked this transaction for pending admin review.'
          : null;

    const missingReasons: string[] = [];
    if (!receiptPayload) {
      missingReasons.push(
        receiptExpired
          ? 'Receipt snapshot exists but is expired.'
          : 'Receipt snapshot not found.',
      );
    }
    if (logs.length === 0) missingReasons.push('No transaction logs found.');
    if (ledgerEntries.length === 0)
      missingReasons.push('No ledger entries found.');
    if (!recoverySession && !lifecycleRecord) {
      missingReasons.push('No spooler/recovery trace found.');
    }
    const missingTransactionMeta = logs.some(
      (entry) =>
        typeof entry.meta?.transactionId !== 'string' ||
        entry.meta.transactionId.trim().length === 0,
    );
    if (missingTransactionMeta) {
      missingReasons.push('Some logs are missing transactionId metadata.');
    }

    return {
      transactionId,
      mode,
      chargedAmount,
      colorPages: receiptPayload?.colorPages ?? null,
      bwPages: receiptPayload?.bwPages ?? null,
      status,
      change: receiptPayload
        ? {
            requested: receiptPayload.change.requested,
            dispensed: receiptPayload.change.dispensed,
            remaining: receiptPayload.change.remaining,
            state: receiptPayload.change.state,
            attempts: receiptPayload.change.attempts,
            owedChangeId: receiptPayload.change.owedChangeId,
            message: receiptPayload.change.message,
          }
        : {
            requested: null,
            dispensed: null,
            remaining: null,
            state: null,
            attempts: null,
            owedChangeId: null,
            message:
              hasOutstandingReview || pendingRefundCount > 0
                ? 'Transaction requires admin-side reconciliation review.'
                : null,
          },
      settledAt,
      terminalAt,
      generatedAt,
      receipt: {
        available: receiptPayload !== null,
        expired: receiptExpired,
        source: receiptPayload ? 'snapshot' : 'derived',
      },
      contextFlags: {
        hasIncompleteContext: missingReasons.length > 0,
        hasReceiptSnapshot: receiptPayload !== null,
        hasTransactionLogs: logs.length > 0,
        missingTransactionMeta,
        missingReasons,
      },
      settlement: {
        spoolerPhase:
          lifecycleRecord?.currentState ?? recoverySession?.phase ?? null,
        reconciliationAction: recoverySession?.reconciliationAction ?? null,
        pendingRefundCount,
        hasOutstandingReview,
        hint,
      },
      spoolerLifecycle: lifecycleRecord
        ? {
            currentState: lifecycleRecord.currentState,
            queuedAt: lifecycleRecord.queuedAt,
            processingAt: lifecycleRecord.processingAt,
            printedAt: lifecycleRecord.printedAt,
            failedAt: lifecycleRecord.failedAt,
            transitions: lifecycleRecord.transitions,
          }
        : null,
      pendingRefunds: pendingRefunds.map((entry) => ({
        id: entry.id,
        status: entry.status,
        chargedAmount: entry.chargedAmount,
        reason: entry.reason,
        closedAt: entry.closedAt,
      })),
      ledgerEntries: ledgerEntries.map((entry) => ({
        id: entry.id,
        eventType: entry.eventType,
        amount: entry.amount,
        timestamp: entry.timestamp,
      })),
      relatedLogs: logs.slice(0, 50).map((entry) => ({
        id: entry.id,
        type: entry.type,
        message: entry.message,
        timestamp: entry.timestamp,
        meta: entry.meta ?? {},
      })),
    };
  }

  private deriveTransactionStatus(
    receiptPayload: ReceiptPayload | null,
    recoverySession: RecoverySessionEntry | null,
    lifecycleRecord: ReturnType<typeof getSpoolerLifecycleRecord> | null,
    pendingRefunds: PendingRefundEntry[],
    logs: AdminLogEntry[],
  ): string | null {
    if (receiptPayload?.status) return receiptPayload.status;
    if (pendingRefunds.some((entry) => entry.status === 'open')) {
      return 'refunded_pending_review';
    }
    if (pendingRefunds.some((entry) => entry.status === 'refunded')) {
      return 'refunded';
    }
    const phase = recoverySession?.phase ?? lifecycleRecord?.currentState;
    if (phase === 'spooler_confirmed' || phase === 'printed') return 'printed';
    if (phase === 'spooler_failed' || phase === 'failed') return 'failed';
    if (
      phase === 'settled' ||
      phase === 'spooler_timeout' ||
      phase === 'job_dispatched' ||
      phase === 'processing'
    ) {
      return 'settled_pending_terminal';
    }
    const hasSuccessfulCompletionLog = logs.some((entry) => {
      const lowerType = entry.type.toLowerCase();
      return (
        lowerType.includes('completed') ||
        lowerType.includes('confirmed') ||
        lowerType.includes('charged')
      );
    });
    if (hasSuccessfulCompletionLog) return 'settled_pending_terminal';
    return null;
  }

  private handleExportSystemLogs = (_req: Request, res: Response) => {
    const csv = this.adminService.logsToCsv(
      this.adminService.listAllSystemLogs(),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="printbit-admin-system-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  };

  private handleExportTransactionLogs = (req: Request, res: Response) => {
    const parsed = this.parseTransactionLogFilters(req);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    const csv = this.adminService.logsToCsv(
      this.adminService.listAllTransactionLogs(parsed.filters ?? {}),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="printbit-admin-transaction-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  };

  private handleDeleteSystemLogs = (_req: Request, res: Response) => {
    const deleted = this.adminService.clearSystemLogs();
    res.json({ ok: true, deleted });
  };

  private handleDeleteTransactionLogs = (_req: Request, res: Response) => {
    const deleted = this.adminService.clearTransactionLogs();
    res.json({ ok: true, deleted });
  };

  // ── Balance and storage handlers ───────────────────────────────────────────

  private handleResetBalance = async (_req: Request, res: Response) => {
    const previousBalance = db.data!.balance;
    db.data!.balance = 0;
    await db.write();
    writeRuntimeState(db.data);
    this.deps.io.emit('balance', 0);
    await this.adminService.appendAdminLog(
      'admin_balance_reset',
      'Admin reset machine balance.',
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

  private handleResetInkCounters = async (_req: Request, res: Response) => {
    try {
      const sqlite = getSqliteDb();
      const totalRow = sqlite
        .prepare(
          `SELECT SUM(COALESCE(color_pages, 0)) AS colorSum, SUM(COALESCE(bw_pages, 0)) AS bwSum
           FROM receipt_records WHERE mode IN ('print','copy')`,
        )
        .get() as Record<string, unknown> | undefined;

      const adminTestPages = consumablesStore.sumUsagePagesBySource(
        ADMIN_TEST_PAGE_USAGE_SOURCE,
      );
      const totalColor =
        Number(totalRow?.colorSum ?? 0) + adminTestPages.colorPages;
      const totalBw = Number(totalRow?.bwSum ?? 0) + adminTestPages.bwPages;

      await this.adminService.resetInkRefillBaseline(totalColor, totalBw);

      res.json({
        ok: true,
        pageCounts: {
          totalColorPages: totalColor,
          totalBwPages: totalBw,
          refillColorPages: 0,
          refillBwPages: 0,
          lastRefillAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('[ADMIN] Failed to reset ink counters', error);
      res.status(500).json({ error: 'Failed to reset ink counters.' });
    }
  };

  private handleClearStorage = async (_req: Request, res: Response) => {
    const uploadDir = path.resolve(this.deps.uploadDir);
    if (!fs.existsSync(uploadDir)) {
      return res.json({ ok: true, removedFiles: 0 });
    }

    let removedFiles = 0;
    const entries = fs.readdirSync(uploadDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(uploadDir, entry.name);
      fs.unlinkSync(fullPath);
      removedFiles += 1;
    }

    await this.adminService.appendAdminLog(
      'admin_storage_cleared',
      'Admin cleared upload storage.',
      {
        removedFiles,
      },
    );
    res.json({ ok: true, removedFiles });
  };

  // ── Owed changes handlers ──────────────────────────────────────────────────

  private handleGetOwedChanges = (_req: Request, res: Response) => {
    const entries = db.data!.owedChanges ?? [];
    const open = entries.filter((e) => e.status === 'open');
    const resolved = entries.filter((e) => e.status === 'resolved');
    res.json({
      total: entries.length,
      openCount: open.length,
      resolvedCount: resolved.length,
      entries,
    });
  };

  private handleResolveOwedChange = async (req: Request, res: Response) => {
    const entryId = req.params.id as string;
    const entry = db.data!.owedChanges.find((e) => e.id === entryId);
    if (!entry) {
      return res.status(404).json({ error: 'Owed change entry not found.' });
    }
    if (entry.status === 'resolved') {
      return res.status(409).json({ error: 'Already resolved.' });
    }

    entry.status = 'resolved';
    await db.write();

    await this.adminService.appendAdminLog(
      'owed_change_resolved',
      `Owed change ₱${entry.amount} resolved by admin.`,
      { entryId, amount: entry.amount, reason: entry.reason },
    );

    res.json({ ok: true, entry });
  };

  private handleResolveAllOwedChanges = async (
    _req: Request,
    res: Response,
  ) => {
    let count = 0;
    for (const entry of db.data!.owedChanges) {
      if (entry.status === 'open') {
        entry.status = 'resolved';
        count += 1;
      }
    }
    await db.write();

    if (count > 0) {
      await this.adminService.appendAdminLog(
        'owed_changes_bulk_resolved',
        `Admin resolved ${count} owed change entries.`,
        { count },
      );
    }

    res.json({ ok: true, resolvedCount: count });
  };

  // ── Pending refunds handlers ───────────────────────────────────────────────

  private handleGetPendingRefunds = (req: Request, res: Response) => {
    const entries = db.data!.pendingRefunds ?? [];
    const statusFilter = req.query.status as string | undefined;

    const filtered =
      statusFilter === 'open' ||
      statusFilter === 'refunded' ||
      statusFilter === 'dismissed'
        ? entries.filter((e) => e.status === statusFilter)
        : entries;

    const open = entries.filter((e) => e.status === 'open');
    const refunded = entries.filter((e) => e.status === 'refunded');
    const dismissed = entries.filter((e) => e.status === 'dismissed');

    res.json({
      total: entries.length,
      openCount: open.length,
      refundedCount: refunded.length,
      dismissedCount: dismissed.length,
      entries: filtered,
    });
  };

  private handleProcessPendingRefund = async (req: Request, res: Response) => {
    const entryId = req.params.id as string;
    const restoreBalance =
      typeof req.body?.restoreBalance === 'boolean'
        ? req.body.restoreBalance
        : true;

    try {
      const result = await processPendingRefund({ entryId, restoreBalance });
      this.deps.io.emit('balance', result.balance);

      try {
        await this.adminService.appendAdminLog(
          'pending_refund_processed',
          `Pending refund ₱${result.entry.chargedAmount} processed by admin.`,
          {
            refundId: result.entry.id,
            chargedAmount: result.entry.chargedAmount,
            restoreBalance,
            newBalance: result.balance,
            reason: result.entry.reason,
          },
        );
      } catch (error) {
        console.error('[ADMIN] Failed to log pending refund processing', error);
      }

      res.json({
        ok: true,
        entry: result.entry,
        balance: result.balance,
        restoreBalance,
      });
    } catch (error) {
      if (error instanceof PendingRefundServiceError) {
        if (error.code === 'TRUSTED_TIME_UNAVAILABLE') {
          return res.status(error.statusCode).json({
            code: error.code,
            error: error.message,
            ...(error.context ?? {}),
          });
        }
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error('[ADMIN] Failed to process pending refund', error);
      return res.status(500).json({ error: 'Failed to process refund.' });
    }
  };

  private handleDismissPendingRefund = async (req: Request, res: Response) => {
    const entryId = req.params.id as string;
    try {
      const entry = await dismissPendingRefund(entryId);
      try {
        await this.adminService.appendAdminLog(
          'pending_refund_dismissed',
          `Pending refund ₱${entry.chargedAmount} dismissed by admin (no balance restored).`,
          {
            refundId: entry.id,
            chargedAmount: entry.chargedAmount,
            reason: entry.reason,
          },
        );
      } catch (error) {
        console.error('[ADMIN] Failed to log pending refund dismissal', error);
      }

      res.json({ ok: true, entry });
    } catch (error) {
      if (error instanceof PendingRefundServiceError) {
        if (error.code === 'TRUSTED_TIME_UNAVAILABLE') {
          return res.status(error.statusCode).json({
            code: error.code,
            error: error.message,
            ...(error.context ?? {}),
          });
        }
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error('[ADMIN] Failed to dismiss pending refund', error);
      return res.status(500).json({ error: 'Failed to dismiss refund.' });
    }
  };
}
