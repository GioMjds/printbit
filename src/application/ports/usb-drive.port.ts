export interface UsbDrive {
  letter: string;
  label?: string;
}

export interface IUsbDrivePort {
  listDrives(): Promise<UsbDrive[]>;
  exportFile(filePath: string, driveLetter: string): Promise<string>;
}
