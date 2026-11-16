/**
 * The four print settings on /copy and how they are kept in session storage.
 * Pure: no DOM, no storage access.
 */
import type { PaperSize } from '../../shared/print-configuration';
import { clampCopies, MAX_COPIES } from '../shared/copy-config';

export type CopyColorMode = 'colored' | 'grayscale';
export type CopyQuality = 'standard' | 'high';

export interface CopySettings {
  paperSize: PaperSize;
  colorMode: CopyColorMode;
  quality: CopyQuality;
  copies: number;
}

export const COPY_SETTINGS_STORAGE_KEY = 'printbit.copySettings';

export const DEFAULT_COPY_SETTINGS: Readonly<CopySettings> = Object.freeze({
  paperSize: 'A4',
  colorMode: 'colored',
  quality: 'standard',
  copies: 1,
});

/** Reads a paper size. `Letter` and `Legal` are older names still in storage. */
export function parsePaperSize(value: unknown): PaperSize | null {
  if (value === 'A4' || value === 'Short' || value === 'Long') return value;
  if (value === 'Letter') return 'Short';
  if (value === 'Legal') return 'Long';
  return null;
}

export function parseCopySettings(raw: string | null): CopySettings {
  let source: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        source = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON: every field falls back to its default.
    }
  }
  return {
    paperSize:
      parsePaperSize(source.paperSize) ?? DEFAULT_COPY_SETTINGS.paperSize,
    colorMode: source.colorMode === 'grayscale' ? 'grayscale' : 'colored',
    quality: source.quality === 'high' ? 'high' : 'standard',
    copies: clampCopies(source.copies),
  };
}

export function serializeCopySettings(settings: CopySettings): string {
  return JSON.stringify({ ...settings, copies: clampCopies(settings.copies) });
}

export function stepCopies(copies: number, delta: 1 | -1): number {
  return clampCopies(copies + delta);
}

export function copiesLimits(copies: number): {
  canDecrease: boolean;
  canIncrease: boolean;
} {
  const value = clampCopies(copies);
  return { canDecrease: value > 1, canIncrease: value < MAX_COPIES };
}
