import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WINDOWS_SHUTDOWN_ARGS = [
  '/s',
  '/t',
  '0',
  '/d',
  'p:0:0',
  '/c',
  'PrintBit administrator requested shutdown',
] as const;

export const WINDOWS_RESTART_ARGS = [
  '/r',
  '/t',
  '0',
  '/d',
  'p:0:0',
  '/c',
  'PrintBit administrator requested restart',
] as const;

// Keep /t at zero and omit /f: Microsoft documents that a nonzero timeout
// implies forced application closure. Source:
// https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown

type ShutdownCommandRunner = (
  fileName: string,
  args: readonly string[],
) => Promise<void>;

const runShutdownCommand: ShutdownCommandRunner = async (fileName, args) => {
  await execFileAsync(fileName, [...args], { windowsHide: true });
};

export interface RequestWindowsShutdownOptions {
  platform?: NodeJS.Platform;
  runCommand?: ShutdownCommandRunner;
}

export async function requestWindowsShutdown(
  options: RequestWindowsShutdownOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error('Windows shutdown is only available on Windows hosts.');
  }

  await (options.runCommand ?? runShutdownCommand)(
    'shutdown.exe',
    WINDOWS_SHUTDOWN_ARGS,
  );
}

export async function requestWindowsRestart(
  options: RequestWindowsShutdownOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error('Windows restart is only available on Windows hosts.');
  }

  await (options.runCommand ?? runShutdownCommand)(
    'shutdown.exe',
    WINDOWS_RESTART_ARGS,
  );
}

