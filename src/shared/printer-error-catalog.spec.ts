import {
  PRINTER_ERROR_CATALOG,
  getPrinterErrorDefinition,
  type PrinterErrorCode,
} from './printer-error-catalog';

describe('printer-error-catalog', () => {
  const EXPECTED_CODES: PrinterErrorCode[] = [
    'E_NO_PAPER',
    'E_COVER_OPEN',
    'E_OUTPUT_TRAY',
    'E_PAPER_SETUP',
    'E_INK_OUT',
    'E_OFFLINE',
    'E_SERVICE',
    'E_UNKNOWN',
    'E_STALL',
    'W_INK_LOW',
  ];

  it('defines all required catalog error codes', () => {
    for (const code of EXPECTED_CODES) {
      expect(PRINTER_ERROR_CATALOG[code]).toBeDefined();
      expect(PRINTER_ERROR_CATALOG[code].code).toBe(code);
    }
  });

  it('verifies customer tier autoClear and physical actions', () => {
    const coverOpen = PRINTER_ERROR_CATALOG.E_COVER_OPEN;
    expect(coverOpen.tier).toBe('Customer');
    expect(coverOpen.autoClear).toBe(true);
    expect(coverOpen.locksCoinSlot).toBe(true);
    expect(coverOpen.lookAtPrinterScreen).toBe(true);
    expect(coverOpen.action.en.toLowerCase()).not.toContain('cancel');
    expect(coverOpen.action.en.toLowerCase()).not.toContain('resume');

    const outputTray = PRINTER_ERROR_CATALOG.E_OUTPUT_TRAY;
    expect(outputTray.tier).toBe('Customer');
    expect(outputTray.autoClear).toBe(true);
    expect(outputTray.locksCoinSlot).toBe(true);
  });

  it('verifies staff and technician tiers require staff clearing', () => {
    expect(PRINTER_ERROR_CATALOG.E_NO_PAPER.tier).toBe('Staff');
    expect(PRINTER_ERROR_CATALOG.E_NO_PAPER.autoClear).toBe(false);

    expect(PRINTER_ERROR_CATALOG.E_SERVICE.tier).toBe('Technician');
    expect(PRINTER_ERROR_CATALOG.E_SERVICE.autoClear).toBe(false);

    expect(PRINTER_ERROR_CATALOG.W_INK_LOW.tier).toBe('None');
    expect(PRINTER_ERROR_CATALOG.W_INK_LOW.locksCoinSlot).toBe(false);
  });

  it('falls back to E_UNKNOWN for unmapped codes in lookup helper', () => {
    const fallback = getPrinterErrorDefinition('UNRECOGNIZED_CODE');
    expect(fallback.code).toBe('E_UNKNOWN');
    expect(fallback.tier).toBe('Staff');
  });
});
