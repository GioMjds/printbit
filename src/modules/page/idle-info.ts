import type { PrinterErrorCode } from '@/shared/printer-error-catalog';
import {
  createDefaultIdleScreenSettings,
  type IdleInfo,
  type IdlePaperLevel,
  type IdlePricingSummary,
  type IdleScreenSettings,
  type IdleServiceName,
  type IdleServiceReason,
  type IdleServiceState,
  type IdleServiceStatus,
} from '@/shared/idle-screen-contract';

export type PrinterProjectionStatus = 'ready' | 'printing' | 'offline' | 'error';

export interface PaperForecastReading {
  enabled: boolean;
  currentSheets: number;
  capacitySheets: number;
}

/** Each reader may throw; deriveIdleServices isolates every one. */
export interface IdleSourceReaders {
  printerStatus: () => PrinterProjectionStatus;
  activePrinterErrorCode: () => PrinterErrorCode | null;
  scannerReady: () => boolean;
  hopperLastError: () => string | null;
  paperForecast: () => PaperForecastReading;
}

export interface IdleServicesResult {
  services: Record<IdleServiceName, IdleServiceStatus>;
  paper: { level: IdlePaperLevel };
  change: { exactCoinsOnly: boolean };
}

const STATE_RANK: Record<IdleServiceState, number> = {
  ready: 0,
  unknown: 1,
  limited: 2,
  unavailable: 3,
};

const PRINTER_SERVICES: IdleServiceName[] = ['print', 'copy'];
const SCANNER_SERVICES: IdleServiceName[] = ['scan', 'copy'];

type Reading<T> = { ok: true; value: T } | { ok: false };

function read<T>(fn: () => T): Reading<T> {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
}

/** Sheets at or below this count are "paper low". */
export function paperLowThreshold(capacitySheets: number): number {
  return Math.max(10, Math.ceil(capacitySheets * 0.1));
}

/**
 * Maps hardware sources to idle service states. Rules are applied in priority
 * order; a later rule only replaces a service's status when its state is worse,
 * so for equal states the first reason wins.
 *
 * Only the printer's own E_NO_PAPER makes a service unavailable for paper. The
 * sheet count is a staff-maintained estimate and can only mark paper low.
 */
export function deriveIdleServices(
  readers: IdleSourceReaders,
): IdleServicesResult {
  const services: Record<IdleServiceName, IdleServiceStatus> = {
    print: { state: 'ready', reason: null },
    copy: { state: 'ready', reason: null },
    scan: { state: 'ready', reason: null },
  };
  const raise = (
    names: IdleServiceName[],
    state: IdleServiceState,
    reason: IdleServiceReason | null,
  ): void => {
    for (const name of names) {
      if (STATE_RANK[state] > STATE_RANK[services[name].state]) {
        services[name] = { state, reason };
      }
    }
  };

  let paper: IdlePaperLevel = 'unknown';
  const printer = read(() => ({
    status: readers.printerStatus(),
    code: readers.activePrinterErrorCode(),
  }));

  if (!printer.ok) {
    raise(PRINTER_SERVICES, 'unknown', null);
  } else {
    const { status, code } = printer.value;
    if (code === 'E_NO_PAPER') {
      raise(PRINTER_SERVICES, 'unavailable', 'paper_out');
      paper = 'out';
    }
    // Offline comes from the live printer state only. E_OFFLINE does not
    // auto-clear, so a code raised while the printer was connecting at boot
    // would otherwise hide print and copy after the printer came back.
    if (status === 'offline') {
      raise(PRINTER_SERVICES, 'unavailable', 'printer_offline');
    }
    const otherError =
      code !== null &&
      code !== 'E_NO_PAPER' &&
      code !== 'E_OFFLINE' &&
      code !== 'W_INK_LOW';
    if (otherError || (status === 'error' && code !== 'E_NO_PAPER')) {
      raise(PRINTER_SERVICES, 'unavailable', 'printer_error');
    }
    if (paper !== 'out') {
      const forecast = read(readers.paperForecast);
      if (forecast.ok && forecast.value.enabled) {
        const { currentSheets, capacitySheets } = forecast.value;
        if (currentSheets <= paperLowThreshold(capacitySheets)) {
          paper = 'low';
          raise(PRINTER_SERVICES, 'limited', 'paper_low');
        } else {
          paper = 'ok';
        }
      }
    }
  }

  const scanner = read(readers.scannerReady);
  if (!scanner.ok) {
    raise(SCANNER_SERVICES, 'unknown', null);
  } else if (!scanner.value) {
    raise(SCANNER_SERVICES, 'unavailable', 'scanner_unavailable');
  }

  const hopper = read(readers.hopperLastError);
  const exactCoinsOnly = hopper.ok && /empty/i.test(hopper.value ?? '');

  return { services, paper: { level: paper }, change: { exactCoinsOnly } };
}

export interface IdlePricingSource {
  paperProfiles: Record<
    string,
    { paperCost: number; bwPrint: { low: number }; colorPrint: { low: number } }
  >;
  copyBwPerPage?: number;
  copyPerPage?: number;
  copyColorPerPage?: number;
  scanDocument?: number;
}

/**
 * Print prices vary by paper size and ink coverage, so the idle screen shows
 * "from" prices: the cheapest paper cost plus the low-coverage rate.
 * Copy and scan defaults match GET /api/pricing-config.
 */
export function summarizeIdlePricing(
  source: IdlePricingSource,
): IdlePricingSummary {
  const profiles = Object.values(source.paperProfiles);
  if (profiles.length === 0) {
    throw new Error('No paper profiles configured.');
  }
  const cheapest = (pick: (p: (typeof profiles)[number]) => number): number =>
    Math.min(...profiles.map((profile) => profile.paperCost + pick(profile)));
  return {
    printBwFrom: cheapest((p) => p.bwPrint.low),
    printColorFrom: cheapest((p) => p.colorPrint.low),
    copyBw: source.copyBwPerPage ?? source.copyPerPage ?? 3,
    copyColor: source.copyColorPerPage ?? 5,
    scan: source.scanDocument ?? 5,
  };
}

export interface IdleInfoInputs {
  readers: IdleSourceReaders;
  settings: () => IdleScreenSettings;
  pricing: () => IdlePricingSource;
  coins: readonly number[];
  maxUploadBytes: number;
  wordUploads: () => boolean;
}

export function buildIdleInfo(inputs: IdleInfoInputs): IdleInfo {
  const derived = deriveIdleServices(inputs.readers);
  const pricing = read(() => summarizeIdlePricing(inputs.pricing()));
  const settings = read(inputs.settings);
  const wordUploads = read(inputs.wordUploads);
  return {
    settings: settings.ok ? settings.value : createDefaultIdleScreenSettings(),
    pricing: pricing.ok ? pricing.value : null,
    services: derived.services,
    paper: derived.paper,
    change: derived.change,
    coins: [...inputs.coins],
    maxUploadMb: Math.round(inputs.maxUploadBytes / (1024 * 1024)),
    wordUploads: wordUploads.ok ? Boolean(wordUploads.value) : false,
  };
}
