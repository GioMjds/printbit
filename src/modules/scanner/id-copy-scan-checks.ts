import type { IdSide } from '@/shared/id-card-layout';
import type { IdScanWarning } from '@/shared/id-copy-contract';

/**
 * Gray-level spread under this means "nothing on the glass". Empty glass scans
 * as an even light gray. Tune on the real scanner (see the hardware checklist).
 */
export const ID_BLANK_STDDEV_THRESHOLD = 6;
/** Mean gray difference under this means "the same side twice". Tune likewise. */
export const ID_IDENTICAL_MEAN_DIFF_THRESHOLD = 8;
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

export function meanAbsoluteDifference(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 255;
  let total = 0;
  for (let i = 0; i < length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / length;
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
    if (
      meanAbsoluteDifference(scanned, other) < ID_IDENTICAL_MEAN_DIFF_THRESHOLD
    ) {
      return [{ code: 'sides_identical', side: input.scannedSide }];
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
