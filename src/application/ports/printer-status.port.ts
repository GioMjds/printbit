export interface PrinterStatus {
  isOnline: boolean;
  status: string;
  details?: string;
}

export interface IPrinterStatusPort {
  getStatus(): Promise<PrinterStatus>;
}
