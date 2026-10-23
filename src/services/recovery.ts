import {
  db,
  type LogMeta,
  type RecoveryLifecycleState,
  type RecoveryReconciliationAction,
  type RecoverySessionEntry,
  type RecoverySessionPhase,
  type SpoolerLifecycleRecord,
  type SpoolerLifecycleState,
  type SpoolerLifecycleTransitionEntry,
} from './db';
import {
  PendingRefundServiceError,
  upsertSpoolerFailureRefund,
} from './pending-refund';
import { getTrustedTimestamp } from './time-source';

const MAX_RECOVERY_SESSIONS = 1000;
const MAX_SPOOLER_LIFECYCLE_RECORDS = 2000;
const MAX_SPOOLER_LIFECYCLE_TRANSITIONS = 32;

function nowIso(): string {
  return getTrustedTimestamp().timestamp;
}

function ensureRecoveryState(): void {
  if (!db.data) {
    throw new Error('Database is not initialized.');
  }
  if (!db.data.recovery) {
    db.data.recovery = {
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
    };
  }
}

function ensureSpoolerLifecycleState(): void {
  if (!db.data) {
    throw new Error('Database is not initialized.');
  }
  if (!Array.isArray(db.data.spoolerLifecycle)) {
    db.data.spoolerLifecycle = [];
  }
}

function sanitizeLogMeta(input: unknown): LogMeta {
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
}

function parseIsoMs(value: string | null): number {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function baseRecoveryEntry(input: {
  transactionId: string;
  mode: 'print' | 'copy';
  phase: RecoverySessionPhase;
  requiredAmount: number;
  sessionId?: string | null;
  documentId?: string | null;
  spoolerCorrelationKey?: string | null;
  context?: LogMeta;
}): RecoverySessionEntry {
  const timestamp = nowIso();
  return {
    id: input.transactionId,
    mode: input.mode,
    createdAt: timestamp,
    updatedAt: timestamp,
    phase: input.phase,
    requiredAmount: Number.isFinite(input.requiredAmount)
      ? Number(input.requiredAmount)
      : 0,
    chargedAmount: 0,
    sessionId: input.sessionId ?? null,
    documentId: input.documentId ?? null,
    spoolerCorrelationKey: input.spoolerCorrelationKey ?? null,
    spoolerJobId: null,
    jobDispatchedAt: null,
    settledAt: null,
    spoolerTerminalAt: null,
    reconciledAt: null,
    startupReconciled: false,
    reconciliationAction: 'none',
    reconciliationReason: null,
    lastError: null,
    wasPresentAtStartup: false,
    context: sanitizeLogMeta(input.context),
  };
}

function trimRecoverySessions(): void {
  const sessions = db.data!.recovery.sessions;
  if (sessions.length <= MAX_RECOVERY_SESSIONS) return;
  sessions.sort((a, b) => {
    const aMs = parseIsoMs(a.updatedAt);
    const bMs = parseIsoMs(b.updatedAt);
    const aValid = Number.isFinite(aMs);
    const bValid = Number.isFinite(bMs);
    if (aValid && bValid) return bMs - aMs;
    if (aValid) return -1;
    if (bValid) return 1;
    return 0;
  });
  db.data!.recovery.sessions = sessions.slice(0, MAX_RECOVERY_SESSIONS);
}

export interface RecoveryCheckpointInput {
  transactionId: string;
  mode: 'print' | 'copy';
  phase: RecoverySessionPhase;
  requiredAmount: number;
  chargedAmount?: number;
  sessionId?: string | null;
  documentId?: string | null;
  spoolerCorrelationKey?: string | null;
  spoolerJobId?: number | null;
  jobDispatchedAt?: string | null;
  settledAt?: string | null;
  spoolerTerminalAt?: string | null;
  reconciledAt?: string | null;
  startupReconciled?: boolean;
  reconciliationAction?: RecoveryReconciliationAction;
  reconciliationReason?: string | null;
  lastError?: string | null;
  context?: LogMeta;
}

export async function checkpointRecoverySession(
  input: RecoveryCheckpointInput,
): Promise<RecoverySessionEntry> {
  ensureRecoveryState();
  const sessions = db.data!.recovery.sessions;
  const existing = sessions.find((entry) => entry.id === input.transactionId);
  const entry =
    existing ??
    baseRecoveryEntry({
      transactionId: input.transactionId,
      mode: input.mode,
      phase: input.phase,
      requiredAmount: input.requiredAmount,
      sessionId: input.sessionId,
      documentId: input.documentId,
      spoolerCorrelationKey: input.spoolerCorrelationKey,
      context: input.context,
    });

  const updatedAt = nowIso();
  entry.mode = input.mode;
  entry.phase = input.phase;
  entry.updatedAt = updatedAt;
  entry.requiredAmount = Number.isFinite(input.requiredAmount)
    ? Number(input.requiredAmount)
    : entry.requiredAmount;

  if (
    input.chargedAmount !== undefined &&
    Number.isFinite(input.chargedAmount)
  ) {
    entry.chargedAmount = Number(input.chargedAmount);
  }
  if (input.sessionId !== undefined) entry.sessionId = input.sessionId;
  if (input.documentId !== undefined) entry.documentId = input.documentId;
  if (input.spoolerCorrelationKey !== undefined) {
    entry.spoolerCorrelationKey = input.spoolerCorrelationKey;
  }
  if (input.spoolerJobId !== undefined) {
    entry.spoolerJobId =
      typeof input.spoolerJobId === 'number' &&
      Number.isFinite(input.spoolerJobId)
        ? Math.floor(input.spoolerJobId)
        : null;
  }
  if (input.jobDispatchedAt !== undefined) {
    entry.jobDispatchedAt = input.jobDispatchedAt;
  }
  if (input.settledAt !== undefined) entry.settledAt = input.settledAt;
  if (input.spoolerTerminalAt !== undefined) {
    entry.spoolerTerminalAt = input.spoolerTerminalAt;
  }
  if (input.reconciledAt !== undefined) entry.reconciledAt = input.reconciledAt;
  if (input.startupReconciled !== undefined) {
    entry.startupReconciled = input.startupReconciled;
  }
  if (input.reconciliationAction !== undefined) {
    entry.reconciliationAction = input.reconciliationAction;
  }
  if (input.reconciliationReason !== undefined) {
    entry.reconciliationReason = input.reconciliationReason;
  }
  if (input.lastError !== undefined) entry.lastError = input.lastError;
  if (input.context !== undefined) {
    entry.context = {
      ...entry.context,
      ...sanitizeLogMeta(input.context),
    };
  }

  if (!existing) {
    sessions.unshift(entry);
  }
  trimRecoverySessions();
  await db.write();
  return entry;
}

export function getRecoverySession(
  transactionId: string,
): RecoverySessionEntry | null {
  ensureRecoveryState();
  const match = db.data!.recovery.sessions.find(
    (entry) => entry.id === transactionId,
  );
  return match ? structuredClone(match) : null;
}

export interface RecordSpoolerLifecycleTransitionInput {
  transactionId: string;
  mode: 'print' | 'copy';
  state: SpoolerLifecycleState;
  requiredAmount?: number;
  sessionId?: string | null;
  documentId?: string | null;
  spoolerCorrelationKey?: string | null;
  spoolerJobId?: number | null;
  printerName?: string | null;
  reason?: string | null;
  jobStatus?: string | null;
  pagesPrinted?: number | null;
  totalPages?: number | null;
  timestamp?: string;
  meta?: LogMeta;
}

function mergeSpoolerTransition(
  transitions: SpoolerLifecycleTransitionEntry[],
  next: SpoolerLifecycleTransitionEntry,
): SpoolerLifecycleTransitionEntry[] {
  if (transitions.length === 0) {
    return [next];
  }
  const previous = transitions[transitions.length - 1];
  if (previous.state !== next.state) {
    const updated = [...transitions, next];
    return updated.length > MAX_SPOOLER_LIFECYCLE_TRANSITIONS
      ? updated.slice(updated.length - MAX_SPOOLER_LIFECYCLE_TRANSITIONS)
      : updated;
  }
  const merged = [...transitions];
  merged[merged.length - 1] = next;
  return merged;
}

export async function recordSpoolerLifecycleTransition(
  input: RecordSpoolerLifecycleTransitionInput,
): Promise<SpoolerLifecycleRecord> {
  ensureSpoolerLifecycleState();
  const lifecycle = db.data!.spoolerLifecycle;
  const existing = lifecycle.find(
    (entry) =>
      entry.transactionId === input.transactionId && entry.mode === input.mode,
  );
  const entry =
    existing ??
    baseSpoolerLifecycleRecord({
      transactionId: input.transactionId,
      mode: input.mode,
      requiredAmount: input.requiredAmount,
      sessionId: input.sessionId,
      documentId: input.documentId,
      spoolerCorrelationKey: input.spoolerCorrelationKey,
    });

  const timestamp = input.timestamp ?? nowIso();
  const requiredAmount = coerceFiniteNumber(input.requiredAmount);
  const spoolerJobId = coerceFiniteInteger(input.spoolerJobId);
  const pagesPrinted = coerceFiniteNumber(input.pagesPrinted);
  const totalPages = coerceFiniteNumber(input.totalPages);
  const transition: SpoolerLifecycleTransitionEntry = {
    state: input.state,
    timestamp,
    reason: typeof input.reason === 'string' ? input.reason : null,
    printerName:
      typeof input.printerName === 'string' ? input.printerName : null,
    spoolerCorrelationKey:
      typeof input.spoolerCorrelationKey === 'string'
        ? input.spoolerCorrelationKey
        : null,
    spoolerJobId,
    jobStatus: typeof input.jobStatus === 'string' ? input.jobStatus : null,
    pagesPrinted,
    totalPages,
    meta: sanitizeLogMeta(input.meta),
  };

  entry.mode = input.mode;
  entry.updatedAt = timestamp;
  if (requiredAmount !== null) {
    entry.requiredAmount = Math.max(0, requiredAmount);
  }
  if (input.sessionId !== undefined) {
    entry.sessionId =
      typeof input.sessionId === 'string' ? input.sessionId : null;
  }
  if (input.documentId !== undefined) {
    entry.documentId =
      typeof input.documentId === 'string' ? input.documentId : null;
  }
  if (input.spoolerCorrelationKey !== undefined) {
    entry.spoolerCorrelationKey =
      typeof input.spoolerCorrelationKey === 'string'
        ? input.spoolerCorrelationKey
        : null;
  }
  if (input.spoolerJobId !== undefined) {
    entry.spoolerJobId = spoolerJobId;
  }
  if (input.printerName !== undefined) {
    entry.printerName =
      typeof input.printerName === 'string' ? input.printerName : null;
  }
  if (input.reason !== undefined) {
    entry.reason = typeof input.reason === 'string' ? input.reason : null;
  }
  if (input.jobStatus !== undefined) {
    entry.jobStatus =
      typeof input.jobStatus === 'string' ? input.jobStatus : null;
  }
  if (input.pagesPrinted !== undefined) {
    entry.pagesPrinted = pagesPrinted;
  }
  if (input.totalPages !== undefined) {
    entry.totalPages = totalPages;
  }

  entry.currentState = input.state;
  if (input.state === 'queued' && entry.queuedAt === null) {
    entry.queuedAt = timestamp;
  }
  if (input.state === 'processing' && entry.processingAt === null) {
    entry.processingAt = timestamp;
  }
  if (input.state === 'paused' && entry.pausedAt === null) {
    entry.pausedAt = timestamp;
  }
  if (input.state === 'printed' && entry.printedAt === null) {
    entry.printedAt = timestamp;
  }
  if (input.state === 'failed' && entry.failedAt === null) {
    entry.failedAt = timestamp;
  }

  entry.transitions = mergeSpoolerTransition(entry.transitions, transition);

  if (!existing) {
    lifecycle.unshift(entry);
  }
  trimSpoolerLifecycleRecords();
  await db.write();
  return entry;
}

export function getSpoolerLifecycleRecord(
  transactionId: string,
  mode?: 'print' | 'copy',
): SpoolerLifecycleRecord | null {
  ensureSpoolerLifecycleState();
  const match = db.data!.spoolerLifecycle.find(
    (entry) =>
      entry.transactionId === transactionId &&
      (mode ? entry.mode === mode : true),
  );
  return match ? structuredClone(match) : null;
}

export interface RecoveryLifecycleStartupResult {
  unexpectedRestart: boolean;
  lifecycle: RecoveryLifecycleState;
}

export async function markRecoveryStartup(
  reason = 'process_start',
): Promise<RecoveryLifecycleStartupResult> {
  ensureRecoveryState();
  const lifecycle = db.data!.recovery.lifecycle;
  const now = nowIso();

  const previousStartupMs = parseIsoMs(lifecycle.lastStartupAt);
  const previousShutdownMs = parseIsoMs(lifecycle.lastShutdownAt);
  const hasPreviousStartup = Number.isFinite(previousStartupMs);
  const shutdownAfterStartup =
    Number.isFinite(previousShutdownMs) &&
    Number.isFinite(previousStartupMs) &&
    previousShutdownMs >= previousStartupMs;
  const unexpectedRestart = hasPreviousStartup && !shutdownAfterStartup;

  lifecycle.bootCount = Math.max(0, lifecycle.bootCount) + 1;
  if (unexpectedRestart) {
    lifecycle.unexpectedRestartCount =
      Math.max(0, lifecycle.unexpectedRestartCount) + 1;
    lifecycle.lastUnexpectedRestartAt = now;
  }
  lifecycle.lastStartupAt = now;
  lifecycle.lastStartupPid = process.pid;
  lifecycle.lastStartupReason = reason;

  await db.write();
  return {
    unexpectedRestart,
    lifecycle: { ...lifecycle },
  };
}

export async function markRecoveryShutdown(
  signal: NodeJS.Signals | string = 'SIGTERM',
): Promise<void> {
  ensureRecoveryState();
  const lifecycle = db.data!.recovery.lifecycle;
  lifecycle.lastShutdownAt = nowIso();
  lifecycle.lastShutdownPid = process.pid;
  lifecycle.lastShutdownSignal = signal;
  await db.write();
}

export interface StartupRecoveryResult {
  processedSessions: number;
  resolvedSessions: number;
  unresolvedSessions: number;
  voidedSessions: number;
  autoRefundedSessions: number;
  pendingAdminReviewSessions: number;
  trustedTimeBlockedSessions: number;
  errors: number;
}

function shouldAutoRefundSpoolerFailure(
  entry: RecoverySessionEntry,
): boolean | null {
  const pagesPrinted = entry.context.pagesPrinted;
  if (typeof pagesPrinted === 'number' && Number.isFinite(pagesPrinted)) {
    return pagesPrinted === 0;
  }
  return null;
}

export async function reconcileRecoverySessionsOnStartup(): Promise<StartupRecoveryResult> {
  ensureRecoveryState();
  const sessions = db.data!.recovery.sessions;
  const now = nowIso();
  const result: StartupRecoveryResult = {
    processedSessions: 0,
    resolvedSessions: 0,
    unresolvedSessions: 0,
    voidedSessions: 0,
    autoRefundedSessions: 0,
    pendingAdminReviewSessions: 0,
    trustedTimeBlockedSessions: 0,
    errors: 0,
  };

  // Mark all existing sessions as present at startup
  for (const entry of sessions) {
    if (entry.wasPresentAtStartup === undefined) {
      entry.wasPresentAtStartup = true;
    }
  }

  for (const entry of sessions) {
    if (entry.phase === 'reconciled') continue;
    result.processedSessions += 1;

    if (
      entry.phase === 'initiated' ||
      entry.phase === 'preflight_passed' ||
      entry.phase === 'job_dispatched'
    ) {
      await checkpointRecoverySession({
        transactionId: entry.id,
        mode: entry.mode,
        phase: 'reconciled',
        requiredAmount: entry.requiredAmount,
        chargedAmount: entry.chargedAmount,
        sessionId: entry.sessionId,
        documentId: entry.documentId,
        spoolerCorrelationKey: entry.spoolerCorrelationKey,
        spoolerJobId: entry.spoolerJobId,
        jobDispatchedAt: entry.jobDispatchedAt,
        settledAt: entry.settledAt,
        spoolerTerminalAt: entry.spoolerTerminalAt,
        reconciledAt: now,
        startupReconciled: true,
        reconciliationAction: 'void',
        reconciliationReason:
          'Startup reconciliation voided a pre-settlement transaction.',
      });
      result.voidedSessions += 1;
      result.resolvedSessions += 1;
      continue;
    }

    if (entry.phase === 'spooler_confirmed') {
      await checkpointRecoverySession({
        transactionId: entry.id,
        mode: entry.mode,
        phase: 'reconciled',
        requiredAmount: entry.requiredAmount,
        chargedAmount: entry.chargedAmount,
        sessionId: entry.sessionId,
        documentId: entry.documentId,
        spoolerCorrelationKey: entry.spoolerCorrelationKey,
        spoolerJobId: entry.spoolerJobId,
        jobDispatchedAt: entry.jobDispatchedAt,
        settledAt: entry.settledAt,
        spoolerTerminalAt: entry.spoolerTerminalAt ?? now,
        reconciledAt: now,
        startupReconciled: true,
        reconciliationAction: 'none',
        reconciliationReason:
          'Startup reconciliation finalized a successful spooler session.',
      });
      result.resolvedSessions += 1;
      continue;
    }

    if (entry.mode === 'copy' && entry.phase === 'settled') {
      await checkpointRecoverySession({
        transactionId: entry.id,
        mode: entry.mode,
        phase: 'reconciled',
        requiredAmount: entry.requiredAmount,
        chargedAmount: entry.chargedAmount,
        sessionId: entry.sessionId,
        documentId: entry.documentId,
        spoolerCorrelationKey: entry.spoolerCorrelationKey,
        spoolerJobId: entry.spoolerJobId,
        jobDispatchedAt: entry.jobDispatchedAt,
        settledAt: entry.settledAt ?? now,
        reconciledAt: now,
        startupReconciled: true,
        reconciliationAction: 'none',
        reconciliationReason:
          'Startup reconciliation finalized settled copy transaction.',
      });
      result.resolvedSessions += 1;
      continue;
    }

    if (
      entry.mode === 'print' &&
      (entry.phase === 'settled' ||
        entry.phase === 'spooler_timeout' ||
        entry.phase === 'spooler_failed')
    ) {
      const chargedAmount =
        entry.chargedAmount > 0 ? entry.chargedAmount : entry.requiredAmount;
      const autoRefundPreference =
        entry.phase === 'spooler_failed'
          ? (shouldAutoRefundSpoolerFailure(entry) ?? false)
          : true;
      const reason =
        entry.phase === 'spooler_failed'
          ? 'Startup reconciliation of spooler failure after crash/restart.'
          : 'Startup reconciliation auto-refund for settled print with unknown spooler outcome.';

      try {
        const refundOutcome = await upsertSpoolerFailureRefund({
          chargedAmount,
          reason,
          autoRefund: autoRefundPreference,
          jobContext: {
            transactionId: entry.id,
            sessionId: entry.sessionId,
            documentId: entry.documentId,
            spoolerCorrelationKey: entry.spoolerCorrelationKey,
            spoolerJobId: entry.spoolerJobId,
            recoveryPhase: entry.phase,
            startupReconciliation: true,
          },
        });

        // Checkpoint the refund marker immediately after creation to ensure durability
        await checkpointRecoverySession({
          transactionId: entry.id,
          mode: entry.mode,
          phase: entry.phase,
          requiredAmount: entry.requiredAmount,
          chargedAmount: chargedAmount,
          sessionId: entry.sessionId,
          documentId: entry.documentId,
          spoolerCorrelationKey: entry.spoolerCorrelationKey,
          spoolerJobId: entry.spoolerJobId,
          jobDispatchedAt: entry.jobDispatchedAt,
          settledAt: entry.settledAt,
          spoolerTerminalAt: entry.spoolerTerminalAt,
          context: {
            refundId: refundOutcome.entry.id,
            refundCreated: refundOutcome.created,
            refundAttemptedAt: now,
          },
        });

        const action: RecoveryReconciliationAction = refundOutcome.autoRefunded
          ? 'auto_refund'
          : 'pending_admin_review';

        await checkpointRecoverySession({
          transactionId: entry.id,
          mode: entry.mode,
          phase: 'reconciled',
          requiredAmount: entry.requiredAmount,
          chargedAmount: chargedAmount,
          sessionId: entry.sessionId,
          documentId: entry.documentId,
          spoolerCorrelationKey: entry.spoolerCorrelationKey,
          spoolerJobId: entry.spoolerJobId,
          jobDispatchedAt: entry.jobDispatchedAt,
          settledAt: entry.settledAt ?? now,
          spoolerTerminalAt: entry.spoolerTerminalAt ?? now,
          reconciledAt: now,
          startupReconciled: true,
          reconciliationAction: action,
          reconciliationReason: reason,
          context: {
            refundId: refundOutcome.entry.id,
            refundCreated: refundOutcome.created,
            restoredBalanceAmount: refundOutcome.restoredBalanceAmount,
          },
        });

        if (action === 'auto_refund') {
          result.autoRefundedSessions += 1;
        } else {
          result.pendingAdminReviewSessions += 1;
        }
        result.resolvedSessions += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const trustedTimeBlocked =
          error instanceof PendingRefundServiceError &&
          error.code === 'TRUSTED_TIME_UNAVAILABLE';
        if (trustedTimeBlocked) {
          result.trustedTimeBlockedSessions += 1;
        } else {
          result.errors += 1;
        }
        result.unresolvedSessions += 1;
        await checkpointRecoverySession({
          transactionId: entry.id,
          mode: entry.mode,
          phase: entry.phase,
          requiredAmount: entry.requiredAmount,
          chargedAmount: entry.chargedAmount,
          sessionId: entry.sessionId,
          documentId: entry.documentId,
          spoolerCorrelationKey: entry.spoolerCorrelationKey,
          spoolerJobId: entry.spoolerJobId,
          jobDispatchedAt: entry.jobDispatchedAt,
          settledAt: entry.settledAt,
          spoolerTerminalAt: entry.spoolerTerminalAt,
          startupReconciled: false,
          lastError: message,
          context: {
            startupReconciliationFailed: true,
            trustedTimeBlocked,
          },
        });
      }
      continue;
    }

    result.unresolvedSessions += 1;
    await checkpointRecoverySession({
      transactionId: entry.id,
      mode: entry.mode,
      phase: entry.phase,
      requiredAmount: entry.requiredAmount,
      chargedAmount: entry.chargedAmount,
      sessionId: entry.sessionId,
      documentId: entry.documentId,
      spoolerCorrelationKey: entry.spoolerCorrelationKey,
      spoolerJobId: entry.spoolerJobId,
      jobDispatchedAt: entry.jobDispatchedAt,
      settledAt: entry.settledAt,
      spoolerTerminalAt: entry.spoolerTerminalAt,
      startupReconciled: false,
      lastError: `Unhandled startup recovery phase: ${entry.phase}`,
      context: {
        startupReconciliationUnhandled: true,
      },
    });
  }

  return result;
}

export interface RecoveryStatusSnapshot {
  lifecycle: RecoveryLifecycleState;
  sessionStats: {
    total: number;
    inFlight: number;
    reconciled: number;
    startupPending: number;
    autoRefunded: number;
    pendingAdminReview: number;
    voided: number;
  };
}

export function getRecoveryStatusSnapshot(): RecoveryStatusSnapshot {
  ensureRecoveryState();
  const sessions = db.data!.recovery.sessions;
  const inFlight = sessions.filter(
    (entry) => entry.phase !== 'reconciled',
  ).length;
  const reconciled = sessions.length - inFlight;
  const startupPending = sessions.filter(
    (entry) =>
      entry.phase !== 'reconciled' &&
      !entry.startupReconciled &&
      entry.wasPresentAtStartup === true,
  ).length;
  const autoRefunded = sessions.filter(
    (entry) => entry.reconciliationAction === 'auto_refund',
  ).length;
  const pendingAdminReview = sessions.filter(
    (entry) => entry.reconciliationAction === 'pending_admin_review',
  ).length;
  const voided = sessions.filter(
    (entry) => entry.reconciliationAction === 'void',
  ).length;

  return {
    lifecycle: { ...db.data!.recovery.lifecycle },
    sessionStats: {
      total: sessions.length,
      inFlight,
      reconciled,
      startupPending,
      autoRefunded,
      pendingAdminReview,
      voided,
    },
  };
}

export async function reconcileFinalizedCopySession(
  transactionId: string,
): Promise<void> {
  ensureRecoveryState();
  const existing = db.data!.recovery.sessions.find(
    (entry) => entry.id === transactionId,
  );
  if (!existing) return;
  await checkpointRecoverySession({
    transactionId: existing.id,
    mode: existing.mode,
    phase: 'reconciled',
    requiredAmount: existing.requiredAmount,
    chargedAmount: existing.chargedAmount,
    sessionId: existing.sessionId,
    documentId: existing.documentId,
    spoolerCorrelationKey: existing.spoolerCorrelationKey,
    spoolerJobId: existing.spoolerJobId,
    jobDispatchedAt: existing.jobDispatchedAt,
    settledAt: existing.settledAt,
    spoolerTerminalAt: existing.spoolerTerminalAt,
    reconciledAt: nowIso(),
    startupReconciled: false,
    reconciliationAction: 'none',
    reconciliationReason:
      'Copy transaction finalized without spooler follow-up.',
    context: {
      finalizedWithoutSpooler: true,
    },
  });
}

function coerceFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function coerceFiniteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

function baseSpoolerLifecycleRecord(input: {
  transactionId: string;
  mode: 'print' | 'copy';
  requiredAmount?: number;
  sessionId?: string | null;
  documentId?: string | null;
  spoolerCorrelationKey?: string | null;
}): SpoolerLifecycleRecord {
  const timestamp = nowIso();
  return {
    transactionId: input.transactionId,
    mode: input.mode,
    createdAt: timestamp,
    updatedAt: timestamp,
    currentState: null,
    queuedAt: null,
    processingAt: null,
    pausedAt: null,
    printedAt: null,
    failedAt: null,
    sessionId: input.sessionId ?? null,
    documentId: input.documentId ?? null,
    requiredAmount:
      typeof input.requiredAmount === 'number' &&
      Number.isFinite(input.requiredAmount)
        ? Number(input.requiredAmount)
        : 0,
    spoolerCorrelationKey: input.spoolerCorrelationKey ?? null,
    spoolerJobId: null,
    printerName: null,
    reason: null,
    jobStatus: null,
    pagesPrinted: null,
    totalPages: null,
    transitions: [],
  };
}

function trimSpoolerLifecycleRecords(): void {
  const records = db.data!.spoolerLifecycle;
  if (records.length <= MAX_SPOOLER_LIFECYCLE_RECORDS) return;
  records.sort((a, b) => {
    const aMs = parseIsoMs(a.updatedAt);
    const bMs = parseIsoMs(b.updatedAt);
    const aValid = Number.isFinite(aMs);
    const bValid = Number.isFinite(bMs);
    if (aValid && bValid) return bMs - aMs;
    if (aValid) return -1;
    if (bValid) return 1;
    return 0;
  });
  db.data!.spoolerLifecycle = records.slice(0, MAX_SPOOLER_LIFECYCLE_RECORDS);
}
