import { Injectable } from '@nestjs/common';
import { IUsbDrivePort, UsbDrive } from '@/application/ports';
import { exportScanToUsbDrive, listRemovableDrives } from '@/services';

@Injectable()
export class UsbDriveAdapter implements IUsbDrivePort {
  async listDrives(): Promise<UsbDrive[]> {
    const drives = await listRemovableDrives();
    return drives.map((drive) => ({
      letter: drive.drive,
      label: drive.label ?? undefined,
    }));
  }

  async exportFile(filePath: string, driveLetter: string): Promise<string> {
    const result = await exportScanToUsbDrive(filePath, driveLetter);
    return result.exportPath;
  }
}
