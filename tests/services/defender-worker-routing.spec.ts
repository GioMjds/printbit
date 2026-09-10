import {
  createDefenderScanner,
  type CommandRunner,
  type FsAdapter,
} from '../../src/services/defender-scanner';
import type { PlatformWorkerClient } from '../../src/services/platform-worker-client';

describe('defender-worker-routing', () => {
  let runner: { run: jest.Mock };
  let fsAdapter: FsAdapter;
  let logger: { warn: jest.Mock; error: jest.Mock; log: jest.Mock };
  let workerClient: {
    getDefenderHealth: jest.Mock;
    scanFileSecurity: jest.Mock;
  };

  beforeEach(() => {
    runner = { run: jest.fn() };
    fsAdapter = {
      existsSync: jest.fn().mockReturnValue(true),
      readdirSync: jest.fn().mockReturnValue(['MpCmdRun.exe']),
    };
    logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    workerClient = {
      getDefenderHealth: jest.fn(),
      scanFileSecurity: jest.fn(),
    };
  });

  it('uses legacy runner by default when worker flag is not enabled', async () => {
    runner.run.mockResolvedValue({
      exitCode: 0,
      stdout: 'Scan finished.',
      stderr: '',
      timedOut: false,
    });

    const scanner = createDefenderScanner({
      env: {},
      workerClient: workerClient as unknown as PlatformWorkerClient,
      runner: runner as CommandRunner,
      fsAdapter,
      logger,
    });

    const result = await scanner.scanFile('C:\\PrintBit\\uploads\\doc.pdf');
    expect(result.status).toBe('clean');
    expect(runner.run).toHaveBeenCalled();
    expect(workerClient.scanFileSecurity).not.toHaveBeenCalled();
  });

  it('uses worker scan result and does NOT invoke runner when worker is enabled and returns infected', async () => {
    workerClient.scanFileSecurity.mockResolvedValue({
      requestId: 'sec-1',
      type: 'ScanFileSecurity',
      success: true,
      status: 'infected',
      detectionName: 'Trojan.Test',
      detail: null,
      errorCode: null,
    });

    const scanner = createDefenderScanner({
      env: { PRINTBIT_WORKER_DEFENDER_ENABLED: 'true' },
      workerClient: workerClient as unknown as PlatformWorkerClient,
      runner: runner as CommandRunner,
      fsAdapter,
      logger,
    });

    const result = await scanner.scanFile('C:\\PrintBit\\uploads\\doc.pdf');
    expect(result).toEqual({
      status: 'infected',
      detectionName: 'Trojan.Test',
      detail: null,
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('uses worker scan result when clean without invoking legacy runner', async () => {
    workerClient.scanFileSecurity.mockResolvedValue({
      requestId: 'sec-2',
      type: 'ScanFileSecurity',
      success: true,
      status: 'clean',
      detectionName: null,
      detail: null,
      errorCode: null,
    });

    const scanner = createDefenderScanner({
      env: { PRINTBIT_WORKER_DEFENDER_ENABLED: 'true' },
      workerClient: workerClient as unknown as PlatformWorkerClient,
      runner: runner as CommandRunner,
      fsAdapter,
      logger,
    });

    const result = await scanner.scanFile('C:\\PrintBit\\uploads\\doc.pdf');
    expect(result.status).toBe('clean');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('falls back to legacy runner and logs warning when worker returns NOT_IMPLEMENTED', async () => {
    workerClient.scanFileSecurity.mockResolvedValue({
      requestId: 'sec-3',
      type: 'ScanFileSecurity',
      success: false,
      status: 'unavailable',
      errorCode: 'NOT_IMPLEMENTED',
      detail: 'Scaffolded',
    });
    runner.run.mockResolvedValue({
      exitCode: 0,
      stdout: 'Scan finished.',
      stderr: '',
      timedOut: false,
    });

    const scanner = createDefenderScanner({
      env: { PRINTBIT_WORKER_DEFENDER_ENABLED: 'true' },
      workerClient: workerClient as unknown as PlatformWorkerClient,
      runner: runner as CommandRunner,
      fsAdapter,
      logger,
    });

    const result = await scanner.scanFile('C:\\PrintBit\\uploads\\doc.pdf');
    expect(result.status).toBe('clean');
    expect(runner.run).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[DEFENDER] Worker backend unavailable; using temporary Node fallback.'),
    );
  });

  it('falls back to legacy runner when worker transport fails (null response)', async () => {
    workerClient.scanFileSecurity.mockResolvedValue(null);
    runner.run.mockResolvedValue({
      exitCode: 0,
      stdout: 'Scan finished.',
      stderr: '',
      timedOut: false,
    });

    const scanner = createDefenderScanner({
      env: { PRINTBIT_WORKER_DEFENDER_ENABLED: 'true' },
      workerClient: workerClient as unknown as PlatformWorkerClient,
      runner: runner as CommandRunner,
      fsAdapter,
      logger,
    });

    const result = await scanner.scanFile('C:\\PrintBit\\uploads\\doc.pdf');
    expect(result.status).toBe('clean');
    expect(runner.run).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('delegates getHealth to worker and falls back on NOT_IMPLEMENTED', async () => {
    workerClient.getDefenderHealth.mockResolvedValue({
      requestId: 'def-1',
      type: 'GetDefenderHealth',
      success: false,
      status: 'unavailable',
      errorCode: 'NOT_IMPLEMENTED',
    });
    runner.run.mockResolvedValue({
      exitCode: 0,
      stdout: 'Signature: 1.0\nUpdate: 2026-09-10',
      stderr: '',
      timedOut: false,
    });

    const scanner = createDefenderScanner({
      env: { PRINTBIT_WORKER_DEFENDER_ENABLED: 'true' },
      workerClient: workerClient as unknown as PlatformWorkerClient,
      runner: runner as CommandRunner,
      fsAdapter,
      logger,
    });

    await scanner.getHealth();
    expect(runner.run).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
