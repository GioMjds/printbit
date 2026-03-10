export interface ScannerInfo {
  isAvailable: boolean;
  deviceName?: string;
  error?: string;
}

export interface ScanOptions {
  outputPath: string;
  format: 'pdf' | 'jpg' | 'png';
  dpi: 100 | 150 | 200 | 300;
  colorMode: 'colored' | 'grayscale';
  source: 'flatbed' | 'adf';
}

export interface IScannerPort {
  probe(): Promise<ScannerInfo>;
  scan(options: ScanOptions): Promise<string>;
}
