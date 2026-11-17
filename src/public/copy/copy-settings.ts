/**
 * The four print settings on /copy and how they are kept in session storage.
 * Pure: no DOM, no storage access.
 */
import type { IdRotation, IdSide } from '../../shared/id-card-layout';
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

/** What the current ID sheet was built with. */
export interface SheetSpec {
  paperSize: PaperSize;
  rotations: Record<IdSide, IdRotation>;
}

function parseRotation(value: unknown): IdRotation | null {
  return value === 0 || value === 90 || value === 180 || value === 270
    ? value
    : null;
}

/** Null when nothing is stored or any field is invalid. */
export function parseSheetSpec(raw: string | null): SheetSpec | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const source = parsed as Record<string, unknown>;
  const paperSize = parsePaperSize(source.paperSize);
  const rotations = source.rotations;
  if (!paperSize || typeof rotations !== 'object' || rotations === null) {
    return null;
  }
  const front = parseRotation((rotations as Record<string, unknown>).front);
  const back = parseRotation((rotations as Record<string, unknown>).back);
  if (front === null || back === null) return null;
  return { paperSize, rotations: { front, back } };
}

export function serializeSheetSpec(spec: SheetSpec): string {
  return JSON.stringify(spec);
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
