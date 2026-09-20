import { randomBytes } from 'node:crypto';
import { db } from './db';

/**
 * Generates a random alphanumeric suffix of the specified length.
 */
function generateRandomSuffix(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/**
 * Formats a Date into a date string based on the configured dateFormat.
 */
function formatDate(
  now: Date,
  dateFormat: 'YYYYMMDD' | 'YYYY-MM-DD' | 'none',
): string {
  if (dateFormat === 'none') return '';
  const YYYY = String(now.getFullYear());
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const DD = String(now.getDate()).padStart(2, '0');
  if (dateFormat === 'YYYY-MM-DD') return `${YYYY}-${MM}-${DD}`;
  return `${YYYY}${MM}${DD}`;
}

/**
 * Formats the current time as HHmmss.
 */
function formatTime(now: Date): string {
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${HH}${mm}${ss}`;
}

/**
 * Generates a structured transaction ID based on the admin-configured
 * transactionIdFormat settings. Falls back to a simple UUID-based ID if
 * settings are unavailable.
 */
export function formatTransactionId(jobType?: string): string {
  const settings = db.data?.settings?.transactionIdFormat;

  if (!settings) {
    // Fallback: deterministic random hex if settings not available
    return randomBytes(8).toString('hex').toUpperCase();
  }

  const now = new Date();
  const prefix = (settings.prefix ?? 'TXN').trim() || 'TXN';
  const modeStr = (jobType ?? '').trim().toUpperCase();
  const dateStr = formatDate(now, settings.dateFormat ?? 'YYYYMMDD');
  const timeStr = settings.includeTime ? formatTime(now) : '';
  const randomLen = Math.max(2, Math.min(12, settings.randomSuffixLength ?? 4));
  const randomStr = generateRandomSuffix(randomLen);

  if (settings.customPatternEnabled && settings.customPattern?.trim()) {
    const YYYY = String(now.getFullYear());
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    return settings.customPattern
      .replace(/\{PREFIX\}/gi, prefix)
      .replace(/\{MODE\}/gi, modeStr)
      .replace(/\{DATE\}/gi, dateStr || `${YYYY}${MM}${DD}`)
      .replace(/\{YYYY\}/g, YYYY)
      .replace(/\{MM\}/g, MM)
      .replace(/\{DD\}/g, DD)
      .replace(/\{HH\}/g, HH)
      .replace(/\{mm\}/g, mm)
      .replace(/\{ss\}/g, ss)
      .replace(/\{RANDOM\}/gi, randomStr)
      .replace(/[^A-Za-z0-9\-_.]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      || randomBytes(8).toString('hex').toUpperCase();
  }

  // Standard format: PREFIX-DATE[-TIME]-RANDOM
  const parts: string[] = [prefix];
  if (dateStr) parts.push(dateStr);
  if (timeStr) parts.push(timeStr);
  parts.push(randomStr);

  return parts.join('-');
}
