export interface ConfirmPaymentRequestDto {
  filePath: string;
  pages: number;
  colorMode: 'colored' | 'grayscale';
  copies?: number;
  idempotencyKey?: string;
}

export interface AddTestCoinRequestDto {
  value: 1 | 5 | 10 | 20;
}

export interface StartScanRequestDto {
  source: 'flatbed' | 'adf';
  colorMode: 'colored' | 'grayscale';
  dpi: 100 | 150 | 200 | 300;
  format: 'pdf' | 'jpg' | 'png';
}

export interface ExportScanToUsbRequestDto {
  filePath: string;
  driveLetter: string;
}

export interface StartCopyJobRequestDto {
  previewPath: string;
  copies: number;
  colorMode: 'colored' | 'grayscale';
  idempotencyKey?: string;
}

export interface UploadFileToSessionRequestDto {
  sessionId: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  filename: string;
  filePath: string;
}

export interface UpdateAdminSettingsRequestDto {
  printPerPage: number;
  copyPerPage: number;
  scanDocument: number;
  colorSurcharge: number;
  idleTimeoutSeconds: number;
  adminPin: string;
  adminLocalOnly: boolean;
  hopperEnabled: boolean;
  hopperTimeoutMs: number;
  hopperRetryCount: number;
}
