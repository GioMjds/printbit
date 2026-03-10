export interface PrintOptions {
  filePath: string;
  copies: number;
  colorMode: 'colored' | 'grayscale';
  pageRange?: string;
  paperSize?: string;
  orientation?: 'portrait' | 'landscape';
}

export interface IPrinterPort {
  print(options: PrintOptions): Promise<void>;
}
