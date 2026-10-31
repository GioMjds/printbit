import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as SocketIOServer } from 'socket.io';
import type { SessionStore } from '@/services/session';
import {
  getPrinterStatusViaEdge,
  type EdgePrinterStatus,
} from '@/services/printer-state-projection';
import {
  getRecoverySession,
  checkpointRecoverySession,
} from '@/services/recovery';
import { withBalanceLock, db } from '@/core/database/db';
import { financialLedgerService } from '@/services/financial-ledger';
import { ReceiptService } from '@/modules/receipt/receipt.service';
import { deleteTransientScanFile } from '@/services/transient-scan-file';
import { persistAndEmitPrintLifecycleState } from '@/services/print-lifecycle-state';
import {
  getPrinterTelemetry,
  refreshPrinterTelemetry,
} from '@/services/printer-state-projection';
import { recordSpoolerLifecycleTransition } from '@/services/recovery';
import { BLOCKED_STATUSES } from '@/utils';
import { computeResubmitPlan, type ResubmitPlan } from './resubmit-plan';
import { printerErrorStateManager } from '@/services/printer-error-state';

// Re-export so that `printer.service.ts` remains the canonical public
// surface of this module — callers should not need to know about
// `resubmit-plan.ts` directly.
export { computeResubmitPlan, type ResubmitPlan };

const execFileAsync = promisify(execFile);

function parseIsoMs(value: string | null): number {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

async function findSpoolerJobIdByCorrelationKey(
  printerName: string,
  spoolerCorrelationKey: string,
): Promise<number | null> {
  if (
    typeof printerName !== 'string' ||
    printerName.length > 255 ||
    !/^[a-zA-Z0-9-_\s\\.:()]+$/.test(printerName)
  ) {
    throw new Error('Invalid printerName format');
  }
  if (
    typeof spoolerCorrelationKey !== 'string' ||
    spoolerCorrelationKey.length > 255 ||
    !/^[a-zA-Z0-9-_]+$/.test(spoolerCorrelationKey)
  ) {
    throw new Error('Invalid spoolerCorrelationKey');
  }
  try {
    const escapedPrinter = printerName.replace(/'/g, "''").replace(/`/g, '``');
    const escapedCorrelation = spoolerCorrelationKey
      .replace(/'/g, "''")
      .replace(/`/g, '``');
    const script = `Get-PrintJob -PrinterName '${escapedPrinter}' -ErrorAction SilentlyContinue | Where-Object { $_.Document -like '*${escapedCorrelation}*' } | Select-Object -ExpandProperty Id`;

    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10000 },
    );

    const jobIdStr = stdout.trim();
    if (jobIdStr) {
      const lines = jobIdStr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        const id = parseInt(line, 10);
        if (Number.isInteger(id)) {
          return id;
        }
      }
    }
  } catch (error) {
    console.error(
      `[PRINTER-SERVICE] Failed to query spooler job ID via PowerShell:`,
      error,
    );
  }
  return null;
}

export interface PrinterStatusResponse {
  ready: boolean;
  blocked: boolean;
  connected: boolean;
  status: string;
  statusFlags: string[];
  printerName: string | null;
  inkDetectionMethod: string | null;
  inkTelemetryAvailable: boolean;
  inkTelemetryReason: string | null;
  lastCheckedAt: string | null;
}

export interface PrintError {
  code: string;
  severity: 'warning' | 'recoverable' | 'fatal';
  userMessage: string;
  hint?: string;
  timestamp: string;
  canRetry?: boolean;
  canDismiss?: boolean;
}

export class PrinterService {
  constructor(
    private readonly io?: SocketIOServer,
    private readonly sessionStore?: SessionStore,
  ) {}

  getActiveError(): {
    activeError: ReturnType<typeof printerErrorStateManager.getActiveError>;
    outOfService: boolean;
  } {
    return {
      activeError: printerErrorStateManager.getActiveError(),
      outOfService: printerErrorStateManager.isKioskOutOfService(),
    };
  }

  async getStatusResponse(): Promise<PrinterStatusResponse> {
    let telemetry = getPrinterTelemetry();
    if (
      telemetry.status === 'Checking…' ||
      telemetry.status === 'Checking...' ||
      !telemetry.lastCheckedAt
    ) {
      try {
        telemetry = await refreshPrinterTelemetry();
      } catch {
        telemetry = getPrinterTelemetry();
      }
    }
    const blocked =
      !telemetry.connected || BLOCKED_STATUSES.has(telemetry.status);

    return {
      ready: !blocked,
      blocked,
      connected: telemetry.connected,
      status: telemetry.status,
      statusFlags: telemetry.statusFlags,
      printerName: telemetry.name,
      inkDetectionMethod: telemetry.inkDetectionMethod,
      inkTelemetryAvailable: telemetry.inkTelemetryAvailable ?? false,
      inkTelemetryReason: telemetry.inkTelemetryReason ?? null,
      lastCheckedAt: telemetry.lastCheckedAt,
    };
  }

  async preDispatchCheck(
    printerName: string | null,
  ): Promise<PrintError | null> {
    if (printerName !== null) {
      if (
        typeof printerName !== 'string' ||
        printerName.length > 255 ||
        !/^[a-zA-Z0-9-_\s\\.:()]+$/.test(printerName)
      ) {
        return {
          code: 'INVALID_PRINTER_NAME',
          severity: 'fatal',
          userMessage: 'Invalid printer name format.',
          timestamp: new Date().toISOString(),
        };
      }
    }

    const targetPrinter = printerName?.trim() || getPrinterTelemetry().name;
    if (!targetPrinter) {
      return {
        code: 'PRINTER_NOT_FOUND',
        severity: 'fatal',
        userMessage: 'Printer not found or not configured.',
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const edgeStatus = await getPrinterStatusViaEdge(targetPrinter);
      if ('error' in edgeStatus) {
        console.warn(
          `[PRINTER] Edge preflight query returned error, falling back to local cache: ${edgeStatus.error}`,
        );
      } else {
        const err = this.mapEdgeStatusToPrintError(edgeStatus);
        if (err) return err;
      }
    } catch (error) {
      console.warn(
        `[PRINTER] Edge preflight query failed, fallback to local cache:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    const telemetry = getPrinterTelemetry();
    if (!telemetry.connected) {
      return {
        code: 'PRINTER_OFFLINE',
        severity: 'fatal',
        userMessage: 'The printer is offline. Please check the connection.',
        timestamp: new Date().toISOString(),
      };
    }

    const blocked = BLOCKED_STATUSES.has(telemetry.status);
    if (blocked) {
      return {
        code: 'PRINTER_BLOCKED_STATE',
        severity: 'fatal',
        userMessage: `Printer is blocked: ${telemetry.status}`,
        timestamp: new Date().toISOString(),
      };
    }

    return null;
  }

  private mapEdgeStatusToPrintError(
    status: EdgePrinterStatus,
  ): PrintError | null {
    const now = new Date().toISOString();

    if (status.isOffline) {
      return {
        code: 'PRINTER_OFFLINE',
        severity: 'fatal',
        userMessage: 'Printer is offline.',
        hint: 'Please check the printer power and connection cables.',
        timestamp: now,
      };
    }

    if (status.isPaperJam) {
      return {
        code: 'PAPER_JAM_PRINT',
        severity: 'recoverable',
        userMessage: 'Paper jam detected in the printer.',
        hint: 'Please clear the jammed paper and close all covers.',
        timestamp: now,
        canRetry: true,
      };
    }

    if (status.isOutOfPaper) {
      return {
        code: 'PAPER_TRAY_EMPTY',
        severity: 'recoverable',
        userMessage: 'The printer is out of paper.',
        hint: 'Please load paper into the rear tray, then press Resume.',
        timestamp: now,
        canRetry: true,
      };
    }

    if (status.isPaperProblem) {
      return {
        code: 'PAPER_INSUFFICIENT_PRE_DISPATCH',
        severity: 'recoverable',
        userMessage:
          'Paper problem detected — the printer may not have enough paper.',
        hint: 'Please check the paper tray. You can pause and resume once ready.',
        timestamp: now,
        canRetry: true,
      };
    }

    if (status.isNoToner) {
      return {
        code: 'INK_DEPLETED',
        severity: 'fatal',
        userMessage: 'Ink or toner is depleted.',
        hint: 'The printer needs ink/toner replacement before it can print.',
        timestamp: now,
      };
    }

    if (status.isLowOnToner) {
      return {
        code: 'INK_LOW',
        severity: 'warning',
        userMessage: 'Ink or toner is running low.',
        hint: 'Printing may still work but quality could be reduced.',
        timestamp: now,
        canDismiss: true,
      };
    }

    if (status.isDoorOpened) {
      return {
        code: 'PRINTER_DOOR_OPEN',
        severity: 'recoverable',
        userMessage: 'Printer door or cover is open.',
        hint: 'Please close all printer covers and try again.',
        timestamp: now,
        canRetry: true,
      };
    }

    if (status.isOutputBinFull) {
      return {
        code: 'OUTPUT_BIN_FULL',
        severity: 'recoverable',
        userMessage: 'The printer output tray is full.',
        hint: 'Please remove printed pages from the output tray.',
        timestamp: now,
        canRetry: true,
      };
    }

    if (status.isManualFeedRequired) {
      return {
        code: 'MANUAL_FEED_REQUIRED',
        severity: 'recoverable',
        userMessage: 'Manual paper feed is required.',
        hint: 'Please insert paper manually into the feed tray.',
        timestamp: now,
        canRetry: true,
      };
    }

    return null;
  }

  // ── Spooler job control (pause / resume) ──────────────────────

  private async findSpoolerJobDetails(spoolerCorrelationKey: string): Promise<{
    printerName: string;
    spoolerJobId: number;
    transactionId: string;
  }> {
    if (!db.data || !db.data.spoolerLifecycle) {
      throw new Error('Database or spoolerLifecycle not initialized');
    }
    const matchingRecords = db.data.spoolerLifecycle.filter(
      (r) => r.spoolerCorrelationKey === spoolerCorrelationKey,
    );
    if (matchingRecords.length === 0) {
      throw new Error(
        `No spooler lifecycle record found for key: ${spoolerCorrelationKey}`,
      );
    }

    // Sort by updatedAt descending (newest first), then prefer failed state
    const record = matchingRecords.sort((a, b) => {
      const aMs = parseIsoMs(a.updatedAt);
      const bMs = parseIsoMs(b.updatedAt);
      const aValid = Number.isFinite(aMs);
      const bValid = Number.isFinite(bMs);
      if (aValid && bValid && bMs !== aMs) return bMs - aMs;
      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      if (a.currentState === 'failed' && b.currentState !== 'failed') return -1;
      if (a.currentState !== 'failed' && b.currentState === 'failed') return 1;
      return 0;
    })[0];

    let printerName = record.printerName;
    let recordModified = false;
    if (!printerName) {
      const telemetry = getPrinterTelemetry();
      if (telemetry.name) {
        printerName = telemetry.name;
        record.printerName = printerName;
        recordModified = true;
      }
    }

    if (!printerName) {
      throw new Error(
        `Missing printerName in spooler details for key: ${spoolerCorrelationKey}`,
      );
    }

    let spoolerJobId = record.spoolerJobId;
    if (spoolerJobId == null) {
      console.log(
        `[PRINTER-SERVICE] spoolerJobId is missing for key ${spoolerCorrelationKey}. Attempting to resolve via Get-PrintJob...`,
      );
      spoolerJobId = await findSpoolerJobIdByCorrelationKey(
        printerName,
        spoolerCorrelationKey,
      );
      if (spoolerJobId !== null) {
        console.log(
          `[PRINTER-SERVICE] Resolved spoolerJobId: ${spoolerJobId} for key ${spoolerCorrelationKey}`,
        );
        record.spoolerJobId = spoolerJobId;
        recordModified = true;
      }
    }

    if (recordModified) await db.write();

    if (spoolerJobId == null) {
      throw new Error(
        'Incomplete spooler details (missing printerName or spoolerJobId)',
      );
    }

    return {
      printerName,
      spoolerJobId,
      transactionId: record.transactionId,
    };
  }

  /**
   * Reads the most recent spooler-lifecycle record for the given correlation
   * key and returns the latest pagesPrinted / totalPages snapshot plus the
   * current state. Returns
   * `{ pagesPrinted: null, totalPages: null, currentState: null }` when the
   * record is missing or the values are unset (e.g. the monitor never
   * latched onto a job).
   */
  private readLifecyclePageProgress(spoolerCorrelationKey: string): {
    pagesPrinted: number | null;
    totalPages: number | null;
    currentState:
      | import('@/core/database/models/spooler-lifecycle.model').SpoolerLifecycleState
      | null;
  } {
    if (!db.data || !db.data.spoolerLifecycle) {
      return { pagesPrinted: null, totalPages: null, currentState: null };
    }
    const records = db.data.spoolerLifecycle.filter(
      (r) => r.spoolerCorrelationKey === spoolerCorrelationKey,
    );
    if (records.length === 0) {
      return { pagesPrinted: null, totalPages: null, currentState: null };
    }
    // Prefer the most recently updated record (matches findSpoolerJobDetails).
    const record = records.sort((a, b) => {
      const aMs = parseIsoMs(a.updatedAt);
      const bMs = parseIsoMs(b.updatedAt);
      const aValid = Number.isFinite(aMs);
      const bValid = Number.isFinite(bMs);
      if (aValid && bValid && bMs !== aMs) return bMs - aMs;
      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      return 0;
    })[0];
    return {
      pagesPrinted:
        typeof record.pagesPrinted === 'number' &&
        Number.isFinite(record.pagesPrinted)
          ? record.pagesPrinted
          : null,
      totalPages:
        typeof record.totalPages === 'number' &&
        Number.isFinite(record.totalPages)
          ? record.totalPages
          : null,
      currentState: record.currentState ?? null,
    };
  }

  /**
   * Reads the most recent spooler-lifecycle record for the given correlation
   * key and returns the `transactionId` + `mode` needed to write a follow-up
   * lifecycle transition (e.g. a `paused` state). Returns `null` when no
   * record matches.
   */
  private findLifecycleIdentity(
    spoolerCorrelationKey: string,
  ): { transactionId: string; mode: 'print' | 'copy' } | null {
    if (!db.data || !db.data.spoolerLifecycle) {
      return null;
    }
    const records = db.data.spoolerLifecycle.filter(
      (r) => r.spoolerCorrelationKey === spoolerCorrelationKey,
    );
    if (records.length === 0) return null;
    const record = records.sort((a, b) => {
      const aMs = parseIsoMs(a.updatedAt);
      const bMs = parseIsoMs(b.updatedAt);
      const aValid = Number.isFinite(aMs);
      const bValid = Number.isFinite(bMs);
      if (aValid && bValid && bMs !== aMs) return bMs - aMs;
      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      return 0;
    })[0];
    return { transactionId: record.transactionId, mode: record.mode };
  }

  /**
   * Persist a `paused` lifecycle transition for the given correlation key.
   * Best-effort: a DB-write failure is logged but does not break the pause
   * UX, because the spooler itself is already paused. The downside is the
   * resume path won't be able to distinguish a user pause from a driver
   * purge on the next Resume click — which is exactly the symptom this
   * helper is meant to prevent, so we keep the error visible.
   */
  private async persistPausedTransition(
    spoolerCorrelationKey: string,
    reason: string,
  ): Promise<void> {
    const identity = this.findLifecycleIdentity(spoolerCorrelationKey);
    if (!identity) {
      console.warn(
        `[PRINTER] Could not persist paused transition: no lifecycle record for key ${spoolerCorrelationKey}.`,
      );
      return;
    }
    try {
      await recordSpoolerLifecycleTransition({
        transactionId: identity.transactionId,
        mode: identity.mode,
        state: 'paused',
        spoolerCorrelationKey,
        reason,
      });
    } catch (error) {
      console.error(
        `[PRINTER] Failed to persist paused transition for key ${spoolerCorrelationKey}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Persist a `processing` lifecycle transition for the given correlation
   * key. Used to clear a previously-recorded 'paused' state once Resume
   * has been accepted by the spooler — without this, the lifecycle would
   * stay stuck on 'paused' and the spooler monitor's terminal-success
   * path (which only transitions to 'printed' from 'processing' or
   * 'queued') wouldn't fire.
   */
  private async persistProcessingTransition(
    spoolerCorrelationKey: string,
    reason: string,
  ): Promise<void> {
    const identity = this.findLifecycleIdentity(spoolerCorrelationKey);
    if (!identity) {
      console.warn(
        `[PRINTER] Could not persist processing transition: no lifecycle record for key ${spoolerCorrelationKey}.`,
      );
      return;
    }
    try {
      await recordSpoolerLifecycleTransition({
        transactionId: identity.transactionId,
        mode: identity.mode,
        state: 'processing',
        spoolerCorrelationKey,
        reason,
      });
    } catch (error) {
      console.error(
        `[PRINTER] Failed to persist processing transition for key ${spoolerCorrelationKey}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async cancelRemaining(spoolerCorrelationKey: string): Promise<void> {
    if (
      typeof spoolerCorrelationKey !== 'string' ||
      spoolerCorrelationKey.length > 255 ||
      !/^[a-zA-Z0-9-_]+$/.test(spoolerCorrelationKey)
    ) {
      throw new Error('Invalid spoolerCorrelationKey');
    }
    if (!this.io || !this.sessionStore) {
      throw new Error(
        'PrinterService was not initialized with Socket.IO or SessionStore.',
      );
    }

    const { transactionId } =
      await this.findSpoolerJobDetails(spoolerCorrelationKey);

    const recovery = getRecoverySession(transactionId);
    if (!recovery) {
      throw new Error(
        `No recovery session found for transaction: ${transactionId}`,
      );
    }
    if (recovery.phase === 'reconciled') {
      throw new Error(
        `Cannot cancel: transaction ${transactionId} is already reconciled.`,
      );
    }

    const originalPhase = recovery.phase;

    const lifecyclePages = this.readLifecyclePageProgress(
      spoolerCorrelationKey,
    );
    const totalPages = Math.max(1, lifecyclePages.totalPages || 1);
    const pagesPrinted = Math.min(
      totalPages,
      Math.max(0, lifecyclePages.pagesPrinted ?? 0),
    );

    const mode = recovery.mode;
    const requiredAmount = recovery.requiredAmount;

    // Calculate cost of printed pages and partial refund amount
    const pricePerPage = requiredAmount / totalPages;
    const printedCost = Math.min(
      requiredAmount,
      Math.ceil(pagesPrinted * pricePerPage),
    );

    // Save final reconciled state immediately after checking reconciled
    const sessionId = recovery.sessionId;
    const documentId = recovery.documentId;
    await checkpointRecoverySession({
      transactionId,
      mode,
      phase: 'reconciled',
      requiredAmount,
      chargedAmount: printedCost,
      sessionId,
      documentId,
      spoolerCorrelationKey,
      reconciledAt: new Date().toISOString(),
      spoolerTerminalAt: new Date().toISOString(),
      reconciliationAction: 'none',
      reconciliationReason: `User cancelled remaining pages. Printed ${pagesPrinted} of ${totalPages}.`,
    });

    const refundAmount = Math.max(0, requiredAmount - printedCost);
    let refundApplied = refundAmount === 0;

    try {
      if (refundAmount > 0) {
        await withBalanceLock(async () => {
          db.data!.balance += refundAmount;
          db.data!.earnings = Math.max(0, db.data!.earnings - refundAmount);
          await db.write();
        });
        refundApplied = true;

        await financialLedgerService.append({
          eventType: 'refund_issued',
          amount: refundAmount,
          referenceId: transactionId,
          meta: {
            source: 'cancel_remaining',
            spoolerCorrelationKey,
            pagesPrinted,
            totalPages,
            originalRequiredAmount: requiredAmount,
          },
        });

        this.io.emit('balance', db.data!.balance);
      }

      // Create partial receipt snapshot
      const receiptService = new ReceiptService();
      receiptService.upsertReceiptSnapshot({
        transactionId,
        mode,
        chargedAmount: printedCost,
        status: 'printed',
        terminalAt: new Date().toISOString(),
      });

      // Cleanup transient session files
      const filename =
        typeof recovery.context.filename === 'string'
          ? recovery.context.filename
          : null;

      if (filename) {
        if (sessionId && documentId) {
          await this.sessionStore.removeDocument(sessionId, documentId);
        } else {
          const uploadsDir = path.resolve('uploads');
          const normalized = filename.trim();
          if (normalized) {
            const filePath = path.resolve(uploadsDir, normalized);
            const relativePath = path.relative(uploadsDir, filePath);
            const isSafe =
              relativePath &&
              !relativePath.startsWith('..') &&
              !path.isAbsolute(relativePath);
            if (isSafe) {
              try {
                await fs.unlink(filePath);
              } catch {
                // ignore missing
              }
            }
          }
        }
      }

      if (mode === 'copy') {
        const previewFilename =
          typeof recovery.context.previewFilename === 'string'
            ? recovery.context.previewFilename
            : null;
        if (previewFilename) {
          try {
            await deleteTransientScanFile(previewFilename);
          } catch (error) {
            console.warn(
              `[PRINTER] Failed to delete transient scan file ${previewFilename}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }

      // Transition lifecycle to printed
      await persistAndEmitPrintLifecycleState(
        this.io,
        {
          mode,
          state: 'printed',
          transactionId,
          spoolerCorrelationKey,
          pagesPrinted,
          totalPages,
          reason: 'User cancelled remaining pages.',
        },
        {
          requiredAmount,
          sessionId,
          documentId,
        },
      );
    } catch (err) {
      if (!refundApplied) {
        try {
          await checkpointRecoverySession({
            transactionId,
            mode,
            phase: originalPhase,
            requiredAmount,
            chargedAmount: recovery.chargedAmount,
            sessionId,
            documentId,
            spoolerCorrelationKey,
            reconciliationAction: 'none',
            reconciliationReason: `Reconciliation aborted due to failure: ${err instanceof Error ? err.message : String(err)}`,
          });
        } catch (checkpointErr) {
          console.error(
            '[PRINTER] Failed to restore recovery phase on cancel failure:',
            checkpointErr,
          );
        }
      }
      throw err;
    }
  }
}
