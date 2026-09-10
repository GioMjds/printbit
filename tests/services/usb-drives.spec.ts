import {
  createUsbDriveService,
  listRemovableDrives,
  exportScanToUsbDrive,
} from '../../src/services/usb-drives';
import type { PlatformWorkerClient } from '../../src/services/platform-worker-client';

describe('usb-drives', () => {
  let runPowerShellMock: jest.Mock;
  let loggerMock: { warn: jest.Mock; error: jest.Mock; log: jest.Mock };
  let workerClientMock: {
    listUsbDrives: jest.Mock;
    exportScanToUsb: jest.Mock;
  };

  beforeEach(() => {
    runPowerShellMock = jest.fn();
    loggerMock = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    workerClientMock = {
      listUsbDrives: jest.fn(),
      exportScanToUsb: jest.fn(),
    };
  });

  describe('legacy backend (flag disabled)', () => {
    it('queries PowerShell and normalizes drives', async () => {
      runPowerShellMock.mockResolvedValue(
        JSON.stringify([
          { DeviceID: 'F:', VolumeName: 'BACKUP', FreeSpace: 500, Size: 1000 },
          { DeviceID: 'E:', VolumeName: 'STICK', FreeSpace: 200, Size: 400 },
        ]),
      );

      const service = createUsbDriveService({
        env: {},
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      const drives = await service.listRemovable();
      expect(drives).toEqual([
        { drive: 'E:', label: 'STICK', freeBytes: 200, totalBytes: 400 },
        { drive: 'F:', label: 'BACKUP', freeBytes: 500, totalBytes: 1000 },
      ]);
      expect(runPowerShellMock).toHaveBeenCalled();
      expect(workerClientMock.listUsbDrives).not.toHaveBeenCalled();
    });

    it('returns empty array when PowerShell output is empty', async () => {
      runPowerShellMock.mockResolvedValue('');

      const service = createUsbDriveService({
        env: {},
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      const drives = await service.listRemovable();
      expect(drives).toEqual([]);
    });
  });

  describe('worker backend (flag enabled)', () => {
    it('returns empty list authoritatively without calling PowerShell', async () => {
      workerClientMock.listUsbDrives.mockResolvedValue({
        requestId: 'usb-1',
        type: 'ListUsbDrives',
        success: true,
        drives: [],
      });

      const service = createUsbDriveService({
        env: { PRINTBIT_WORKER_USB_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      const drives = await service.listRemovable();
      expect(drives).toEqual([]);
      expect(runPowerShellMock).not.toHaveBeenCalled();
      expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    it('returns populated drive list from worker without calling PowerShell', async () => {
      workerClientMock.listUsbDrives.mockResolvedValue({
        requestId: 'usb-2',
        type: 'ListUsbDrives',
        success: true,
        drives: [
          { drive: 'G:', label: 'KINGSTON', freeBytes: 12345, totalBytes: 67890 },
        ],
      });

      const service = createUsbDriveService({
        env: { PRINTBIT_WORKER_USB_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      const drives = await service.listRemovable();
      expect(drives).toEqual([
        { drive: 'G:', label: 'KINGSTON', freeBytes: 12345, totalBytes: 67890 },
      ]);
      expect(runPowerShellMock).not.toHaveBeenCalled();
    });

    it('falls back to PowerShell when worker returns NOT_IMPLEMENTED', async () => {
      workerClientMock.listUsbDrives.mockResolvedValue({
        requestId: 'usb-3',
        type: 'ListUsbDrives',
        success: false,
        errorCode: 'NOT_IMPLEMENTED',
        message: 'Scaffolded',
      });
      runPowerShellMock.mockResolvedValue(
        JSON.stringify([{ DeviceID: 'E:', VolumeName: 'STICK', FreeSpace: 100, Size: 200 }]),
      );

      const service = createUsbDriveService({
        env: { PRINTBIT_WORKER_USB_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      const drives = await service.listRemovable();
      expect(drives).toHaveLength(1);
      expect(drives[0].drive).toBe('E:');
      expect(runPowerShellMock).toHaveBeenCalled();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('[USB] Worker backend unavailable; using temporary Node fallback.'),
      );
    });

    it('exportScanTo returns worker result on success', async () => {
      workerClientMock.exportScanToUsb.mockResolvedValue({
        requestId: 'usb-4',
        type: 'ExportScanToUsb',
        success: true,
        exportPath: 'E:\\PrintBit\\Scans\\doc.pdf',
        drive: 'E:',
      });

      const service = createUsbDriveService({
        env: { PRINTBIT_WORKER_USB_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      const result = await service.exportScanTo('C:\\test.pdf', 'E:');
      expect(result).toEqual({
        exportPath: 'E:\\PrintBit\\Scans\\doc.pdf',
        drive: 'E:',
      });
      expect(workerClientMock.exportScanToUsb).toHaveBeenCalledWith('C:\\test.pdf', 'E:');
    });

    it('exportScanTo throws DRIVE_NOT_FOUND error without fallback', async () => {
      workerClientMock.exportScanToUsb.mockResolvedValue({
        requestId: 'usb-5',
        type: 'ExportScanToUsb',
        success: false,
        errorCode: 'DRIVE_NOT_FOUND',
        message: 'Drive not found',
      });

      const service = createUsbDriveService({
        env: { PRINTBIT_WORKER_USB_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      await expect(service.exportScanTo('C:\\test.pdf', 'E:')).rejects.toThrow(
        /USB drive not found. Please reinsert and refresh./,
      );
      expect(runPowerShellMock).not.toHaveBeenCalled();
    });
  });
});
