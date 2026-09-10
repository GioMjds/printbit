import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  getDefenderConfig,
  type DefenderConfig,
} from '@/config/defender.config';
import { getPlatformWorkerFlags } from '@/config/platform-worker.config';
import {
  platformWorkerClient,
  type PlatformWorkerClient,
} from '@/services/platform-worker-client';

export type DefenderScanStatus =
  | 'clean'
  | 'infected'
  | 'unavailable'
  | 'stale'
  | 'timeout'
  | 'failed';

export interface DefenderHealth {
  readonly status:
    | Extract<DefenderScanStatus, 'unavailable' | 'stale'>
    | 'clean';
  readonly signatureAgeHours: number | null;
  readonly detail: string | null;
}

export interface DefenderScanResult {
  readonly status: DefenderScanStatus;
  readonly detectionName: string | null;
  readonly detail: string | null;
}

export interface DefenderScanner {
  getHealth(): Promise<DefenderHealth>;
  scanFile(stagedPath: string): Promise<DefenderScanResult>;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<CommandResult>;
}

export interface FsAdapter {
  existsSync(p: string): boolean;
  readdirSync?(p: string): string[];
}

export interface DefenderScannerDeps {
  readonly runner?: CommandRunner;
  readonly config?: DefenderConfig;
  readonly fsAdapter?: FsAdapter;
  readonly env?: NodeJS.ProcessEnv;
  readonly workerClient?: Pick<PlatformWorkerClient, 'getDefenderHealth' | 'scanFileSecurity'>;
  readonly logger?: Pick<Console, 'warn' | 'error' | 'log'>;
}

const DEFAULT_RUNNER: CommandRunner = {
  async run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      let timedOut = false;
      const child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: null,
          stdout,
          stderr: stderr || err.message,
          timedOut,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          stdout,
          stderr,
          timedOut,
        });
      });
    });
  },
};

function truncateDiagnostic(text: string, maxLen = 500): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen);
}

const APPROVED_PLATFORM_ROOT = path.resolve(
  'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform',
);
const APPROVED_STATIC_FALLBACK = path.resolve(
  'C:\\Program Files\\Windows Defender\\MpCmdRun.exe',
);

export function resolveMpCmdRunPath(fsAdapter: FsAdapter = fs): string | null {
  try {
    if (
      fsAdapter.readdirSync &&
      fsAdapter.existsSync(APPROVED_PLATFORM_ROOT)
    ) {
      const entries = fsAdapter.readdirSync(APPROVED_PLATFORM_ROOT);
      // Sort in descending order to prefer newest platform update folder
      const sorted = [...entries].sort().reverse();
      for (const entry of sorted) {
        const candidate = path.resolve(
          APPROVED_PLATFORM_ROOT,
          entry,
          'MpCmdRun.exe',
        );
        const rel = path.relative(APPROVED_PLATFORM_ROOT, candidate);
        if (
          !rel.startsWith('..') &&
          !path.isAbsolute(rel) &&
          fsAdapter.existsSync(candidate)
        ) {
          return candidate;
        }
      }
    }
  } catch {
    // ignore directory read errors and fallback
  }

  if (fsAdapter.existsSync(APPROVED_STATIC_FALLBACK)) {
    return APPROVED_STATIC_FALLBACK;
  }

  return null;
}

export class DefaultDefenderScanner implements DefenderScanner {
  private readonly runner: CommandRunner;
  private readonly config: DefenderConfig;
  private readonly fsAdapter: FsAdapter;

  constructor(deps: DefenderScannerDeps = {}) {
    this.runner = deps.runner ?? DEFAULT_RUNNER;
    this.config = deps.config ?? getDefenderConfig();
    this.fsAdapter = deps.fsAdapter ?? fs;
  }

  async getHealth(): Promise<DefenderHealth> {
    try {
      const psCommand =
        'Get-MpComputerStatus | Select-Object AMRunningMode, AntivirusEnabled, AntivirusSignatureLastUpdated | ConvertTo-Json';

      const result = await this.runner.run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        Math.min(this.config.scanTimeoutMs, 15_000),
      );

      if (result.timedOut) {
        return {
          status: 'unavailable',
          signatureAgeHours: null,
          detail: 'Defender health check timed out.',
        };
      }

      if (result.exitCode !== 0) {
        return {
          status: 'unavailable',
          signatureAgeHours: null,
          detail: truncateDiagnostic(
            result.stderr || result.stdout || 'PowerShell status query failed.',
          ),
        };
      }

      let parsed: {
        AMRunningMode?: unknown;
        AntivirusEnabled?: unknown;
        AntivirusSignatureLastUpdated?: unknown;
      };

      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return {
          status: 'unavailable',
          signatureAgeHours: null,
          detail: 'Failed to parse Get-MpComputerStatus JSON output.',
        };
      }

      const isEnabled = parsed.AntivirusEnabled === true;
      const isNormalMode = parsed.AMRunningMode === 'Normal' || parsed.AMRunningMode === 0;

      if (!isEnabled || !isNormalMode) {
        return {
          status: 'unavailable',
          signatureAgeHours: null,
          detail: 'Microsoft Defender Antivirus is disabled or not in Normal mode.',
        };
      }

      const rawLastUpdated = parsed.AntivirusSignatureLastUpdated;
      if (!rawLastUpdated) {
        return {
          status: 'unavailable',
          signatureAgeHours: null,
          detail: 'AntivirusSignatureLastUpdated was missing from status output.',
        };
      }

      let updatedTimeMs: number;
      if (typeof rawLastUpdated === 'string') {
        const msMatch = /\/Date\((\d+)\)\//.exec(rawLastUpdated);
        if (msMatch) {
          updatedTimeMs = Number(msMatch[1]);
        } else {
          updatedTimeMs = Date.parse(rawLastUpdated);
        }
      } else if (typeof rawLastUpdated === 'number') {
        updatedTimeMs = rawLastUpdated;
      } else {
        updatedTimeMs = NaN;
      }

      if (!Number.isFinite(updatedTimeMs)) {
        return {
          status: 'unavailable',
          signatureAgeHours: null,
          detail: 'Invalid signature timestamp format.',
        };
      }

      const now = Date.now();
      const ageHours = (now - updatedTimeMs) / (1000 * 60 * 60);

      if (ageHours > this.config.maxSignatureAgeHours) {
        return {
          status: 'stale',
          signatureAgeHours: ageHours,
          detail: `Defender signatures are ${Math.round(ageHours)} hours old (maximum allowed: ${this.config.maxSignatureAgeHours}).`,
        };
      }

      return {
        status: 'clean',
        signatureAgeHours: ageHours >= 0 ? ageHours : 0,
        detail: null,
      };
    } catch (err) {
      return {
        status: 'unavailable',
        signatureAgeHours: null,
        detail: truncateDiagnostic(
          err instanceof Error ? err.message : String(err),
        ),
      };
    }
  }

  async scanFile(stagedPath: string): Promise<DefenderScanResult> {
    const mpCmdRunPath = resolveMpCmdRunPath(this.fsAdapter);
    if (!mpCmdRunPath) {
      return {
        status: 'unavailable',
        detectionName: null,
        detail: 'Microsoft Defender command-line tool (MpCmdRun.exe) was not found in approved locations.',
      };
    }

    try {
      const args = [
        '-Scan',
        '-ScanType',
        '3',
        '-File',
        stagedPath,
        '-DisableRemediation',
      ];

      const result = await this.runner.run(
        mpCmdRunPath,
        args,
        this.config.scanTimeoutMs,
      );

      if (result.timedOut) {
        return {
          status: 'timeout',
          detectionName: null,
          detail: 'Defender file scan timed out.',
        };
      }

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      const threatMatch =
        /(?:Threat(?:\s+detected)?\s*:\s*)([^\r\n]+)/i.exec(combinedOutput);

      if (result.exitCode === 2 || threatMatch) {
        const detectionName = threatMatch ? threatMatch[1].trim() : 'ThreatDetected';
        return {
          status: 'infected',
          detectionName,
          detail: null,
        };
      }

      if (result.exitCode === 0) {
        return {
          status: 'clean',
          detectionName: null,
          detail: null,
        };
      }

      return {
        status: 'failed',
        detectionName: null,
        detail: truncateDiagnostic(
          result.stderr || result.stdout || `Scan failed with exit code ${result.exitCode}`,
        ),
      };
    } catch (err) {
      return {
        status: 'failed',
        detectionName: null,
        detail: truncateDiagnostic(
          err instanceof Error ? err.message : String(err),
        ),
      };
    }
  }
}

export class MigratingDefenderScanner implements DefenderScanner {
  private readonly legacyScanner: DefenderScanner;
  private readonly workerClient: Pick<PlatformWorkerClient, 'getDefenderHealth' | 'scanFileSecurity'>;
  private readonly logger: Pick<Console, 'warn' | 'error' | 'log'>;

  constructor(deps: DefenderScannerDeps = {}) {
    this.legacyScanner = new DefaultDefenderScanner(deps);
    this.workerClient = deps.workerClient ?? platformWorkerClient;
    this.logger = deps.logger ?? console;
  }

  async getHealth(): Promise<DefenderHealth> {
    let res;
    try {
      res = await this.workerClient.getDefenderHealth();
    } catch {
      res = null;
    }

    if (!res || res.errorCode === 'NOT_IMPLEMENTED') {
      this.logger.warn(
        '[DEFENDER] Worker backend unavailable; using temporary Node fallback.',
      );
      return this.legacyScanner.getHealth();
    }

    const validStatus = (res.status === 'clean' || res.status === 'stale' || res.status === 'unavailable')
      ? res.status
      : 'unavailable';

    return {
      status: validStatus,
      signatureAgeHours: res.signatureAgeHours ?? null,
      detail: res.detail ?? null,
    };
  }

  async scanFile(stagedPath: string): Promise<DefenderScanResult> {
    let res;
    try {
      res = await this.workerClient.scanFileSecurity(stagedPath);
    } catch {
      res = null;
    }

    if (!res || res.errorCode === 'NOT_IMPLEMENTED') {
      this.logger.warn(
        '[DEFENDER] Worker backend unavailable; using temporary Node fallback.',
      );
      return this.legacyScanner.scanFile(stagedPath);
    }

    const validStatuses: DefenderScanStatus[] = ['clean', 'infected', 'unavailable', 'stale', 'timeout', 'failed'];
    const status: DefenderScanStatus = validStatuses.includes(res.status as DefenderScanStatus)
      ? (res.status as DefenderScanStatus)
      : 'failed';

    return {
      status,
      detectionName: res.detectionName ?? null,
      detail: res.detail ?? null,
    };
  }
}

export function createDefenderScanner(
  deps: DefenderScannerDeps = {},
): DefenderScanner {
  const flags = getPlatformWorkerFlags(deps.env);
  if (flags.defender) {
    return new MigratingDefenderScanner(deps);
  }
  return new DefaultDefenderScanner(deps);
}

