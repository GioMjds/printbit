/**
 * The `printbit.config` object for a copy job. /copy writes it and /confirm
 * reads it. Field names match what /config wrote for copy mode.
 */
import {
  DEFAULT_PRINT_SCALING,
  type Orientation,
  type PaperSize,
} from '../../shared/print-configuration';

export const MAX_COPIES = 30;

export interface CopyConfigInput {
  previewPath: string;
  releaseToken: string | null;
  paperSize: PaperSize;
  orientation: Orientation;
  colorMode: 'colored' | 'grayscale';
  quality: 'standard' | 'high';
  copies: number;
}

export function clampCopies(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(MAX_COPIES, Math.max(1, Math.floor(numeric)));
}

export function buildCopyConfig(input: CopyConfigInput) {
  return {
    scaling: DEFAULT_PRINT_SCALING,
    mode: 'copy' as const,
    sessionId: null,
    documentId: null,
    filename: null,
    scanFilename: null,
    scanReleaseToken: null,
    copyPreviewPath: input.previewPath,
    copyPreviewReleaseToken: input.releaseToken,
    detectedColorMode: null,
    colorMode: input.colorMode,
    quality: input.quality,
    duplex: false,
    copies: clampCopies(input.copies),
    orientation: input.orientation,
    rotationDeg: 0 as const,
    paperSize: input.paperSize,
    pageRange: { type: 'all' as const },
    totalPages: 1,
  };
}
