import type { IdSide } from '@/shared/id-card-layout';
import type { IdScanWarning } from '@/shared/id-copy-contract';

/**
 * Gray-level spread under this means "nothing on the glass". Empty glass scans
 * as an even light gray. Tune on the real scanner (see the hardware checklist).
 */
export const ID_BLANK_STDDEV_THRESHOLD = 6;
/** A thumbnail cell this far from the glass gray holds part of a card. Tune likewise. */
export const ID_CARD_CELL_GRAY_DELTA = 30;
/**
 * Card cells both sides share at or above this mean the sides overlap on the
 * merged sheet (one cell is about 9 mm of glass). Tune likewise.
 */
export const ID_OVERLAP_MIN_CELLS = 3;
export const ID_CHECK_TIMEOUT_MS = 5000;

export function grayStandardDeviation(thumbnail: Uint8Array): number {
  if (thumbnail.length === 0) return 0;
  let sum = 0;
  for (const value of thumbnail) sum += value;
  const mean = sum / thumbnail.length;
  let squares = 0;
  for (const value of thumbnail) squares += (value - mean) ** 2;
  return Math.sqrt(squares / thumbnail.length);
}

/** Gray of the empty glass: the median, since a card covers little of it. */
function glassGray(thumbnail: Uint8Array): number {
  const sorted = Array.from(thumbnail).sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 255;
}

/**
 * Cells where both scans show something other than glass. Both scans are
 * stacked at the same place on the sheet, so shared cells overlap on paper.
 */
export function sharedCardCells(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  const glassA = glassGray(a);
  const glassB = glassGray(b);
  let shared = 0;
  for (let i = 0; i < length; i += 1) {
    if (
      Math.abs(a[i] - glassA) > ID_CARD_CELL_GRAY_DELTA &&
      Math.abs(b[i] - glassB) > ID_CARD_CELL_GRAY_DELTA
    ) {
      shared += 1;
    }
  }
  return shared;
}

export interface IdScanCheckInput {
  scannedSide: IdSide;
  frontPath: string | null;
  backPath: string | null;
}

export interface IdScanCheckDeps {
  thumbnail(filePath: string): Promise<Uint8Array>;
  timeoutMs?: number;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ID scan check timed out')),
      timeoutMs,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Warnings for the side just scanned. Never throws: a failed or slow check
 * yields no warning, because a warning must never cost the customer a scan.
 */
export async function checkIdScan(
  input: IdScanCheckInput,
  deps: IdScanCheckDeps,
): Promise<IdScanWarning[]> {
  const scannedPath =
    input.scannedSide === 'front' ? input.frontPath : input.backPath;
  const otherPath =
    input.scannedSide === 'front' ? input.backPath : input.frontPath;
  if (!scannedPath) return [];
  const timeoutMs = deps.timeoutMs ?? ID_CHECK_TIMEOUT_MS;

  try {
    const scanned = await withTimeout(deps.thumbnail(scannedPath), timeoutMs);
    if (grayStandardDeviation(scanned) < ID_BLANK_STDDEV_THRESHOLD) {
      return [{ code: 'side_blank', side: input.scannedSide }];
    }
    if (!otherPath) return [];
    const other = await withTimeout(deps.thumbnail(otherPath), timeoutMs);
    // shortcut: compares the scans as placed on the glass and ignores the
    // rotate buttons; compare rotated thumbnails if customers rotate a lot.
    if (sharedCardCells(scanned, other) >= ID_OVERLAP_MIN_CELLS) {
      return [{ code: 'sides_overlap', side: input.scannedSide }];
    }
    return [];
  } catch (error) {
    console.warn(
      '[ID-COPY] Scan check skipped:',
      error instanceof Error ? error.message : 'unknown error',
    );
    return [];
  }
}
