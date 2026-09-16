export type Orientation = 'portrait' | 'landscape';
export type PaperSize = 'A4' | 'Letter' | 'Legal';

export interface DocumentDimensions {
  width: number;
  height: number;
}

/**
 * Detects whether dimensions are portrait or landscape.
 * Returns null if dimensions are invalid or non-positive.
 */
export function detectOrientationFromDimensions(
  width: number,
  height: number,
): Orientation | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return width > height ? 'landscape' : 'portrait';
}

/**
 * Detects paper size from document dimensions in points (72 DPI).
 * - Legal: long dimension > 880 pt (e.g. Long Bond @ 936 pt, US Legal @ 1008 pt)
 * - Letter: long dimension < 815 pt (e.g. US Letter @ 792 pt)
 * - A4: otherwise (e.g. A4 @ ~842 pt)
 */
export function detectPaperSizeFromDimensions(
  width: number,
  height: number,
): PaperSize | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const longDim = Math.max(width, height);
  if (longDim > 880) return 'Legal';
  if (longDim < 815) return 'Letter';
  return 'A4';
}
