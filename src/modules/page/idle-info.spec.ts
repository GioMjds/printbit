import { createDefaultIdleScreenSettings } from '@/shared/idle-screen-contract';
import {
  buildIdleInfo,
  deriveIdleServices,
  paperLowThreshold,
  summarizeIdlePricing,
  type IdleInfoInputs,
  type IdlePricingSource,
  type IdleSourceReaders,
} from './idle-info';

const healthy = (): IdleSourceReaders => ({
  printerStatus: () => 'ready',
  activePrinterErrorCode: () => null,
  scannerReady: () => true,
  hopperLastError: () => null,
  paperForecast: () => ({ enabled: true, currentSheets: 80, capacitySheets: 100 }),
});
const derive = (overrides: Partial<IdleSourceReaders> = {}) =>
  deriveIdleServices({ ...healthy(), ...overrides });
const boom = (): never => {
  throw new Error('source down');
};
const READY = { state: 'ready', reason: null };

describe('deriveIdleServices', () => {
  it('reports everything ready on a healthy kiosk', () => {
    expect(derive()).toEqual({
      services: { print: READY, copy: READY, scan: READY },
      paper: { level: 'ok' },
      change: { exactCoinsOnly: false },
    });
  });

  it('marks print and copy unavailable when the printer is offline', () => {
    const result = derive({ printerStatus: () => 'offline' });
    expect(result.services.print).toEqual({ state: 'unavailable', reason: 'printer_offline' });
    expect(result.services.copy).toEqual({ state: 'unavailable', reason: 'printer_offline' });
    expect(result.services.scan).toEqual(READY);
  });

  it('treats an active E_OFFLINE error as offline', () => {
    const result = derive({ activePrinterErrorCode: () => 'E_OFFLINE' });
    expect(result.services.print.reason).toBe('printer_offline');
  });

  it('marks a non-paper printer error as printer_error', () => {
    const result = derive({ activePrinterErrorCode: () => 'E_COVER_OPEN' });
    expect(result.services.print).toEqual({ state: 'unavailable', reason: 'printer_error' });
  });

  it('marks printer status error without a code as printer_error', () => {
    const result = derive({ printerStatus: () => 'error' });
    expect(result.services.print.reason).toBe('printer_error');
  });

  it('ignores the low-ink warning', () => {
    const result = derive({ activePrinterErrorCode: () => 'W_INK_LOW' });
    expect(result.services.print).toEqual(READY);
  });

  it('says paper_out for E_NO_PAPER even though the printer status is error', () => {
    const result = derive({
      printerStatus: () => 'error',
      activePrinterErrorCode: () => 'E_NO_PAPER',
    });
    expect(result.services.print).toEqual({ state: 'unavailable', reason: 'paper_out' });
    expect(result.services.copy).toEqual({ state: 'unavailable', reason: 'paper_out' });
    expect(result.paper.level).toBe('out');
  });

  it('never marks unavailable from the estimate alone, even at 0 sheets', () => {
    const result = derive({
      paperForecast: () => ({ enabled: true, currentSheets: 0, capacitySheets: 100 }),
    });
    expect(result.services.print).toEqual({ state: 'limited', reason: 'paper_low' });
    expect(result.paper.level).toBe('low');
  });

  it.each<[number, number, string]>([
    [100, 10, 'low'],
    [100, 11, 'ok'],
    [500, 50, 'low'],
    [500, 51, 'ok'],
  ])('capacity %p with %p sheets is paper %p', (capacity, sheets, level) => {
    const result = derive({
      paperForecast: () => ({ enabled: true, currentSheets: sheets, capacitySheets: capacity }),
    });
    expect(result.paper.level).toBe(level);
  });

  it('reports paper unknown when forecasting is disabled', () => {
    const result = derive({
      paperForecast: () => ({ enabled: false, currentSheets: 0, capacitySheets: 100 }),
    });
    expect(result.paper.level).toBe('unknown');
    expect(result.services.print).toEqual(READY);
  });

  it('marks scan and copy unavailable when the scanner is not ready', () => {
    const result = derive({ scannerReady: () => false });
    expect(result.services.scan).toEqual({ state: 'unavailable', reason: 'scanner_unavailable' });
    expect(result.services.copy).toEqual({ state: 'unavailable', reason: 'scanner_unavailable' });
    expect(result.services.print).toEqual(READY);
  });

  it.each<[string | null, boolean]>([
    ['ESP32 hopper dispense failed: EMPTY', true],
    ['hopper empty', true],
    ['JAM', false],
    [null, false],
  ])('hopper last error %p gives exactCoinsOnly %p', (message, expected) => {
    expect(derive({ hopperLastError: () => message }).change.exactCoinsOnly).toBe(expected);
  });

  it('marks print and copy unknown when printer sources throw', () => {
    const result = derive({ printerStatus: boom });
    expect(result.services.print).toEqual({ state: 'unknown', reason: null });
    expect(result.services.copy).toEqual({ state: 'unknown', reason: null });
    expect(result.paper.level).toBe('unknown');
  });

  it('marks scan and copy unknown when the scanner source throws', () => {
    const result = derive({ scannerReady: boom });
    expect(result.services.scan).toEqual({ state: 'unknown', reason: null });
    expect(result.services.copy).toEqual({ state: 'unknown', reason: null });
  });

  it('keeps going when the paper or hopper source throws', () => {
    const result = derive({ paperForecast: boom, hopperLastError: boom });
    expect(result.paper.level).toBe('unknown');
    expect(result.services.print).toEqual(READY);
    expect(result.change.exactCoinsOnly).toBe(false);
  });

  it('keeps the first reason for equal states and the worst state overall', () => {
    const result = derive({
      activePrinterErrorCode: () => 'E_NO_PAPER',
      scannerReady: () => false,
    });
    expect(result.services.copy).toEqual({ state: 'unavailable', reason: 'paper_out' });
    expect(result.services.scan.reason).toBe('scanner_unavailable');
  });

  it('does not downgrade offline to limited when paper is low', () => {
    const result = derive({
      printerStatus: () => 'offline',
      paperForecast: () => ({ enabled: true, currentSheets: 1, capacitySheets: 100 }),
    });
    expect(result.services.print).toEqual({ state: 'unavailable', reason: 'printer_offline' });
  });
});

describe('paperLowThreshold', () => {
  it('is at least 10 sheets and otherwise 10% rounded up', () => {
    expect(paperLowThreshold(50)).toBe(10);
    expect(paperLowThreshold(250)).toBe(25);
    expect(paperLowThreshold(255)).toBe(26);
  });
});

const PRICING: IdlePricingSource = {
  paperProfiles: {
    a4: { paperCost: 1, bwPrint: { low: 2 }, colorPrint: { low: 17 } },
    shortBond: { paperCost: 1, bwPrint: { low: 2 }, colorPrint: { low: 17 } },
    longBond: { paperCost: 1, bwPrint: { low: 3 }, colorPrint: { low: 19 } },
  },
  copyBwPerPage: 3,
  copyColorPerPage: 5,
  scanDocument: 5,
};

describe('summarizeIdlePricing', () => {
  it('uses the cheapest paper plus low-coverage rate as the "from" price', () => {
    expect(summarizeIdlePricing(PRICING)).toEqual({
      printBwFrom: 3,
      printColorFrom: 18,
      copyBw: 3,
      copyColor: 5,
      scan: 5,
    });
  });

  it('falls back to copyPerPage and pricing-config defaults', () => {
    const summary = summarizeIdlePricing({
      paperProfiles: PRICING.paperProfiles,
      copyPerPage: 4,
    });
    expect(summary.copyBw).toBe(4);
    expect(summary.copyColor).toBe(5);
    expect(summary.scan).toBe(5);
  });

  it('throws when there are no paper profiles', () => {
    expect(() => summarizeIdlePricing({ paperProfiles: {} })).toThrow();
  });
});

describe('buildIdleInfo', () => {
  const inputs = (overrides: Partial<IdleInfoInputs> = {}): IdleInfoInputs => ({
    readers: healthy(),
    settings: () => createDefaultIdleScreenSettings(),
    pricing: () => PRICING,
    coins: [1, 5, 10, 20],
    maxUploadBytes: 25 * 1024 * 1024,
    wordUploads: () => true,
    ...overrides,
  });

  it('returns exactly the contract fields', () => {
    const info = buildIdleInfo(inputs());
    expect(Object.keys(info).sort()).toEqual([
      'change',
      'coins',
      'maxUploadMb',
      'paper',
      'pricing',
      'services',
      'settings',
      'wordUploads',
    ]);
    expect(info.maxUploadMb).toBe(25);
    expect(info.coins).toEqual([1, 5, 10, 20]);
    expect(info.wordUploads).toBe(true);
  });

  it('returns null pricing when pricing throws', () => {
    expect(buildIdleInfo(inputs({ pricing: boom })).pricing).toBeNull();
  });

  it('returns default settings when settings throw', () => {
    expect(buildIdleInfo(inputs({ settings: boom })).settings).toEqual(
      createDefaultIdleScreenSettings(),
    );
  });

  it('returns wordUploads false when that source throws', () => {
    expect(buildIdleInfo(inputs({ wordUploads: boom })).wordUploads).toBe(false);
  });
});
