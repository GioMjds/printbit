export interface BalanceResponseDto {
  balance: number;
  earnings: number;
}

export interface PricingResponseDto {
  printPerPage: number;
  copyPerPage: number;
  scanDocument: number;
  colorSurcharge: number;
}

export interface PaymentResultResponseDto {
  chargedAmount: number;
  remainingBalance: number;
  changeDispensed: number;
}

export interface ScannerStatusResponseDto {
  isAvailable: boolean;
  deviceName?: string;
  error?: string;
}

export interface StartScanResponseDto {
  filePath: string;
}

export interface UploadSessionResponseDto {
  sessionId: string;
  token: string;
  uploadUrl: string;
  status: 'pending' | 'uploaded';
}

export interface AdminSummaryResponseDto {
  balance: number;
  earnings: number;
  printerOnline: boolean;
  scannerAvailable: boolean;
}
