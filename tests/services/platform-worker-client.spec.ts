import { getPlatformWorkerFlags } from '../../src/config/platform-worker.config';
import {
  PlatformWorkerClient,
  DefenderHealthWorkerResponse,
  FileSecurityWorkerResponse,
  ListUsbDrivesWorkerResponse,
  ExportScanToUsbWorkerResponse,
  TrustedTimeWorkerResponse,
  NetworkPlatformWorkerResponse,
} from '../../src/services/platform-worker-client';

describe('platform-worker-client', () => {
  describe('getPlatformWorkerFlags', () => {
    it('defaults all flags to false when env is empty', () => {
      const flags = getPlatformWorkerFlags({});
      expect(flags).toEqual({
        defender: false,
        usb: false,
        trustedTime: false,
        networking: false,
      });
    });

    it.each(['true', '1', 'yes', 'TRUE', 'Yes'])(
      'enables flags with value %s',
      (val) => {
        const flags = getPlatformWorkerFlags({
          PRINTBIT_WORKER_DEFENDER_ENABLED: val,
          PRINTBIT_WORKER_USB_ENABLED: val,
          PRINTBIT_WORKER_TRUSTED_TIME_ENABLED: val,
          PRINTBIT_WORKER_NETWORKING_ENABLED: val,
        });
        expect(flags).toEqual({
          defender: true,
          usb: true,
          trustedTime: true,
          networking: true,
        });
      },
    );

    it.each(['false', '0', 'no', 'off', 'enabled', 'random'])(
      'treats invalid value %s as false',
      (val) => {
        const flags = getPlatformWorkerFlags({
          PRINTBIT_WORKER_DEFENDER_ENABLED: val,
          PRINTBIT_WORKER_USB_ENABLED: val,
          PRINTBIT_WORKER_TRUSTED_TIME_ENABLED: val,
          PRINTBIT_WORKER_NETWORKING_ENABLED: val,
        });
        expect(flags).toEqual({
          defender: false,
          usb: false,
          trustedTime: false,
          networking: false,
        });
      },
    );
  });

  describe('PlatformWorkerClient', () => {
    let sendRequestMock: jest.Mock;
    let loggerMock: { warn: jest.Mock; error: jest.Mock; log: jest.Mock };
    let client: PlatformWorkerClient;

    beforeEach(() => {
      sendRequestMock = jest.fn();
      loggerMock = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
      client = new PlatformWorkerClient({
        sendRequest: sendRequestMock,
        logger: loggerMock,
        defenderTimeoutMs: 25000,
      });
    });

    it('getDefenderHealth sends GetDefenderHealth and returns validated response', async () => {
      const expected: DefenderHealthWorkerResponse = {
        requestId: 'def-1',
        type: 'GetDefenderHealth',
        success: true,
        status: 'clean',
        signatureAgeHours: 1.2,
      };
      sendRequestMock.mockResolvedValue(expected);

      const result = await client.getDefenderHealth();
      expect(result).toEqual(expected);
      expect(sendRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'GetDefenderHealth',
          requestId: expect.any(String),
        }),
        expect.objectContaining({ timeoutMs: 15000 }),
      );
    });

    it('scanFileSecurity sends ScanFileSecurity with custom defender timeout', async () => {
      const expected: FileSecurityWorkerResponse = {
        requestId: 'sec-1',
        type: 'ScanFileSecurity',
        success: true,
        status: 'clean',
      };
      sendRequestMock.mockResolvedValue(expected);

      const result = await client.scanFileSecurity('C:\\PrintBit\\uploads\\file.pdf');
      expect(result).toEqual(expected);
      expect(sendRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ScanFileSecurity',
          filePath: 'C:\\PrintBit\\uploads\\file.pdf',
          requestId: expect.any(String),
        }),
        expect.objectContaining({ timeoutMs: 25000 }),
      );
    });

    it('listUsbDrives sends ListUsbDrives and parses response', async () => {
      const expected: ListUsbDrivesWorkerResponse = {
        requestId: 'usb-1',
        type: 'ListUsbDrives',
        success: true,
        drives: [{ drive: 'E:', label: 'FLASH', freeBytes: 100, totalBytes: 200 }],
      };
      sendRequestMock.mockResolvedValue(expected);

      const result = await client.listUsbDrives();
      expect(result).toEqual(expected);
    });

    it('exportScanToUsb sends ExportScanToUsb and parses response', async () => {
      const expected: ExportScanToUsbWorkerResponse = {
        requestId: 'usb-2',
        type: 'ExportScanToUsb',
        success: true,
        exportPath: 'E:\\PrintBit\\Scans\\1.pdf',
        drive: 'E:',
      };
      sendRequestMock.mockResolvedValue(expected);

      const result = await client.exportScanToUsb('C:\\PrintBit\\scans\\1.pdf', 'E:');
      expect(result).toEqual(expected);
      expect(sendRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ExportScanToUsb',
          sourcePath: 'C:\\PrintBit\\scans\\1.pdf',
          drive: 'E:',
        }),
        expect.anything(),
      );
    });

    it('getTrustedTimeStatus sends GetTrustedTimeStatus and parses response', async () => {
      const expected: TrustedTimeWorkerResponse = {
        requestId: 'time-1',
        type: 'GetTrustedTimeStatus',
        success: true,
        source: 'ntp',
        synced: true,
        driftExceeded: false,
        maxDriftMs: 60000,
        checkedAt: new Date().toISOString(),
      };
      sendRequestMock.mockResolvedValue(expected);

      const result = await client.getTrustedTimeStatus({ ntpServer: 'time.windows.com', maxDriftMs: 60000 });
      expect(result).toEqual(expected);
      expect(sendRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'GetTrustedTimeStatus',
          ntpServer: 'time.windows.com',
          maxDriftMs: 60000,
        }),
        expect.anything(),
      );
    });

    it('prepareHotspotPlatform sends PrepareHotspotPlatform and parses response', async () => {
      const expected: NetworkPlatformWorkerResponse = {
        requestId: 'net-1',
        type: 'PrepareHotspotPlatform',
        success: true,
        kioskIp: '192.168.4.1',
        firewallReady: true,
      };
      sendRequestMock.mockResolvedValue(expected);

      const result = await client.prepareHotspotPlatform({
        preferredSubnetPrefixes: ['192.168.4.'],
        port: 3000,
      });
      expect(result).toEqual(expected);
      expect(sendRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PrepareHotspotPlatform',
          preferredSubnetPrefixes: ['192.168.4.'],
          port: 3000,
        }),
        expect.anything(),
      );
    });

    it('returns null and warns when response is null or malformed', async () => {
      sendRequestMock.mockResolvedValue(null);
      expect(await client.getDefenderHealth()).toBeNull();

      sendRequestMock.mockResolvedValue({ success: true }); // missing requestId & type
      expect(await client.getDefenderHealth()).toBeNull();
      expect(loggerMock.warn).toHaveBeenCalled();

      sendRequestMock.mockResolvedValue({ requestId: 'r1', type: 'WrongType', success: true });
      expect(await client.getDefenderHealth()).toBeNull();
    });
  });
});
