import { DEFAULT_PRINT_SCALING } from '../../shared/print-configuration';

export type PageRangeSelection =
  | { type: 'all' }
  | { type: 'custom'; range: string }
  | { type: 'single'; page: number };

export interface PhysicalPrintSelection {
  copies: number;
  quality?: 'standard' | 'high';
  orientation: 'portrait' | 'landscape';
  rotationDeg?: number;
  paperSize: 'A4' | 'Letter' | 'Legal';
  pageRange?: PageRangeSelection;
}

export function buildPhysicalPrintSettings(
  selection: PhysicalPrintSelection,
  colorMode: 'colored' | 'grayscale',
) {
  return {
    copies: selection.copies,
    colorMode,
    quality: selection.quality ?? 'standard',
    orientation: selection.orientation,
    rotationDeg: selection.rotationDeg ?? 0,
    paperSize: selection.paperSize,
    scaling: DEFAULT_PRINT_SCALING,
    pageRange: selection.pageRange ?? { type: 'all' as const },
  };
}
