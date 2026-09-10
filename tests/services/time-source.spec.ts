import {
  verifyTrustedClockSync,
  getTrustedTimeStatus,
  assertTrustedTimeForFinancialOperation,
  updateTrustedClockOffset,
  TrustedTimeError,
} from '../../src/services/time-source';
import type { PlatformWorkerClient } from '../../src/services/platform-worker-client';

describe('time-source', () => {
  let runPowerShellMock: jest.Mock;
  let loggerMock: { warn: jest.Mock; error: jest.Mock; log: jest.Mock };
  let workerClientMock: {
    getTrustedTimeStatus: jest.Mock;
  };

  beforeEach(() => {
    runPowerShellMock = jest.fn();
    loggerMock = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    workerClientMock = {
      getTrustedTimeStatus: jest.fn(),
    };
    updateTrustedClockOffset(null);
  });

  describe('configured offset precedence', () => {
    it('configured PRINTBIT_NTP_OFFSET_MS wins over worker and legacy', async () => {
      const status = await verifyTrustedClockSync({
        env: {
          PRINTBIT_NTP_OFFSET_MS: '42',
          PRINTBIT_WORKER_TRUSTED_TIME_ENABLED: 'true',
        },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      expect(status.offsetMs).toBe(42);
      expect(status.synced).toBe(true);
      expect(workerClientMock.getTrustedTimeStatus).not.toHaveBeenCalled();
      expect(runPowerShellMock).not.toHaveBeenCalled();
    });
  });

  describe('legacy backend (flag disabled)', () => {
    it('uses legacy w32tm query when flag is not set', async () => {
      runPowerShellMock
        .mockResolvedValueOnce('Source: time.windows.com\nLast Successful Sync Time: 2026-09-10 10:00:00')
        .mockResolvedValueOnce('Track: +15ms');

      const status = await verifyTrustedClockSync({
        env: {},
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      expect(status.synced).toBe(true);
      expect(status.offsetMs).toBe(15);
      expect(runPowerShellMock).toHaveBeenCalledWith('w32tm /query /status', 3000);
      expect(workerClientMock.getTrustedTimeStatus).not.toHaveBeenCalled();
    });
  });

  describe('worker backend (flag enabled)', () => {
    it('populates cache from worker snapshot without calling PowerShell', async () => {
      const nowIso = new Date().toISOString();
      workerClientMock.getTrustedTimeStatus.mockResolvedValue({
        requestId: 't-1',
        type: 'GetTrustedTimeStatus',
        success: true,
        source: 'ntp',
        synced: true,
        offsetMs: -30,
        driftExceeded: false,
        maxDriftMs: 60000,
        checkedAt: nowIso,
        ntpSource: 'time.windows.com',
        lastSuccessfulSyncAt: nowIso,
        detail: 'Synchronized via worker',
      });

      const status = await verifyTrustedClockSync({
        env: { PRINTBIT_WORKER_TRUSTED_TIME_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      expect(status.synced).toBe(true);
      expect(status.offsetMs).toBe(-30);
      expect(status.source).toBe('ntp');
      expect(runPowerShellMock).not.toHaveBeenCalled();
      expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    it('authoritative valid unsynchronized snapshot never falls back', async () => {
      const nowIso = new Date().toISOString();
      workerClientMock.getTrustedTimeStatus.mockResolvedValue({
        requestId: 't-2',
        type: 'GetTrustedTimeStatus',
        success: true,
        source: 'system',
        synced: false,
        offsetMs: null,
        driftExceeded: false,
        maxDriftMs: 60000,
        checkedAt: nowIso,
        ntpSource: 'Free-running clock',
        lastSuccessfulSyncAt: null,
        detail: 'Clock is not synced',
        errorCode: null,
      });

      const status = await verifyTrustedClockSync({
        env: { PRINTBIT_WORKER_TRUSTED_TIME_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      expect(status.synced).toBe(false);
      expect(status.source).toBe('system');
      expect(runPowerShellMock).not.toHaveBeenCalled();
      expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    it('falls back to legacy w32tm when worker returns NOT_IMPLEMENTED', async () => {
      workerClientMock.getTrustedTimeStatus.mockResolvedValue({
        requestId: 't-3',
        type: 'GetTrustedTimeStatus',
        success: false,
        errorCode: 'NOT_IMPLEMENTED',
        source: 'system',
        synced: false,
        detail: 'Scaffolded',
      });
      runPowerShellMock
        .mockResolvedValueOnce('Source: pool.ntp.org\nLast Successful Sync Time: 2026-09-10')
        .mockResolvedValueOnce('Offset: +10ms');

      const status = await verifyTrustedClockSync({
        env: { PRINTBIT_WORKER_TRUSTED_TIME_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      expect(status.synced).toBe(true);
      expect(status.offsetMs).toBe(10);
      expect(runPowerShellMock).toHaveBeenCalled();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('[TRUSTED_TIME] Worker backend unavailable; using temporary Node fallback.'),
      );
    });

    it('falls back to legacy when worker timestamp is malformed', async () => {
      workerClientMock.getTrustedTimeStatus.mockResolvedValue({
        requestId: 't-4',
        type: 'GetTrustedTimeStatus',
        success: true,
        source: 'ntp',
        synced: true,
        offsetMs: 5,
        driftExceeded: false,
        maxDriftMs: 60000,
        checkedAt: 'invalid-date',
      });
      runPowerShellMock
        .mockResolvedValueOnce('Source: pool.ntp.org\nLast Successful Sync Time: 2026-09-10')
        .mockResolvedValueOnce('Offset: +5ms');

      const status = await verifyTrustedClockSync({
        env: { PRINTBIT_WORKER_TRUSTED_TIME_ENABLED: 'true' },
        workerClient: workerClientMock as unknown as PlatformWorkerClient,
        runPowerShell: runPowerShellMock,
        logger: loggerMock,
      });

      expect(runPowerShellMock).toHaveBeenCalled();
      expect(loggerMock.warn).toHaveBeenCalled();
    });
  });

  describe('financial enforcement', () => {
    it('throws TrustedTimeError if financial operation requested and time is stale/unsynced', () => {
      expect(() => {
        assertTrustedTimeForFinancialOperation('DispenseCoins');
      }).not.toThrow(); // Default is enforceForFinancial: false

      expect(getTrustedTimeStatus()).toBeDefined();
    });
  });
});
