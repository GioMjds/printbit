import crypto from 'node:crypto';
import type {
  ScanFilenameDateFormat,
  ScanFilenameFormatSettings,
  ScanFilenameTimeFormat,
} from '@/core/database/models/admin.model';

export const DEFAULT_SCAN_FILENAME_FORMAT: ScanFilenameFormatSettings = {
  prefix: 'PrintBit-Scan',
  dateFormat: 'YYYYMMDD',
  timeFormat: 'HHmmss',
  includeRandomSuffix: false,
  customPatternEnabled: false,
  customPattern: '{PREFIX}_{YYYY}{MM}{DD}_{HH}{mm}{ss}',
};

export function isValidDateFormat(
  value: unknown,
): value is ScanFilenameDateFormat {
  return (
    value === 'YYYY-MM-DD' ||
    value === 'YYYYMMDD' ||
    value === 'DD-MM-YYYY' ||
    value === 'none'
  );
}

export function isValidTimeFormat(
  value: unknown,
): value is ScanFilenameTimeFormat {
  return (
    value === 'HH-mm-ss' ||
    value === 'HHmmss' ||
    value === 'HHmm' ||
    value === 'none'
  );
}

export function validateScanFilenameFormatSettings(
  incoming: unknown,
  current?: ScanFilenameFormatSettings,
): { value?: ScanFilenameFormatSettings; error?: string } {
  if (typeof incoming !== 'object' || incoming === null) {
    return { error: 'scanFilenameFormat must be an object.' };
  }

  const base = current ?? DEFAULT_SCAN_FILENAME_FORMAT;
  const raw = incoming as Partial<
    Record<keyof ScanFilenameFormatSettings, unknown>
  >;
  const next: ScanFilenameFormatSettings = { ...base };

  if (raw.prefix !== undefined) {
    if (typeof raw.prefix !== 'string') {
      return { error: 'scanFilenameFormat.prefix must be a string.' };
    }
    const trimmed = raw.prefix.trim();
    if (trimmed.length > 50) {
      return {
        error: 'scanFilenameFormat.prefix cannot exceed 50 characters.',
      };
    }
    next.prefix = trimmed;
  }

  if (raw.dateFormat !== undefined) {
    if (!isValidDateFormat(raw.dateFormat)) {
      return {
        error:
          'scanFilenameFormat.dateFormat must be "YYYY-MM-DD", "YYYYMMDD", "DD-MM-YYYY", or "none".',
      };
    }
    next.dateFormat = raw.dateFormat;
  }

  if (raw.timeFormat !== undefined) {
    if (!isValidTimeFormat(raw.timeFormat)) {
      return {
        error:
          'scanFilenameFormat.timeFormat must be "HH-mm-ss", "HHmmss", "HHmm", or "none".',
      };
    }
    next.timeFormat = raw.timeFormat;
  }

  if (raw.includeRandomSuffix !== undefined) {
    if (typeof raw.includeRandomSuffix !== 'boolean') {
      return {
        error: 'scanFilenameFormat.includeRandomSuffix must be boolean.',
      };
    }
    next.includeRandomSuffix = raw.includeRandomSuffix;
  }

  if (raw.customPatternEnabled !== undefined) {
    if (typeof raw.customPatternEnabled !== 'boolean') {
      return {
        error: 'scanFilenameFormat.customPatternEnabled must be boolean.',
      };
    }
    next.customPatternEnabled = raw.customPatternEnabled;
  }

  if (raw.customPattern !== undefined) {
    if (typeof raw.customPattern !== 'string') {
      return { error: 'scanFilenameFormat.customPattern must be a string.' };
    }
    const trimmed = raw.customPattern.trim();
    if (trimmed.length > 100) {
      return {
        error: 'scanFilenameFormat.customPattern cannot exceed 100 characters.',
      };
    }
    next.customPattern = trimmed;
  }

  return { value: next };
}

/**
 * Sanitizes a filename to prevent path traversal and remove reserved OS characters.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();

  return cleaned.length > 0 ? cleaned : 'PrintBit-Scan';
}

/**
 * Generates a clean, customer-facing scan filename according to the configured admin settings.
 */
export function formatCustomerScanFilename(
  settings: Partial<ScanFilenameFormatSettings> | null | undefined,
  extension: string,
  now: Date = new Date(),
): string {
  const cfg: ScanFilenameFormatSettings = {
    ...DEFAULT_SCAN_FILENAME_FORMAT,
    ...(settings ?? {}),
  };

  const cleanExt = extension.trim()
    ? `.${extension.trim().replace(/^\./, '').toLowerCase()}`
    : '.pdf';

  const YYYY = String(now.getFullYear());
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const DD = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const RANDOM = crypto.randomBytes(2).toString('hex').toUpperCase();
  const PREFIX = cfg.prefix?.trim() ? cfg.prefix.trim() : 'PrintBit-Scan';

  let baseName = '';

  if (cfg.customPatternEnabled && cfg.customPattern?.trim()) {
    baseName = cfg.customPattern
      .replace(/\{PREFIX\}/gi, PREFIX)
      .replace(/\{YYYY\}/g, YYYY)
      .replace(/\{MM\}/g, MM)
      .replace(/\{DD\}/g, DD)
      .replace(/\{HH\}/g, HH)
      .replace(/\{mm\}/g, mm)
      .replace(/\{ss\}/g, ss)
      .replace(/\{RANDOM\}/gi, RANDOM);
  } else {
    const parts = [];

    if (PREFIX) {
      parts.push(PREFIX);
    }

    if (cfg.dateFormat === 'YYYY-MM-DD') {
      parts.push(`${YYYY}-${MM}-${DD}`);
    } else if (cfg.dateFormat === 'YYYYMMDD') {
      parts.push(`${YYYY}${MM}${DD}`);
    } else if (cfg.dateFormat === 'DD-MM-YYYY') {
      parts.push(`${DD}-${MM}-${YYYY}`);
    }

    if (cfg.timeFormat === 'HH-mm-ss') {
      parts.push(`${HH}-${mm}-${ss}`);
    } else if (cfg.timeFormat === 'HHmmss') {
      parts.push(`${HH}${mm}${ss}`);
    } else if (cfg.timeFormat === 'HHmm') {
      parts.push(`${HH}${mm}`);
    }

    if (cfg.includeRandomSuffix) {
      parts.push(RANDOM);
    }

    baseName = parts.filter(Boolean).join('-');
  }

  const sanitized = sanitizeFilename(baseName);
  return `${sanitized}${cleanExt}`;
}
