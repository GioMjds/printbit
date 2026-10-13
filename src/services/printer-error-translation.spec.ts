import { translateHardwarePrinterError } from './printer-error-translation';

describe('translateHardwarePrinterError', () => {
  it('maps door/cover open to E_COVER_OPEN', () => {
    const res = translateHardwarePrinterError({ message: 'Cover open', errorCode: '7' });
    expect(res.code).toBe('E_COVER_OPEN');
    expect(res.tier).toBe('Customer');
    expect(res.autoClear).toBe(true);
    expect(res.userMessage).not.toContain('Resume');
    expect(res.userMessage).not.toContain('Cancel');
  });

  it('maps paper empty to E_NO_PAPER', () => {
    const res = translateHardwarePrinterError({ message: 'Paper out', errorCode: '4' });
    expect(res.code).toBe('E_NO_PAPER');
    expect(res.tier).toBe('Staff');
    expect(res.autoClear).toBe(false);
    expect(res.userMessage).not.toContain('Resume');
  });

  it('maps output tray to E_OUTPUT_TRAY', () => {
    const res = translateHardwarePrinterError({ message: 'Output bin full', errorCode: '11' });
    expect(res.code).toBe('E_OUTPUT_TRAY');
    expect(res.tier).toBe('Customer');
    expect(res.autoClear).toBe(true);
  });

  it('maps paper setup prompt to E_PAPER_SETUP', () => {
    const res = translateHardwarePrinterError({ message: 'Paper setup required on panel' });
    expect(res.code).toBe('E_PAPER_SETUP');
    expect(res.tier).toBe('Staff');
  });

  it('maps ink out / toner out to E_INK_OUT', () => {
    const res = translateHardwarePrinterError({ message: 'No toner', errorCode: '5' });
    expect(res.code).toBe('E_INK_OUT');
    expect(res.tier).toBe('Staff');
  });

  it('maps offline to E_OFFLINE', () => {
    const res = translateHardwarePrinterError({ message: 'Printer offline', errorCode: '9' });
    expect(res.code).toBe('E_OFFLINE');
    expect(res.tier).toBe('Staff');
  });

  it('maps service required to E_SERVICE', () => {
    const res = translateHardwarePrinterError({ message: 'Waste ink pad full' });
    expect(res.code).toBe('E_SERVICE');
    expect(res.tier).toBe('Technician');
  });

  it('maps watchdog timeout / stall to E_STALL', () => {
    const res = translateHardwarePrinterError({ message: 'Job stalled watchdog' });
    expect(res.code).toBe('E_STALL');
    expect(res.tier).toBe('Staff');
  });

  it('preserves PAPER_JAM_PRINT for dedicated paper jam flow', () => {
    const res = translateHardwarePrinterError({ message: 'Paper jam', errorCode: '8' });
    expect(res.code).toBe('PAPER_JAM_PRINT');
  });

  it('maps unrecognized hardware issues to E_UNKNOWN', () => {
    const res = translateHardwarePrinterError({ message: 'Random internal failure', errorCode: '999' });
    expect(res.code).toBe('E_UNKNOWN');
    expect(res.tier).toBe('Staff');
  });
});
