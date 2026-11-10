import {
  buildCopyPreviewScanSettings,
  resolveScannerDpi,
} from './copy-preview-settings';

describe('resolveScannerDpi', () => {
  const cfg = { copyGlass: 150, copyAdf: 600, scanGlass: 300, scanAdf: 150 } as const;

  it('reads the copy settings for the copy service', () => {
    expect(resolveScannerDpi(cfg, 'copy', 'flatbed')).toBe(150);
    expect(resolveScannerDpi(cfg, 'copy', 'adf')).toBe(600);
    expect(resolveScannerDpi(cfg, 'copy', 'glass')).toBe(150);
    expect(resolveScannerDpi(cfg, 'copy', 'feeder')).toBe(600);
  });

  it('reads the scan settings for the scan service', () => {
    expect(resolveScannerDpi(cfg, 'scan', 'flatbed')).toBe(300);
    expect(resolveScannerDpi(cfg, 'scan', 'adf')).toBe(150);
  });

  it('defaults to 300 when nothing is configured', () => {
    expect(resolveScannerDpi(undefined, 'copy', 'flatbed')).toBe(300);
    expect(resolveScannerDpi({}, 'copy', 'adf')).toBe(300);
  });
});

describe('buildCopyPreviewScanSettings', () => {
  it('uses the admin copy DPI for the glass', () => {
    const settings = buildCopyPreviewScanSettings('A4', {
      copyGlass: 600,
      copyAdf: 150,
    });

    expect(settings.source).toBe('flatbed');
    expect(settings.dpi).toBe(600);
  });

  it('routes Long to the ADF and uses the admin copy ADF DPI', () => {
    const settings = buildCopyPreviewScanSettings('Long', {
      copyGlass: 600,
      copyAdf: 150,
    });

    expect(settings.source).toBe('adf');
    expect(settings.dpi).toBe(150);
    expect(settings.paperSize).toBe('Long');
  });

  it('keeps the rest of the pre-scan contract', () => {
    expect(buildCopyPreviewScanSettings('Short', undefined)).toEqual({
      source: 'flatbed',
      dpi: 300,
      colorMode: 'colored',
      duplex: false,
      format: 'pdf',
      paperSize: 'Short',
      maxPages: 1,
    });
  });
});
