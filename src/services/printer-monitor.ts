import type { Server } from 'socket.io';
import {
  onPrinterRefresh,
  queryLivePrinterStatus,
  type PrinterTelemetry,
} from './printer-status';
import { adminService } from './admin';
import { BLOCKED_STATUSES } from '@/utils';

// ── Blocked printer statuses ─────────────────────────────────────────────────

export interface PrinterMalfunctionEvent {
  status: string;
  statusFlags: string[];
  printerName: string | null;
  timestamp: string;
}

export interface PrinterStatusChangedEvent {
  connected: boolean;
  status: string;
  statusFlags: string[];
  printerName: string | null;
  timestamp: string;
}

export interface PrinterRecoveredEvent {
  status: string;
  printerName: string | null;
  timestamp: string;
}

export interface PrinterFault {
  timestamp: string;
  reason: string;
  severity: 'warning' | 'critical';
}

export interface WatchFailureContext {
  jobId: string;
  sessionId: string | null;
  fault: PrinterFault;
}

export type WatchResult =
  | { ok: true }
  | {
      ok: false;
      jobId: string;
      sessionId: string | null;
      fault: PrinterFault;
    };

// ── Service ──────────────────────────────────────────────────────────────────

class PrinterMonitorService {
  private io: Server | null = null;
  private previousStatus: string | null = null;
  private previousConnected: boolean | null = null;
  private started = false;

  /**
   * Wire the monitor into the printer-status refresh cycle.
   * Must be called once after Socket.IO is ready (in server.ts start()).
   * The first real check happens on the next telemetry refresh (~30 s after
   * startup, or immediately if the telemetry already has data).
   */
  start(io: Server): void {
    if (this.started) return;
    this.started = true;
    this.io = io;

    // Hook directly into printer-status.ts refresh cycle so we always compare
    // against the freshest data rather than running a second independent timer.
    onPrinterRefresh((telemetry) => this.evaluate(telemetry));

    console.log('[PRINTER-MONITOR] ✓ Status transition watcher started.');
  }

  // ── Core evaluation ────────────────────────────────────────────────────────

  private evaluate(telemetry: PrinterTelemetry): void {
    const currentStatus = telemetry.status;
    const currentConnected = telemetry.connected;
    const now = new Date().toISOString();

    if (this.previousStatus === null) {
      this.previousStatus = currentStatus;
      this.previousConnected = currentConnected;

      // If the printer is already faulted at startup, record it immediately
      // so operators know the machine is unhealthy before any user interaction.
      if (currentConnected && BLOCKED_STATUSES.has(currentStatus)) {
        void this.onStartupMalfunction(telemetry, now);
      } else if (!currentConnected) {
        void this.onStartupDisconnected(now);
      }
      return;
    }

    const wasBlocked = BLOCKED_STATUSES.has(this.previousStatus);
    const isNowBlocked = BLOCKED_STATUSES.has(currentStatus);
    const wasConnected = this.previousConnected!;

    // ── Connection state changes ───────────────────────────────────────────
    if (wasConnected && !currentConnected) {
      void this.onDisconnected(this.previousStatus, now);
    } else if (!wasConnected && currentConnected) {
      void this.onReconnected(telemetry, now);
    }

    // ── Status transitions (only while connected) ──────────────────────────
    if (wasConnected && currentConnected) {
      if (!wasBlocked && isNowBlocked) {
        void this.onMalfunctionDetected(telemetry, now);
      } else if (wasBlocked && !isNowBlocked) {
        void this.onRecovered(telemetry, now);
      } else if (currentStatus !== this.previousStatus) {
        // Non-critical status change (e.g. Idle → Printing) — emit for UI
        // updates but do not log to the admin log.
        this.emitStatusChanged(telemetry, now);
      }
    }

    this.previousStatus = currentStatus;
    this.previousConnected = currentConnected;
  }

  // ── Scenario handlers ──────────────────────────────────────────────────────

  private async onStartupMalfunction(
    telemetry: PrinterTelemetry,
    timestamp: string,
  ): Promise<void> {
    console.warn(
      `[PRINTER-MONITOR] ⚠ Printer already faulted at startup: ${telemetry.status}`,
    );

    await adminService.appendAdminLog(
      'printer_malfunction_at_startup',
      `Printer is already in a faulted state on startup: ${telemetry.status}.`,
      {
        printerName: telemetry.name ?? 'Unknown',
        status: telemetry.status,
        driverName: telemetry.driverName ?? null,
        portName: telemetry.portName ?? null,
      },
    );

    this.emitMalfunction(telemetry, timestamp);
    this.emitStatusChanged(telemetry, timestamp);
  }

  private async onStartupDisconnected(timestamp: string): Promise<void> {
    console.warn('[PRINTER-MONITOR] ⚠ No printer detected at startup.');

    await adminService.appendAdminLog(
      'printer_not_detected_at_startup',
      'No default printer was detected when the server started.',
      {},
    );

    this.emitStatusChanged(
      {
        connected: false,
        name: null,
        driverName: null,
        portName: null,
        connectionType: 'unknown',
        status: 'Not Connected',
        statusFlags: [],
        ink: [],
        inkDetectionMethod: 'none',
        lastCheckedAt: timestamp,
        lastError: null,
      },
      timestamp,
    );
  }

  private async onMalfunctionDetected(
    telemetry: PrinterTelemetry,
    timestamp: string,
  ): Promise<void> {
    console.warn(
      `[PRINTER-MONITOR] 🚨 Printer malfunction detected: ${this.previousStatus} → ${telemetry.status}`,
    );

    await adminService.appendAdminLog(
      'printer_malfunction_detected',
      `Printer transitioned into a faulted state: ${telemetry.status}.`,
      {
        printerName: telemetry.name ?? 'Unknown',
        previousStatus: this.previousStatus ?? 'Unknown',
        currentStatus: telemetry.status,
        driverName: telemetry.driverName ?? null,
        portName: telemetry.portName ?? null,
      },
    );

    this.emitMalfunction(telemetry, timestamp);
    this.emitStatusChanged(telemetry, timestamp);
  }

  private async onRecovered(
    telemetry: PrinterTelemetry,
    timestamp: string,
  ): Promise<void> {
    console.log(
      `[PRINTER-MONITOR] ✓ Printer recovered: ${this.previousStatus} → ${telemetry.status}`,
    );

    await adminService.appendAdminLog(
      'printer_recovered',
      `Printer recovered from faulted state. Now: ${telemetry.status}.`,
      {
        printerName: telemetry.name ?? 'Unknown',
        previousStatus: this.previousStatus ?? 'Unknown',
        currentStatus: telemetry.status,
      },
    );

    this.emitRecovered(telemetry, timestamp);
    this.emitStatusChanged(telemetry, timestamp);
  }

  private async onDisconnected(
    lastStatus: string,
    timestamp: string,
  ): Promise<void> {
    console.warn('[PRINTER-MONITOR] ✗ Printer disconnected.');

    await adminService.appendAdminLog(
      'printer_disconnected',
      'Printer connection was lost.',
      { lastStatus },
    );

    const offlineTelemetry: PrinterTelemetry = {
      connected: false,
      name: null,
      driverName: null,
      portName: null,
      connectionType: 'unknown',
      status: 'Offline',
      statusFlags: ['Offline'],
      ink: [],
      inkDetectionMethod: 'none',
      lastCheckedAt: timestamp,
      lastError: null,
    };

    this.emitMalfunction(offlineTelemetry, timestamp);
    this.emitStatusChanged(offlineTelemetry, timestamp);
  }

  private async onReconnected(
    telemetry: PrinterTelemetry,
    timestamp: string,
  ): Promise<void> {
    console.log(
      `[PRINTER-MONITOR] ✓ Printer reconnected: ${telemetry.name ?? 'Unknown'} (${telemetry.status})`,
    );

    await adminService.appendAdminLog(
      'printer_reconnected',
      `Printer reconnected: ${telemetry.name ?? 'Unknown'} (${telemetry.status}).`,
      {
        printerName: telemetry.name ?? 'Unknown',
        status: telemetry.status,
        driverName: telemetry.driverName ?? null,
        portName: telemetry.portName ?? null,
      },
    );

    this.emitRecovered(telemetry, timestamp);
    this.emitStatusChanged(telemetry, timestamp);
  }

  // ── Socket.IO emitters ────────────────────────────────────────────────────

  private emitMalfunction(
    telemetry: PrinterTelemetry,
    timestamp: string,
  ): void {
    const payload: PrinterMalfunctionEvent = {
      status: telemetry.status,
      statusFlags: telemetry.statusFlags,
      printerName: telemetry.name,
      timestamp,
    };
    this.io?.emit('printerMalfunction', payload);
  }

  private emitRecovered(telemetry: PrinterTelemetry, timestamp: string): void {
    const payload: PrinterRecoveredEvent = {
      status: telemetry.status,
      printerName: telemetry.name,
      timestamp,
    };
    this.io?.emit('printerRecovered', payload);
  }

  private emitStatusChanged(
    telemetry: PrinterTelemetry,
    timestamp: string,
  ): void {
    const payload: PrinterStatusChangedEvent = {
      connected: telemetry.connected,
      status: telemetry.status,
      statusFlags: telemetry.statusFlags,
      printerName: telemetry.name,
      timestamp,
    };
    this.io?.emit('printerStatusChanged', payload);
  }
}

// ── Mid-job failure watchdog ──────────────────────────────────────────────────
//
// Call immediately after printFile() resolves (job handed to the Windows
// spooler). Polls the live printer status every WATCHDOG_POLL_MS for up to
// WATCHDOG_DURATION_MS. On the first blocked status it emits printerMalfunction
// to all Socket.IO clients and logs to the admin log, then stops.
//
// This can be fire-and-forget from route handlers:
//   void watchJobForMalfunction(io, { jobId, onFailure });
//
// Design notes:
//   • Uses queryLivePrinterStatus() (fresh PowerShell call, ~< 1 s) rather than
//     getPrinterTelemetry() (30 s stale cache) so faults are caught quickly.
//   • Only emits printerMalfunction — the existing 30 s monitor handles the
//     subsequent printerStatusChanged / printerRecovered lifecycle events.
//   • Stops after the first fault: further polling would be redundant since the
//     monitor will take over on its next cycle.

const WATCHDOG_POLL_MS = 3_000;
const WATCHDOG_DURATION_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Watches for printer faults for ~30 s after a job is spooled.
 * Emits `printerMalfunction` via Socket.IO if a fault is detected and returns
 * a job-scoped structured result for callers that need per-job handling.
 *
 * @param io       - The Socket.IO server instance.
 * @param opts.jobId - Job identifier used in the structured result.
 * @param opts.sessionId - Optional session identifier for correlation.
 * @param opts.pollIntervalMs  - How often to poll (default: 3 000 ms).
 * @param opts.watchDurationMs - Total watch window  (default: 30 000 ms).
 * @param opts.onFailure - Optional callback invoked with the fault details.
 */
export async function watchJobForMalfunction(
  io: Server,
  opts: {
    jobId: string;
    sessionId?: string | null;
    pollIntervalMs?: number;
    watchDurationMs?: number;
    onFailure?: (jobId: string, fault: PrinterFault) => void;
  },
): Promise<WatchResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? WATCHDOG_POLL_MS;
  const watchDurationMs = opts.watchDurationMs ?? WATCHDOG_DURATION_MS;
  const deadline = Date.now() + watchDurationMs;

  console.log('[PRINTER-MONITOR] 👁 Mid-job watchdog started.');

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (Date.now() >= deadline) break;

    const liveStatus = await queryLivePrinterStatus();

    const { connected, status, statusFlags } = liveStatus;

    if (!connected || BLOCKED_STATUSES.has(status)) {
      const timestamp = new Date().toISOString();
      const fault: PrinterFault = {
        timestamp,
        reason: !connected ? 'Printer disconnected during active job.' : status,
        severity: connected ? 'warning' : 'critical',
      };
      console.warn(
        `[PRINTER-MONITOR] 🚨 Mid-job fault detected by watchdog: ${status}`,
      );

      await adminService.appendAdminLog(
        'printer_midjob_malfunction',
        `Printer fault detected during active job: ${status}.`,
        { status, statusFlags: statusFlags.join(', '), connected },
      );

      // Emit malfunction so kiosk UI can surface an error immediately.
      // printerName is omitted here — the fast status query skips it to stay
      // under 1 s. The 30 s monitor will emit a full printerStatusChanged with
      // name on its next cycle.
      const payload: PrinterMalfunctionEvent = {
        status,
        statusFlags,
        printerName: null,
        timestamp,
      };
      io.emit('printerMalfunction', payload);

      opts.onFailure?.(opts.jobId, fault);

      return {
        ok: false,
        jobId: opts.jobId,
        sessionId: opts.sessionId!,
        fault,
      };
    }
  }

  console.log(
    '[PRINTER-MONITOR] 👁 Mid-job watchdog complete — no fault detected.',
  );

  return { ok: true };
}

// ── Singleton exports ─────────────────────────────────────────────────────────

export const printerMonitorService = new PrinterMonitorService();

export function startPrinterMonitor(io: Server): void {
  printerMonitorService.start(io);
}
