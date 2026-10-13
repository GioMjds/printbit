import {
  PRINTER_ERROR_CATALOG,
  type PrinterErrorCode,
  type PrinterErrorTier,
} from '@/shared/printer-error-catalog';

export interface ActivePrinterErrorState {
  code: PrinterErrorCode;
  tier: PrinterErrorTier;
  autoClear: boolean;
  locksCoinSlot: boolean;
  lookAtPrinterScreen: boolean;
  jobId: string | null;
  jobRequiresStaff: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  status: 'active' | 'cleared' | 'out_of_service';
}

export interface PrinterErrorStateOptions {
  debouncePollCount?: number;
  repeatWindowMs?: number;
  maxRepeatsBeforeLockout?: number;
}

export class PrinterErrorStateManager {
  private active: ActivePrinterErrorState | null = null;
  private consecutiveHealthyPolls = 0;
  private repeatHistory: Map<PrinterErrorCode, number[]> = new Map();
  private readonly debouncePollCount: number;
  private readonly repeatWindowMs: number;
  private readonly maxRepeatsBeforeLockout: number;
  private outOfService = false;

  constructor(options: PrinterErrorStateOptions = {}) {
    this.debouncePollCount = options.debouncePollCount ?? 2;
    this.repeatWindowMs = options.repeatWindowMs ?? 300_000;
    this.maxRepeatsBeforeLockout = options.maxRepeatsBeforeLockout ?? 2;
  }

  public recordError(code: PrinterErrorCode, jobId?: string | null): ActivePrinterErrorState {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const def = PRINTER_ERROR_CATALOG[code] ?? PRINTER_ERROR_CATALOG.E_UNKNOWN;

    this.consecutiveHealthyPolls = 0;

    // Track repeat fault timestamps
    const timestamps = (this.repeatHistory.get(code) ?? []).filter(
      (ts) => now - ts <= this.repeatWindowMs,
    );
    const isSameActiveFault = Boolean(
      this.active && this.active.code === code && this.active.status !== 'cleared',
    );
    if (!isSameActiveFault) {
      timestamps.push(now);
      this.repeatHistory.set(code, timestamps);
    }

    const occurrences = timestamps.length;
    let status: ActivePrinterErrorState['status'] = 'active';

    if (this.outOfService || occurrences > this.maxRepeatsBeforeLockout) {
      status = 'out_of_service';
      this.outOfService = true;
    }

    const state: ActivePrinterErrorState = {
      code,
      tier: def.tier,
      autoClear: def.autoClear,
      locksCoinSlot: def.locksCoinSlot,
      lookAtPrinterScreen: def.lookAtPrinterScreen,
      jobId: jobId ?? this.active?.jobId ?? null,
      jobRequiresStaff: Boolean(jobId ?? this.active?.jobId),
      firstSeenAt: (this.active?.code === code ? this.active.firstSeenAt : null) ?? nowIso,
      lastSeenAt: nowIso,
      occurrences,
      status,
    };

    this.active = state;
    return { ...state };
  }

  public recordHealthyPoll(): { cleared: boolean; state: ActivePrinterErrorState | null } {
    if (!this.active || this.active.status === 'cleared') {
      return { cleared: false, state: null };
    }

    if (this.active.status === 'out_of_service') {
      return { cleared: false, state: { ...this.active } };
    }

    this.consecutiveHealthyPolls += 1;

    // Only Customer tier errors can auto-clear
    if (this.active.autoClear && this.consecutiveHealthyPolls >= this.debouncePollCount) {
      const finishedState = {
        ...this.active,
        status: 'cleared' as const,
      };
      this.active = null;
      this.consecutiveHealthyPolls = 0;
      return { cleared: true, state: finishedState };
    }

    return { cleared: false, state: { ...this.active } };
  }

  public clearStaffResolution(_staffId?: string): void {
    this.active = null;
    this.consecutiveHealthyPolls = 0;
    this.outOfService = false;
    this.repeatHistory.clear();
  }

  public getActiveError(): ActivePrinterErrorState | null {
    return this.active ? { ...this.active } : null;
  }

  public isKioskOutOfService(): boolean {
    return this.outOfService;
  }
}

export const printerErrorStateManager = new PrinterErrorStateManager();
