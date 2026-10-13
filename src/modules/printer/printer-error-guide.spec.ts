import type { Request, Response } from 'express';
import { printerErrorStateManager } from '@/services/printer-error-state';
import { printerController } from './printer.controller';
import {
  handlePrinterStatusUpdate,
  setPrinterGuideSocketIo,
} from '@/services/printer-state-projection';
import { isCoinSlotLockedBy } from '@/services/hardware-state-projection';
import { anomalyService } from '@/services/anomaly';

describe('Printer Error Guide', () => {
  describe('GET /api/printer/active-error', () => {
    beforeEach(() => {
      printerErrorStateManager.clearStaffResolution();
    });

    it('returns null when no error is active', () => {
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnThis();
      const res = { json: jsonMock, status: statusMock } as unknown as Response;
      printerController.getActiveError({} as Request, res);
      expect(jsonMock).toHaveBeenCalledWith({
        activeError: null,
        outOfService: false,
      });
    });

    it('returns active error with catalog details for reload safety', () => {
      printerErrorStateManager.recordError('E_COVER_OPEN', 'PB-TEST-1');
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnThis();
      const res = { json: jsonMock, status: statusMock } as unknown as Response;
      printerController.getActiveError({} as Request, res);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          activeError: expect.objectContaining({
            code: 'E_COVER_OPEN',
            jobId: 'PB-TEST-1',
            tier: 'Customer',
          }),
        }),
      );
    });
  });

  describe('handlePrinterStatusUpdate', () => {
    let mockIo: { emit: jest.Mock };

    beforeEach(() => {
      printerErrorStateManager.clearStaffResolution();
      mockIo = { emit: jest.fn() };
      setPrinterGuideSocketIo(mockIo as any);
      jest.clearAllMocks();
    });

    it('locks coin slot and emits update on recoverable Customer error', () => {
      handlePrinterStatusUpdate('Cover open', '7');
      const active = printerErrorStateManager.getActiveError();
      expect(active).not.toBeNull();
      expect(active?.code).toBe('E_COVER_OPEN');
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(true);
      expect(mockIo.emit).toHaveBeenCalledWith(
        'printer:error-guide-update',
        expect.objectContaining({
          activeError: expect.objectContaining({ code: 'E_COVER_OPEN' }),
        }),
      );
    });

    it('reports anomaly and locks coin slot on Staff tier error', async () => {
      const reportSpy = jest.spyOn(anomalyService, 'report').mockResolvedValue({} as any);
      handlePrinterStatusUpdate('No paper', '4');
      const active = printerErrorStateManager.getActiveError();
      expect(active?.code).toBe('E_NO_PAPER');
      expect(active?.tier).toBe('Staff');
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(true);
      expect(reportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'printer',
          severity: 'warning',
          fingerprint: 'printer-E_NO_PAPER',
        }),
      );
    });

    it('reports critical anomaly on Technician tier error', async () => {
      const reportSpy = jest.spyOn(anomalyService, 'report').mockResolvedValue({} as any);
      handlePrinterStatusUpdate('Waste ink pad full');
      const active = printerErrorStateManager.getActiveError();
      expect(active?.code).toBe('E_SERVICE');
      expect(active?.tier).toBe('Technician');
      expect(reportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'printer',
          severity: 'critical',
          fingerprint: 'printer-E_SERVICE',
        }),
      );
    });

    it('unlocks coin slot and emits null activeError on healthy poll when cleared', () => {
      // First trigger Customer tier error
      handlePrinterStatusUpdate('Cover open', '7');
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(true);

      // Debounce requires 2 healthy polls
      handlePrinterStatusUpdate('ready');
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(true);

      handlePrinterStatusUpdate('ready');
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(false);
      expect(mockIo.emit).toHaveBeenLastCalledWith('printer:error-guide-update', {
        activeError: null,
      });
    });

    it('ignores paper jam print events (handled by paper jam modal)', () => {
      handlePrinterStatusUpdate('Paper jam', '8');
      expect(printerErrorStateManager.getActiveError()).toBeNull();
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(false);
    });
  });
});
