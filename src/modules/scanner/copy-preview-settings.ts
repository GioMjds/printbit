import type { SupportedDpi } from '@/core/database/models/admin.model';

export type CopyPaperSize = 'A4' | 'Short' | 'Long';

export interface ScannerDpiConfig {
  copyGlass?: SupportedDpi;
  copyAdf?: SupportedDpi;
  scanGlass?: SupportedDpi;
  scanAdf?: SupportedDpi;
}

const DEFAULT_DPI: SupportedDpi = 300;

/** Admin DPI for a service and source. 300 when the setting is absent. */
export function resolveScannerDpi(
  cfg: ScannerDpiConfig | null | undefined,
  service: 'copy' | 'scan',
  source: 'flatbed' | 'adf' | 'glass' | 'feeder',
): SupportedDpi {
  const isAdf = source === 'adf' || source === 'feeder';
  if (service === 'copy') {
    return (isAdf ? cfg?.copyAdf : cfg?.copyGlass) ?? DEFAULT_DPI;
  }
  return (isAdf ? cfg?.scanAdf : cfg?.scanGlass) ?? DEFAULT_DPI;
}

/** Long bond does not fit the glass, so it goes through the feeder. */
export const toCopyPreviewSource = (
  paperSize: CopyPaperSize,
): 'adf' | 'flatbed' => (paperSize === 'Long' ? 'adf' : 'flatbed');

/**
 * Settings for the copy pre-scan. The pre-scan file is the file that gets
 * printed (copy never rescans), so it uses the admin copy DPI.
 */
export function buildCopyPreviewScanSettings(
  paperSize: CopyPaperSize,
  cfg: ScannerDpiConfig | null | undefined,
) {
  const source = toCopyPreviewSource(paperSize);
  return {
    source,
    dpi: resolveScannerDpi(cfg, 'copy', source),
    colorMode: 'colored' as const,
    duplex: false,
    format: 'pdf' as const,
    paperSize,
    maxPages: 1,
  };
}
