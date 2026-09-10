import type { Request, Response } from 'express';

let mockScannerRuntime = { connected: true, usingStub: false };

const mockAdapter = {
  probe: jest.fn(),
  scan: jest.fn().mockResolvedValue({
    outputPath: 'package.json',
    pageCount: 1,
    format: 'pdf',
  }),
  cancel: jest.fn(),
};

jest.mock('../../src/services/scanner', () => ({
  getAdapter: jest.fn(() => mockAdapter),
  getScannerStatus: jest.fn(() => mockScannerRuntime),
}));

jest.mock('../../src/services/admin', () => ({
  adminService: {
    appendAdminLog: jest.fn(),
    incrementJobStats: jest.fn().mockResolvedValue(undefined),
  },
}));

import { ScannerService } from '../../src/modules/scanner/scanner.service';
import { ScannerController } from '../../src/modules/scanner/scanner.controller';

function createMockResponse() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

describe('ScannerService paper-size contract', () => {
  const service = new ScannerService();

  beforeEach(() => {
    mockAdapter.scan.mockClear();
    mockScannerRuntime = { connected: true, usingStub: false };
  });

  it.each([
    ['A4', 'flatbed'],
    ['Letter', 'flatbed'],
    ['Legal', 'adf'],
  ] as const)('uses %s preview source %s', async (paperSize, source) => {
    await service.previewScan(paperSize);
    expect(mockAdapter.scan).toHaveBeenCalledWith(
      expect.objectContaining({ source, paperSize }),
      'uploads/scans',
    );
  });

  it('rejects an unknown paper size', async () => {
    await expect(
      service.interactiveScan({
        source: 'feeder',
        color: 'color',
        dpi: '300',
        paperSize: 'Long' as never,
      }),
    ).rejects.toThrow('Invalid paperSize. Accepted: "A4", "Letter", "Legal"');
  });

  describe('controller paper-size validation', () => {
    const createController = () =>
      new ScannerController(service, {
        io: {} as never,
        resolvePublicBaseUrl: () => new URL('http://127.0.0.1:3000'),
        powerSafetyService: {
          canAcceptCustomerWork: () => true,
        } as never,
      });

    it.each([undefined, 'Long'] as const)(
      'returns 400 for disconnected interactive scans with paperSize %s',
      async (paperSize) => {
        mockScannerRuntime = { connected: false, usingStub: false };
        const response = createMockResponse();

        await (createController() as any).interactiveScan(
          {
            body: {
              source: 'feeder',
              color: 'color',
              dpi: '300',
              paperSize,
            },
          } as Request,
          response,
        );

        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.json).toHaveBeenCalledWith({
          error: 'Invalid paperSize. Accepted: "A4", "Letter", "Legal"',
        });
      },
    );

    it.each([undefined, 'Long'] as const)(
      'returns 400 for preview scans with paperSize %s',
      async (paperSize) => {
        const response = createMockResponse();

        await (createController() as any).previewScan(
          { body: { paperSize } } as Request,
          response,
        );

        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.json).toHaveBeenCalledWith({
          error: 'Invalid paperSize. Accepted: "A4", "Letter", "Legal"',
        });
      },
    );
  });
});
