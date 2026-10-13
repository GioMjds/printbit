import request from 'supertest';
import express from 'express';
import { printerErrorStateManager } from '@/services/printer-error-state';
import { PrinterService } from './printer.service';
import { PrinterController } from './printer.controller';
import {
  handlePrinterStatusUpdate,
  setPrinterGuideSocketIo,
} from '@/services/printer-state-projection';
import {
  isCoinSlotLockedBy,
  resetCoinSlotLocks,
} from '@/services/hardware-state-projection';
import { anomalyService } from '@/services/anomaly';

describe('Printer Error Guide', () => {
  let app: express.Express;
  let printerService: PrinterService;
  let printerController: PrinterController;

  beforeEach(() => {
    printerErrorStateManager.clearStaffResolution();
    resetCoinSlotLocks();
    printerService = new PrinterService();
    printerController = new PrinterController(printerService);
    app = express();
    app.use(express.json());
    app.use('/api/printer', printerController.router);
  });

  describe('GET /api/printer/active-error', () => {
    it('returns null when no error is active via HTTP route', async () => {
      const res = await request(app).get('/api/printer/active-error');
      expect(res.status).toBe(200);
      expect(res.body.activeError).toBeNull();
      expect(res.body.outOfService).toBe(false);
    });

    it('returns active error with catalog details for reload safety via HTTP route', async () => {
      printerErrorStateManager.recordError('E_COVER_OPEN', 'PB-TEST-1');
      const res = await request(app).get('/api/printer/active-error');
      expect(res.status).toBe(200);
      expect(res.body.activeError.code).toBe('E_COVER_OPEN');
      expect(res.body.activeError.jobId).toBe('PB-TEST-1');
      expect(res.body.activeError.tier).toBe('Customer');
    });
  });

  describe('handlePrinterStatusUpdate', () => {
    let mockIo: { emit: jest.Mock };

    beforeEach(() => {
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

    it('reports anomaly once on initial Staff tier error and dedupes repetitive polls', async () => {
      const reportSpy = jest.spyOn(anomalyService, 'report').mockResolvedValue({} as any);
      handlePrinterStatusUpdate('No paper', '4');
      const active = printerErrorStateManager.getActiveError();
      expect(active?.code).toBe('E_NO_PAPER');
      expect(active?.tier).toBe('Staff');
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(true);
      expect(reportSpy).toHaveBeenCalledTimes(1);
      expect(reportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'printer',
          severity: 'warning',
          fingerprint: 'printer-E_NO_PAPER',
        }),
      );
      expect(mockIo.emit).toHaveBeenCalledWith(
        'printer:staff-alert',
        expect.objectContaining({
          activeError: expect.objectContaining({ code: 'E_NO_PAPER' }),
        }),
      );

      // Subsequent identical poll should not re-trigger anomaly report or staff alert
      handlePrinterStatusUpdate('No paper', '4');
      expect(reportSpy).toHaveBeenCalledTimes(1);
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

    it('unlocks coin slot and emits null activeError on healthy poll when customer error cleared', () => {
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

    it('unlocks coin slot on healthy poll after staff resolves non-autoClear error', () => {
      handlePrinterStatusUpdate('No paper', '4');
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(true);

      // Staff resolves the issue
      printerErrorStateManager.clearStaffResolution('staff-1');
      expect(printerErrorStateManager.getActiveError()).toBeNull();
      // Coin slot still held until healthy confirmation
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(true);

      // Printer reports ready
      handlePrinterStatusUpdate('ready');
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(false);
      expect(mockIo.emit).toHaveBeenLastCalledWith('printer:error-guide-update', {
        activeError: null,
      });
    });

    it('preserves coin slot lock and notifies interrupted state when mid-job customer error clears debounce', () => {
      // Customer tier error during an active job
      handlePrinterStatusUpdate('Cover open', '7', 'PB-JOB-42');
      const active = printerErrorStateManager.getActiveError();
      expect(active?.jobId).toBe('PB-JOB-42');
      expect(active?.jobRequiresStaff).toBe(true);
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(true);

      // Multiple healthy polls arrive (e.g. cover closed)
      handlePrinterStatusUpdate('ready');
      handlePrinterStatusUpdate('ready');

      // Auto-clear must NOT unlock coin slot for mid-job error; emits interrupted state
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(true);
      expect(mockIo.emit).toHaveBeenLastCalledWith('printer:error-guide-update', {
        activeError: expect.objectContaining({
          code: 'E_COVER_OPEN',
          jobId: 'PB-JOB-42',
          jobRequiresStaff: true,
          status: 'interrupted',
        }),
      });
    });

    it('ignores paper jam print events (handled by paper jam modal)', () => {
      handlePrinterStatusUpdate('Paper jam', '8');
      expect(printerErrorStateManager.getActiveError()).toBeNull();
      expect(isCoinSlotLockedBy('printer-error-guide')).toBe(false);
    });
  });
});
