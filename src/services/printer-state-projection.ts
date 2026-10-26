import { EventEmitter } from 'node:events';
import type { Server } from 'socket.io';
import type { WorkerPrintEvent } from './worker-return-pipe';
import { printerErrorStateManager } from './printer-error-state';
import {
  lockCoinSlot,
  unlockOwnedCoinSlot as unlockCoinSlot,
  isCoinSlotLockedBy,
} from './hardware-state-projection';
import { anomalyService } from './anomaly';
import { adminPushService } from './admin-push.service';
import { translateHardwarePrinterError } from './printer-error-translation';

type SocketIoEmitter = { emit: (event: string, ...args: unknown[]) => void } | Server;

let printerGuideSocketIo: SocketIoEmitter | null = null;

export function setPrinterGuideSocketIo(io: SocketIoEmitter | null): void {
  printerGuideSocketIo = io;
}

export function getPrinterGuideSocketIo(): SocketIoEmitter | null {
  return printerGuideSocketIo;
}

export function handlePrinterStatusUpdate(
  statusText: string,
  errorCode?: string | null,
  jobId?: string | null,
): void {
  const normalized = (statusText ?? '').trim().toLowerCase();
  const isHealthy = normalized === 'ready' || normalized === 'healthy';

  if (isHealthy) {
    adminPushService.clearAlert('PAPER_JAM');
    adminPushService.clearAlert('PAPER_OUT');
    adminPushService.clearAlert('PRINTER_OFFLINE');

    const { cleared, state } = printerErrorStateManager.recordHealthyPoll();
    const active = printerErrorStateManager.getActiveError();
    if (cleared || (isCoinSlotLockedBy('printer-error-guide') && !active)) {
      if (state?.jobRequiresStaff || active?.jobRequiresStaff) {
        printerGuideSocketIo?.emit('printer:error-guide-update', {
          activeError: { ...(state ?? active), status: 'interrupted' },
        });
      } else {
        unlockCoinSlot('printer-error-guide');
        printerGuideSocketIo?.emit('printer:error-guide-update', { activeError: null });
      }
    }
  } else {
    const translated = translateHardwarePrinterError({
      message: statusText,
      errorCode,
    });

    if (translated.code === 'PAPER_JAM_PRINT') {
      void adminPushService.broadcastCriticalAlert({
        code: 'PAPER_JAM',
        title: '🚨 Kiosk Paper Jam Detected!',
        message: 'Paper is jammed in the kiosk printer. Physical clearance required.',
        severity: 'critical',
      });
      return;
    }

    if (translated.tier === 'None') {
      return;
    }

    const prev = printerErrorStateManager.getActiveError();
    const isNewFault =
      !prev || prev.code !== translated.code || prev.status !== 'active';
    const activeError = printerErrorStateManager.recordError(translated.code, jobId);

    if (translated.locksCoinSlot && !isCoinSlotLockedBy('printer-error-guide')) {
      lockCoinSlot('printer-error-guide', 'printer_error_' + translated.code);
    }

    if (
      isNewFault &&
      (activeError.tier === 'Staff' || activeError.tier === 'Technician')
    ) {
      void anomalyService.report({
        type: `printer_error_${activeError.code.toLowerCase()}`,
        source: 'printer-guide',
        category: 'printer',
        severity: activeError.tier === 'Technician' ? 'critical' : 'warning',
        message: translated.userMessage,
        fingerprint: `printer-${activeError.code}`,
        context: {
          code: activeError.code,
          tier: activeError.tier,
          occurrences: activeError.occurrences,
          status: activeError.status,
          jobId: activeError.jobId,
        },
      });
      printerGuideSocketIo?.emit('printer:staff-alert', { activeError });
    }

    printerGuideSocketIo?.emit('printer:error-guide-update', { activeError });
  }
}

export interface ProjectedPrinterState {
  connected: boolean;
  name: string | null;
  status: 'ready' | 'printing' | 'offline' | 'error';
  lastCheckedAt: string;
  error: string | null;
}

export class PrinterStateProjection extends EventEmitter {
  private state = {
    connected: false,
    name: null,
    status: 'offline',
    lastCheckedAt: new Date().toISOString(),
    error: null,
  } as ProjectedPrinterState;

  constructor() {
    super();
  }

  public reset(): void {
    this.state = {
      connected: false,
      name: null,
      status: 'offline',
      lastCheckedAt: new Date().toISOString(),
      error: null,
    };
    this.emit('state', this.getSnapshot());
  }

  public applyEvent(evt: WorkerPrintEvent): void {
    const timestamp = evt.timestampUtc || new Date().toISOString();
    switch (evt.type) {
      case 'PrinterStatusSnapshot':
      case 'PrinterOnline':
        if (
          evt.type === 'PrinterStatusSnapshot' &&
          evt.message?.toLowerCase().includes('offline')
        ) {
          this.state = {
            connected: false,
            name: evt.printerName ?? this.state.name,
            status: 'offline',
            lastCheckedAt: timestamp,
            error: evt.errorMessage ?? evt.message ?? 'Printer is offline',
          };
          handlePrinterStatusUpdate(
            this.state.error ?? 'offline',
            evt.errorCode,
            evt.transactionId,
          );
          break;
        }
        this.state = {
          connected: true,
          name: evt.printerName ?? this.state.name,
          status: 'ready',
          lastCheckedAt: timestamp,
          error: null,
        };
        handlePrinterStatusUpdate('ready');
        break;

      case 'PrinterOffline':
        this.state = {
          connected: false,
          name: evt.printerName ?? this.state.name,
          status: 'offline',
          lastCheckedAt: timestamp,
          error: evt.errorMessage ?? evt.message ?? 'Printer is offline',
        };
        handlePrinterStatusUpdate(
          this.state.error ?? 'offline',
          evt.errorCode,
          evt.transactionId,
        );
        break;

      case 'PrinterError':
        this.state = {
          connected: true,
          name: evt.printerName ?? this.state.name,
          status: 'error',
          lastCheckedAt: timestamp,
          error: evt.errorMessage ?? evt.message ?? 'Printer hardware error',
        };
        handlePrinterStatusUpdate(
          evt.errorMessage ?? evt.message ?? 'Printer hardware error',
          evt.errorCode,
          evt.transactionId,
        );
        break;

      case 'PrintStarted':
      case 'PrintProgress':
        this.state.status = 'printing';
        this.state.lastCheckedAt = timestamp;
        if (evt.printerName) {
          this.state.name = evt.printerName;
        }
        break;

      case 'PrintSucceeded':
      case 'PrintFailed':
      case 'JobCompleted':
        if (this.state.status !== 'error' && this.state.status !== 'offline') {
          this.state.status = 'ready';
        }
        this.state.lastCheckedAt = timestamp;
        if (evt.printerName) {
          this.state.name = evt.printerName;
        }
        break;
    }
    this.emit('event', evt);
    this.emit('state', this.getSnapshot());
  }

  public getSnapshot(): ProjectedPrinterState {
    return { ...this.state };
  }

  public isReady(): boolean {
    return this.state.connected && this.state.status === 'ready';
  }
}

export const printerStateProjection = new PrinterStateProjection();

export interface PrinterTelemetry {
  connected: boolean;
  name: string | null;
  driverName: string | null;
  portName: string | null;
  connectionType: 'usb' | 'network' | 'wsd' | 'virtual' | 'unknown';
  status: string;
  statusFlags: string[];
  ink: {
    name: string;
    level: number | null;
    status: 'ok' | 'low' | 'empty' | 'unknown';
    colorHint?: string;
  }[];
  inkDetectionMethod:
    | 'snmp'
    | 'vendor-wmi'
    | 'printer-property'
    | 'error-state'
    | 'none';
  inkTelemetryAvailable: boolean;
  inkTelemetryReason?: string | null;
  lastCheckedAt: string;
  lastError: string | null;
}

export function getPrinterTelemetry(): PrinterTelemetry {
  const s = printerStateProjection.getSnapshot();
  return {
    connected: s.connected,
    name: s.name,
    driverName: null,
    portName: null,
    connectionType: 'usb',
    status:
      s.status === 'ready'
        ? 'Idle'
        : s.status === 'printing'
          ? 'Printing'
          : s.status === 'offline'
            ? 'Offline'
            : 'Error',
    statusFlags: [],
    ink: [],
    inkDetectionMethod: 'none',
    inkTelemetryAvailable: false,
    inkTelemetryReason: null,
    lastCheckedAt: s.lastCheckedAt,
    lastError: s.error,
  };
}

export async function refreshPrinterTelemetry(): Promise<PrinterTelemetry> {
  return getPrinterTelemetry();
}

export interface InkPreflightEvaluation {
  blocked: boolean;
  code: string;
  reason: string | null;
  telemetryAvailable: boolean;
}

export function evaluateInkPreflight(
  telemetry: PrinterTelemetry,
): InkPreflightEvaluation {
  return {
    blocked: false,
    code: 'ok',
    reason: null,
    telemetryAvailable: Boolean(telemetry.inkTelemetryAvailable),
  };
}

export interface InstalledPrinterInfo {
  name: string;
  isDefault: boolean;
  status: string;
  Name: string;
  DriverName: string;
  PortName: string;
  Default?: boolean;
  PrinterStatus: number;
  PrinterState: number;
  PnpInstanceId?: string | null;
  PnpFriendlyName?: string | null;
  DeviceSerialNumber?: string | null;
}

export async function listInstalledPrinters(): Promise<InstalledPrinterInfo[]> {
  const s = printerStateProjection.getSnapshot();
  const name = s.name ?? 'Default';
  return [
    {
      name,
      isDefault: true,
      status: s.status,
      Name: name,
      DriverName: 'Generic / Text Only',
      PortName: 'USB001',
      Default: true,
      PrinterStatus:
        s.status === 'ready'
          ? 3
          : s.status === 'printing'
            ? 4
            : s.status === 'offline'
              ? 7
              : 1,
      PrinterState: 0,
      PnpInstanceId: null,
      PnpFriendlyName: null,
      DeviceSerialNumber: null,
    },
  ];
}

export interface InkDiagnosticEntry {
  propertyName: string;
  value: unknown;
}

export interface TargetPrinterIdentity {
  pnpInstanceId: string | null;
  pnpFriendlyName: string | null;
  deviceSerialNumber: string | null;
}

export interface InkTelemetryDiagnosticsResult {
  installedPrinters: InstalledPrinterInfo[];
  inkDiagnostics: InkDiagnosticEntry[];
  matchingProperties: InkDiagnosticEntry[];
  targetPrinterName: string | null;
  targetResolved: boolean;
  targetPrinterIdentity: TargetPrinterIdentity | null;
  telemetry: PrinterTelemetry;
}

export async function runInkTelemetryDiagnostics(): Promise<InkTelemetryDiagnosticsResult> {
  const printers = await listInstalledPrinters();
  const telemetry = getPrinterTelemetry();
  const targetPrinterName = telemetry.name;
  const targetResolved = Boolean(targetPrinterName);

  const targetPrinter = targetPrinterName
    ? printers.find(
        (p) => p.name === targetPrinterName || p.Name === targetPrinterName,
      )
    : printers[0] ?? null;

  const targetPrinterIdentity: TargetPrinterIdentity | null = targetPrinter
    ? {
        pnpInstanceId: targetPrinter.PnpInstanceId ?? null,
        pnpFriendlyName: targetPrinter.PnpFriendlyName ?? null,
        deviceSerialNumber: targetPrinter.DeviceSerialNumber ?? null,
      }
    : null;

  const matchingProperties: InkDiagnosticEntry[] = [];

  return {
    installedPrinters: printers,
    inkDiagnostics: matchingProperties,
    matchingProperties,
    targetPrinterName,
    targetResolved,
    targetPrinterIdentity,
    telemetry,
  };
}

export interface EdgePrinterStatus {
  name: string;
  isOutOfPaper: boolean;
  isPaperJam: boolean;
  isOffline: boolean;
  isPaused: boolean;
  isBusy: boolean;
  isDoorOpened: boolean;
  isLowOnToner: boolean;
  isNoToner: boolean;
  isManualFeedRequired: boolean;
  isOutputBinFull: boolean;
  isPaperProblem: boolean;
  status: string;
  queueStatus: string;
}

export interface EdgeJobActionResult {
  success: boolean;
  error?: string;
  noOp?: boolean;
  alreadyInState?: boolean;
}

export async function cancelPrintJobViaEdge(
  _printerName: string,
  _spoolerJobId: number,
): Promise<EdgeJobActionResult> {
  return { success: true };
}

export async function pausePrintJobViaEdge(
  _printerName: string,
  _spoolerJobId: number,
): Promise<EdgeJobActionResult> {
  return { success: true };
}

export async function resumePrintJobViaEdge(
  _printerName: string,
  _spoolerJobId: number,
): Promise<EdgeJobActionResult> {
  return { success: true };
}

export async function getPrinterStatusViaEdge(
  printerName?: string,
): Promise<EdgePrinterStatus> {
  const s = printerStateProjection.getSnapshot();
  return {
    name: s.name ?? printerName ?? 'Default',
    isOutOfPaper: false,
    isPaperJam: false,
    isOffline: !s.connected || s.status === 'offline',
    isPaused: false,
    isBusy: s.status === 'printing',
    isDoorOpened: false,
    isLowOnToner: false,
    isNoToner: false,
    isManualFeedRequired: false,
    isOutputBinFull: false,
    isPaperProblem: s.status === 'error',
    status: s.status,
    queueStatus: s.status,
  };
}

export async function warmPrinterEdgeRunspace(): Promise<void> {}

export function isPrinterFaultLocked(): boolean {
  return false;
}

export function clearPrinterFaultLock(): void {}

export interface PrinterFault {
  timestamp: string;
  reason: string;
  severity: 'warning' | 'critical';
}

export interface WatchJobOptions {
  jobId?: string;
  sessionId?: string | null;
  pollIntervalMs?: number;
  watchDurationMs?: number;
  onFailure?: (jobId: string, fault: PrinterFault) => void;
}

export interface WatchJobResult {
  faultDetected: boolean;
  fault?: PrinterFault;
}

export async function watchJobForMalfunction(
  io?: SocketIoEmitter | null,
  opts?: WatchJobOptions,
): Promise<WatchJobResult> {
  const watchDurationMs = opts?.watchDurationMs ?? 30_000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 1_000;
  const jobId = opts?.jobId;

  const initial = printerStateProjection.getSnapshot();
  if (
    !initial.connected ||
    initial.status === 'error' ||
    initial.status === 'offline'
  ) {
    const fault: PrinterFault = {
      timestamp: initial.lastCheckedAt || new Date().toISOString(),
      reason:
        initial.error ??
        (!initial.connected
          ? 'Printer is offline'
          : `Printer in ${initial.status} state`),
      severity: initial.status === 'error' ? 'critical' : 'warning',
    };

    if (jobId && opts?.onFailure) {
      opts.onFailure(jobId, fault);
    }

    if (io) {
      io.emit('printerMalfunction', {
        status: initial.status,
        printerName: initial.name,
        timestamp: fault.timestamp,
        reason: fault.reason,
      });
    }

    return { faultDetected: true, fault };
  }

  return new Promise<WatchJobResult>((resolve) => {
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let pollTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (pollTimer) clearInterval(pollTimer);
      printerStateProjection.removeListener('event', onWorkerEvent);
    };

    const triggerFault = (fault: PrinterFault) => {
      if (settled) return;
      cleanup();

      if (jobId && opts?.onFailure) {
        opts.onFailure(jobId, fault);
      }

      if (io) {
        io.emit('printerMalfunction', {
          status: 'error',
          printerName: printerStateProjection.getSnapshot().name,
          timestamp: fault.timestamp,
          reason: fault.reason,
        });
      }

      resolve({ faultDetected: true, fault });
    };

    const onWorkerEvent = (evt: WorkerPrintEvent) => {
      if (settled) return;

      if (jobId && evt.transactionId && evt.transactionId !== jobId) {
        return;
      }

      if (evt.type === 'PrinterError' || evt.type === 'PrinterOffline') {
        const fault: PrinterFault = {
          timestamp: evt.timestampUtc || new Date().toISOString(),
          reason:
            evt.errorMessage ??
            evt.message ??
            'Printer hardware error detected',
          severity: evt.type === 'PrinterError' ? 'critical' : 'warning',
        };
        triggerFault(fault);
        return;
      }

      if (evt.type === 'PrintFailed') {
        if (!evt.transactionId || evt.transactionId === jobId) {
          const fault: PrinterFault = {
            timestamp: evt.timestampUtc || new Date().toISOString(),
            reason: evt.errorMessage ?? evt.message ?? 'Print job failed',
            severity: 'critical',
          };
          triggerFault(fault);
          return;
        }
      }

      if (
        (evt.type === 'PrintSucceeded' || evt.type === 'JobCompleted') &&
        (!evt.transactionId || evt.transactionId === jobId)
      ) {
        cleanup();
        resolve({ faultDetected: false });
      }
    };

    printerStateProjection.on('event', onWorkerEvent);

    pollTimer = setInterval(() => {
      if (settled) return;
      const snap = printerStateProjection.getSnapshot();
      if (!snap.connected || snap.status === 'error' || snap.status === 'offline') {
        const fault: PrinterFault = {
          timestamp: snap.lastCheckedAt || new Date().toISOString(),
          reason:
            snap.error ??
            (!snap.connected
              ? 'Printer is offline'
              : `Printer in ${snap.status} state`),
          severity: snap.status === 'error' ? 'critical' : 'warning',
        };
        triggerFault(fault);
      }
    }, pollIntervalMs);
    pollTimer.unref?.();

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      cleanup();
      resolve({ faultDetected: false });
    }, watchDurationMs);
    timeoutTimer.unref?.();
  });
}
