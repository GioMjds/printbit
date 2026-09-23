import {
  WINDOWS_RESTART_ARGS,
  WINDOWS_SHUTDOWN_ARGS,
  requestWindowsRestart,
  requestWindowsShutdown,
} from '../../src/services/windows-power';

describe('windows-power service', () => {
  it('throws on non-Windows host', async () => {
    await expect(
      requestWindowsRestart({ platform: 'linux' }),
    ).rejects.toThrow('Windows restart is only available on Windows hosts.');
  });

  it('invokes shutdown.exe with restart arguments on Windows', async () => {
    const runCommand = jest.fn().mockResolvedValue(undefined);

    await requestWindowsRestart({
      platform: 'win32',
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(
      'shutdown.exe',
      WINDOWS_RESTART_ARGS,
    );
  });

  it('invokes shutdown.exe with shutdown arguments on Windows', async () => {
    const runCommand = jest.fn().mockResolvedValue(undefined);

    await requestWindowsShutdown({
      platform: 'win32',
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(
      'shutdown.exe',
      WINDOWS_SHUTDOWN_ARGS,
    );
  });
});
