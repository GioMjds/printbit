import type { WorkerPrintEvent } from './worker-return-pipe';

export interface ProjectedPrinterState {
  connected: boolean;
  name: string | null;
  status: 'ready' | 'printing' | 'offline' | 'error';
  lastCheckedAt: string;
  error: string | null;
}

export class PrinterStateProjection {
  private state = {
    connected: false,
    name: null,
    status: 'offline',
    lastCheckedAt: new Date().toISOString(),
    error: null,
  } as ProjectedPrinterState;

  public reset(): void {
    this.state = {
      connected: false,
      name: null,
      status: 'offline',
      lastCheckedAt: new Date().toISOString(),
      error: null,
    };
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
          break;
        }
        this.state = {
          connected: true,
          name: evt.printerName ?? this.state.name,
          status: 'ready',
          lastCheckedAt: timestamp,
          error: null,
        };
        break;

      case 'PrinterOffline':
        this.state = {
          connected: false,
          name: evt.printerName ?? this.state.name,
          status: 'offline',
          lastCheckedAt: timestamp,
          error: evt.errorMessage ?? evt.message ?? 'Printer is offline',
        };
        break;

      case 'PrinterError':
        this.state = {
          connected: true,
          name: evt.printerName ?? this.state.name,
          status: 'error',
          lastCheckedAt: timestamp,
          error: evt.errorMessage ?? evt.message ?? 'Printer hardware error',
        };
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

export async function runInkTelemetryDiagnostics(): Promise<{
  installedPrinters: InstalledPrinterInfo[];
  inkDiagnostics: any[];
  targetPrinterName?: string | null;
  targetResolved?: boolean;
  telemetry?: PrinterTelemetry;
}> {
  const printers = await listInstalledPrinters();
  const telemetry = getPrinterTelemetry();
  return {
    installedPrinters: printers,
    inkDiagnostics: [],
    targetPrinterName: telemetry.name,
    targetResolved: Boolean(telemetry.name),
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

// TO REMOVE (functions): Since it is not going to be implemented
// 1. `cancelPrintJobViaEdge`
// 2. `pausePrintJobViaEdge`
// 3. `resumePrintJobViaEdge`

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

export async function watchJobForMalfunction(
  _io?: any,
  _opts?: {
    jobId?: string;
    sessionId?: string | null;
    pollIntervalMs?: number;
    watchDurationMs?: number;
    onFailure?: (jobId: string, fault: PrinterFault) => void;
  },
): Promise<{ faultDetected: boolean; fault?: PrinterFault }> {
  return { faultDetected: false };
}
