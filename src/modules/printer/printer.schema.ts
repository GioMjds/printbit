/**
 * Printer module schemas and types.
 */

export interface InkHistoryEntry {
  id: string;
  timestamp: string;
  printerName: string | null;
  printerStatus: string;
  inkDetectionMethod:
    | 'snmp'
    | 'vendor-wmi'
    | 'printer-property'
    | 'error-state'
    | 'none';
  inkTelemetryAvailable: boolean;
  inkTelemetryReason: string | null;
  supplies: {
    name: string;
    level: number | null;
    status: 'ok' | 'low' | 'empty' | 'unknown';
  }[];
}

export type Orientation = 'portrait' | 'landscape';
export type PaperSize = 'letter' | 'a4' | 'legal';

export interface PrintJobOptions {
  copies?: number;
  colorMode?: 'color' | 'grayscale';
  orientation?: Orientation;
  paperSize?: PaperSize;
  duplex?: boolean;
}
