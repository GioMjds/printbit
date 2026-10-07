import { randomUUID } from 'node:crypto';
import { db, type PendingRefundEntry, withBalanceLock } from './db';
import { financialLedgerService } from './financial-ledger';
import {
  assertTrustedTimeForFinancialOperation,
  getTrustedTimestamp,
  isTrustedTimeError,
} from './time-source';

export class PendingRefundServiceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PendingRefundServiceError';
  }
}

function ensureDb(): void {
  if (!db.data) {
    throw new PendingRefundServiceError(
      500,
      'Database not initialized for refund operation.',
    );
  }
  db.data!.pendingRefunds = db.data!.pendingRefunds ?? [];
}

function normalizeJobContext(
  context: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [key, value ?? null]),
  ) as Record<string, string | number | boolean | null>;
}

function getContextString(
  context: Record<string, string | number | boolean | null>,
  key: string,
): string | null {
  const value = context[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function getContextNumber(
  context: Record<string, string | number | boolean | null>,
  key: string,
): number | null {
  const value = context[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function findDuplicateByCorrelation(
  context: Record<string, string | number | boolean | null>,
): PendingRefundEntry | null {
  ensureDb();
  const transactionId = getContextString(context, 'transactionId');
  const spoolerCorrelationKey = getContextString(
    context,
    'spoolerCorrelationKey',
  );
  const spoolerJobId = getContextNumber(context, 'spoolerJobId');

  if (transactionId) {
    const byTransaction = db.data!.pendingRefunds.find(
      (entry) => entry.jobContext.transactionId === transactionId,
    );
    if (byTransaction) return byTransaction;
  }

  if (spoolerCorrelationKey) {
    const bySpoolerKey = db.data!.pendingRefunds.find(
      (entry) =>
        entry.jobContext.spoolerCorrelationKey === spoolerCorrelationKey,
    );
    if (bySpoolerKey) return bySpoolerKey;
  }

  if (spoolerJobId !== null) {
    const bySpoolerJob = db.data!.pendingRefunds.find(
      (entry) => entry.jobContext.spoolerJobId === spoolerJobId,
    );
    if (bySpoolerJob) return bySpoolerJob;
  }

  return null;
}

export async function createPendingRefund(input: {
  chargedAmount: number;
  reason: string;
  jobContext: Record<string, string | number | boolean | null | undefined>;
  status?: PendingRefundEntry['status'];
  closedAt?: string | null;
}): Promise<PendingRefundEntry> {
  ensureDb();
  try {
    assertTrustedTimeForFinancialOperation('pending_refund:create');
  } catch (error) {
    if (isTrustedTimeError(error)) {
      throw new PendingRefundServiceError(
        error.statusCode,
        error.message,
        error.code,
        { trustedTime: error.trustedTime },
      );
    }
    throw error;
  }
  const trusted = getTrustedTimestamp();
  const entry: PendingRefundEntry = {
    id: randomUUID(),
    timestamp: trusted.timestamp,
    chargedAmount: input.chargedAmount,
    reason: input.reason,
    status: input.status ?? 'open',
    closedAt: input.closedAt ?? null,
    jobContext: normalizeJobContext(input.jobContext),
  };
  db.data!.pendingRefunds.unshift(entry);
  await db.write();
  return entry;
}

export async function upsertSpoolerFailureRefund(input: {
  chargedAmount: number;
  reason: string;
  jobContext: Record<string, string | number | boolean | null | undefined>;
  autoRefund: boolean;
}): Promise<{
  entry: PendingRefundEntry;
  created: boolean;
  autoRefunded: boolean;
  restoredBalanceAmount: number;
}> {
  ensureDb();
  const normalizedContext = normalizeJobContext(input.jobContext);
  const duplicate = findDuplicateByCorrelation(normalizedContext);
  if (duplicate) {
    const autoRefunded =
      duplicate.jobContext.refundDisposition === 'auto_refunded';
    const restoredBalanceAmount =
      autoRefunded &&
      typeof duplicate.jobContext.restoredBalanceAmount === 'number'
        ? duplicate.jobContext.restoredBalanceAmount
        : 0;

    return {
      entry: duplicate,
      created: false,
      autoRefunded,
      restoredBalanceAmount,
    };
  }

  try {
    assertTrustedTimeForFinancialOperation(
      'pending_refund:upsert_spooler_failure',
    );
  } catch (error) {
    if (isTrustedTimeError(error)) {
      throw new PendingRefundServiceError(
        error.statusCode,
        error.message,
        error.code,
        { trustedTime: error.trustedTime },
      );
    }
    throw error;
  }
  const createdTs = getTrustedTimestamp().timestamp;

  const autoRefunded = input.autoRefund;
  const contextWithDisposition: Record<
    string,
    string | number | boolean | null | undefined
  > = {
    ...normalizedContext,
    refundDisposition: autoRefunded ? 'auto_refunded' : 'pending_admin_review',
    restoredBalanceAmount: autoRefunded ? input.chargedAmount : 0,
  };
  const entry: PendingRefundEntry = {
    id: randomUUID(),
    timestamp: createdTs,
    chargedAmount: input.chargedAmount,
    reason: input.reason,
    status: autoRefunded ? 'refunded' : 'open',
    closedAt: autoRefunded ? createdTs : null,
    jobContext: normalizeJobContext(contextWithDisposition),
  };

  let restoredBalanceAmount = 0;
  if (autoRefunded) {
    await withBalanceLock(async () => {
      db.data!.balance += input.chargedAmount;
      db.data!.earnings = Math.max(0, db.data!.earnings - input.chargedAmount);
      restoredBalanceAmount = input.chargedAmount;
    });
    await financialLedgerService.append({
      eventType: 'refund_issued',
      amount: input.chargedAmount,
      referenceId: entry.id,
      meta: {
        source: 'auto_spooler_refund',
        reason: input.reason,
      },
    });
  }

  db.data!.pendingRefunds.unshift(entry);
  await db.write();

  return {
    entry,
    created: true,
    autoRefunded,
    restoredBalanceAmount,
  };
}

function findEntryById(entryId: string): PendingRefundEntry {
  ensureDb();
  const entry = db.data!.pendingRefunds.find((item) => item.id === entryId);
  if (!entry) {
    throw new PendingRefundServiceError(404, 'Pending refund not found.');
  }
  return entry;
}

export async function processPendingRefund(input: {
  entryId: string;
  restoreBalance: boolean;
}): Promise<{
  entry: PendingRefundEntry;
  balance: number;
  restoreBalance: boolean;
}> {
  ensureDb();
  try {
    assertTrustedTimeForFinancialOperation('pending_refund:process');
  } catch (error) {
    if (isTrustedTimeError(error)) {
      throw new PendingRefundServiceError(
        error.statusCode,
        error.message,
        error.code,
        { trustedTime: error.trustedTime },
      );
    }
    throw error;
  }
  const entry = findEntryById(input.entryId);
  if (entry.status !== 'open') {
    throw new PendingRefundServiceError(
      409,
      `Entry is already ${entry.status}.`,
    );
  }

  entry.status = 'refunded';
  entry.closedAt = getTrustedTimestamp().timestamp;

  const payoutType = input.restoreBalance ? 'balance' : 'cash';
  entry.payoutType = payoutType;
  entry.jobContext.payoutType = payoutType;
  entry.jobContext.refundedAmount = entry.chargedAmount;

  if (input.restoreBalance) {
    await withBalanceLock(async () => {
      db.data!.balance += entry.chargedAmount;
      db.data!.earnings = Math.max(0, db.data!.earnings - entry.chargedAmount);
    });
    await financialLedgerService.append({
      eventType: 'refund_issued',
      amount: entry.chargedAmount,
      referenceId: (entry.jobContext.transactionId as string) || entry.id,
      meta: {
        source: 'admin_pending_refund',
        reason: entry.reason,
        payoutType: 'balance',
      },
    });
  } else {
    await withBalanceLock(async () => {
      db.data!.earnings = Math.max(0, db.data!.earnings - entry.chargedAmount);
    });
    await financialLedgerService.append({
      eventType: 'refund_issued',
      amount: entry.chargedAmount,
      referenceId: (entry.jobContext.transactionId as string) || entry.id,
      meta: {
        source: 'admin_cash_refund',
        reason: entry.reason,
        payoutType: 'cash',
      },
    });
  }

  await db.write();
  return {
    entry,
    balance: db.data!.balance,
    restoreBalance: input.restoreBalance,
  };
}

export async function syncCashRefundPendingEntry(input: {
  transactionId: string;
  amount: number;
  reason: string;
  unprintedPages?: number | null;
  timestamp?: string;
}): Promise<PendingRefundEntry> {
  ensureDb();
  const now = input.timestamp ?? getTrustedTimestamp().timestamp;
  const existingOpen = db.data!.pendingRefunds.find(
    (e) =>
      e.jobContext.transactionId === input.transactionId && e.status === 'open',
  );

  if (existingOpen) {
    existingOpen.status = 'refunded';
    existingOpen.closedAt = now;
    existingOpen.payoutType = 'cash';
    existingOpen.jobContext.payoutType = 'cash';
    existingOpen.jobContext.refundedAmount = input.amount;
    if (input.unprintedPages !== undefined) {
      existingOpen.jobContext.unprintedPages = input.unprintedPages;
    }
    return existingOpen;
  }

  const entry: PendingRefundEntry = {
    id: randomUUID(),
    timestamp: now,
    chargedAmount: input.amount,
    reason: input.reason,
    status: 'refunded',
    closedAt: now,
    payoutType: 'cash',
    jobContext: {
      transactionId: input.transactionId,
      payoutType: 'cash',
      refundedAmount: input.amount,
      unprintedPages: input.unprintedPages ?? null,
    },
  };
  db.data!.pendingRefunds.unshift(entry);
  return entry;
}

export async function dismissPendingRefund(
  entryId: string,
): Promise<PendingRefundEntry> {
  ensureDb();
  try {
    assertTrustedTimeForFinancialOperation('pending_refund:dismiss');
  } catch (error) {
    if (isTrustedTimeError(error)) {
      throw new PendingRefundServiceError(
        error.statusCode,
        error.message,
        error.code,
        { trustedTime: error.trustedTime },
      );
    }
    throw error;
  }
  const entry = findEntryById(entryId);
  if (entry.status !== 'open') {
    throw new PendingRefundServiceError(
      409,
      `Entry is already ${entry.status}.`,
    );
  }

  entry.status = 'dismissed';
  entry.closedAt = getTrustedTimestamp().timestamp;
  await db.write();
  return entry;
}
