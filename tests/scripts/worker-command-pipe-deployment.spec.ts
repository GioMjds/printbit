import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('worker command pipe deployment verification', () => {
  it('fails closed with a distinct result when the worker service is absent', async () => {
    const scriptPath = 'scripts/verify-worker-command-pipe.ps1';

    await expect(
      execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-ServiceName',
          `PrintBitMissing-${process.pid}-${Date.now()}`,
          '-SkipPipeProbe',
        ],
        { windowsHide: true },
      ),
    ).rejects.toMatchObject({ code: 10 });
  });
});
