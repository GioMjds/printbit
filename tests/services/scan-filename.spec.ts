import {
  formatCustomerScanFilename,
  sanitizeFilename,
  DEFAULT_SCAN_FILENAME_FORMAT,
  validateScanFilenameFormatSettings,
  isValidDateFormat,
  isValidTimeFormat,
} from '@/services/scan-filename';

describe('scan-filename service', () => {
  const fixedDate = new Date(2026, 8, 12, 11, 4, 30); // 2026-09-12 11:04:30

  it('formats with default preset (YYYYMMDD-HHmmss)', () => {
    const filename = formatCustomerScanFilename(DEFAULT_SCAN_FILENAME_FORMAT, 'pdf', fixedDate);
    expect(filename).toBe('PrintBit-Scan-20260912-110430.pdf');
  });

  it('formats with hyphenated date and time (YYYY-MM-DD and HH-mm-ss)', () => {
    const filename = formatCustomerScanFilename(
      {
        prefix: 'ScanDoc',
        dateFormat: 'YYYY-MM-DD',
        timeFormat: 'HH-mm-ss',
        includeRandomSuffix: false,
        customPatternEnabled: false,
      },
      'jpg',
      fixedDate,
    );
    expect(filename).toBe('ScanDoc-2026-09-12-11-04-30.jpg');
  });

  it('formats with DD-MM-YYYY date format', () => {
    const filename = formatCustomerScanFilename(
      {
        prefix: 'Receipt',
        dateFormat: 'DD-MM-YYYY',
        timeFormat: 'none',
        includeRandomSuffix: false,
        customPatternEnabled: false,
      },
      '.png',
      fixedDate,
    );
    expect(filename).toBe('Receipt-12-09-2026.png');
  });

  it('supports custom pattern with all tokens', () => {
    const filename = formatCustomerScanFilename(
      {
        prefix: 'MyKiosk',
        customPatternEnabled: true,
        customPattern: '{PREFIX}_{YYYY}_{MM}_{DD}T{HH}{mm}{ss}',
      },
      'pdf',
      fixedDate,
    );
    expect(filename).toBe('MyKiosk_2026_09_12T110430.pdf');
  });

  it('includes random 4-char suffix when enabled', () => {
    const filename = formatCustomerScanFilename(
      {
        prefix: 'Doc',
        dateFormat: 'YYYYMMDD',
        timeFormat: 'none',
        includeRandomSuffix: true,
        customPatternEnabled: false,
      },
      'pdf',
      fixedDate,
    );
    expect(filename).toMatch(/^Doc-20260912-[0-9A-F]{4}\.pdf$/);
  });

  it('sanitizes illegal path and OS characters', () => {
    const cleaned = sanitizeFilename('Doc/With:Illegal*Chars?|<test>');
    expect(cleaned).toBe('Doc-With-Illegal-Chars-test');
  });

  it('handles empty settings gracefully with fallback defaults', () => {
    const filename = formatCustomerScanFilename(null, '', fixedDate);
    expect(filename).toBe('PrintBit-Scan-20260912-110430.pdf');
  });

  describe('validation', () => {
    it('validates date formats', () => {
      expect(isValidDateFormat('YYYY-MM-DD')).toBe(true);
      expect(isValidDateFormat('YYYYMMDD')).toBe(true);
      expect(isValidDateFormat('DD-MM-YYYY')).toBe(true);
      expect(isValidDateFormat('none')).toBe(true);
      expect(isValidDateFormat('invalid')).toBe(false);
    });

    it('validates time formats', () => {
      expect(isValidTimeFormat('HH-mm-ss')).toBe(true);
      expect(isValidTimeFormat('HHmmss')).toBe(true);
      expect(isValidTimeFormat('HHmm')).toBe(true);
      expect(isValidTimeFormat('none')).toBe(true);
      expect(isValidTimeFormat('invalid')).toBe(false);
    });

    it('validates valid settings payload', () => {
      const res = validateScanFilenameFormatSettings({
        prefix: 'KioskScan',
        dateFormat: 'YYYY-MM-DD',
        timeFormat: 'HHmm',
        includeRandomSuffix: true,
        customPatternEnabled: false,
      });
      expect(res.error).toBeUndefined();
      expect(res.value?.prefix).toBe('KioskScan');
      expect(res.value?.dateFormat).toBe('YYYY-MM-DD');
      expect(res.value?.timeFormat).toBe('HHmm');
      expect(res.value?.includeRandomSuffix).toBe(true);
    });

    it('rejects invalid payload types and values', () => {
      expect(validateScanFilenameFormatSettings(null).error).toBeDefined();
      expect(validateScanFilenameFormatSettings({ prefix: 'a'.repeat(60) }).error).toBeDefined();
      expect(validateScanFilenameFormatSettings({ dateFormat: 'bad' }).error).toBeDefined();
      expect(validateScanFilenameFormatSettings({ timeFormat: 'bad' }).error).toBeDefined();
      expect(validateScanFilenameFormatSettings({ includeRandomSuffix: 'true' }).error).toBeDefined();
      expect(validateScanFilenameFormatSettings({ customPatternEnabled: 'false' }).error).toBeDefined();
      expect(validateScanFilenameFormatSettings({ customPattern: 'x'.repeat(120) }).error).toBeDefined();
    });
  });
});
