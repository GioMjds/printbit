import { adminService as modularAdminService, AdminService } from '@/modules/admin/admin.service';
import { adminService as legacyAdminService } from '@/services/admin';
import { adminLogStore } from '@/core/database/sqlite-storage';

describe('Unified Real-Time Logging', () => {
  beforeEach(() => {
    adminLogStore.clear();
  });

  afterAll(() => {
    adminLogStore.clear();
  });

  describe('Modular AdminService Socket.io live streaming', () => {
    it('broadcasts admin:new_log when Socket.io is configured', async () => {
      const service = new AdminService();
      const emittedEvents: Array<{ event: string; payload: unknown }> = [];
      const mockIo = {
        emit: (event: string, ...args: unknown[]) => {
          emittedEvents.push({ event, payload: args[0] });
        },
      };

      service.setSocketIo(mockIo);
      const entry = await service.appendAdminLog(
        'worker_print_started',
        'Print job started for file test.pdf',
        { source: 'Worker', transactionId: 'tx-123' },
      );

      expect(entry.type).toBe('worker_print_started');
      expect(entry.message).toContain('test.pdf');
      expect(entry.meta?.source).toBe('Worker');

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].event).toBe('admin:new_log');
      expect((emittedEvents[0].payload as typeof entry).id).toBe(entry.id);
      expect((emittedEvents[0].payload as typeof entry).meta?.source).toBe('Worker');
    });

    it('does not fail when Socket.io is null or emit throws', async () => {
      const service = new AdminService();
      service.setSocketIo(null);

      const entry = await service.appendAdminLog('node_event', 'Server event test');
      expect(entry.type).toBe('node_event');

      const brokenIo = {
        emit: () => {
          throw new Error('Socket network error');
        },
      };
      service.setSocketIo(brokenIo);

      await expect(
        service.appendAdminLog('node_event_2', 'Server event test 2'),
      ).resolves.toBeDefined();
    });
  });

  describe('Legacy AdminService Socket.io live streaming', () => {
    it('broadcasts admin:new_log when Socket.io is configured', async () => {
      const emittedEvents: Array<{ event: string; payload: unknown }> = [];
      const mockIo = {
        emit: (event: string, ...args: unknown[]) => {
          emittedEvents.push({ event, payload: args[0] });
        },
      };

      legacyAdminService.setSocketIo(mockIo);
      const entry = await legacyAdminService.appendAdminLog(
        'printer_offline',
        'Printer EPSON L5290 went offline.',
        { source: 'Worker', printerName: 'EPSON L5290' },
      );

      expect(entry.type).toBe('printer_offline');
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].event).toBe('admin:new_log');
      expect((emittedEvents[0].payload as typeof entry).id).toBe(entry.id);

      legacyAdminService.setSocketIo(null);
    });
  });
});
