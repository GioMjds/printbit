import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DOCUMENT_CONVERSION_PIPE_NAME } from '@/config/http.config';
import { convertDocumentViaWorker } from '@/services/document-conversion-pipe';

const execFileAsync = promisify(execFile);

export interface DocumentConversionStatus {
  connected: boolean;
  status: 'operational' | 'degraded' | 'offline';
  engine: string;
  configuredPath: string;
  executableFound: boolean;
  resolvedPath: string | null;
  pipeName: string;
  pipeConnected: boolean;
  zombieTerminationEnabled: boolean;
  activeZombieProcesses: number;
  lastTerminationAt: string | null;
  totalZombiesTerminated: number;
  lastError: string | null;
  lastCheckedAt: string;
}

export interface TerminateZombiesResult {
  success: boolean;
  terminatedCount: number;
  cleanedLocksCount: number;
  message: string;
}

export interface TestConversionResult {
  success: boolean;
  durationMs: number;
  pageCount?: number | null;
  message: string;
}

class DocumentConversionMonitor {
  private zombieTerminationEnabled = true;
  private lastTerminationAt: string | null = null;
  private totalZombiesTerminated = 0;
  private lastError: string | null = null;
  private cachedStatus: DocumentConversionStatus | null = null;
  private cacheExpiresAt = 0;

  constructor() {
    // Default configured via environment if provided
    if (process.env.PRINTBIT_ZOMBIE_TERMINATION_ENABLED !== undefined) {
      this.zombieTerminationEnabled =
        process.env.PRINTBIT_ZOMBIE_TERMINATION_ENABLED !== 'false';
    }
  }

  public isZombieTerminationEnabled(): boolean {
    return this.zombieTerminationEnabled;
  }

  public setZombieTerminationEnabled(enabled: boolean): void {
    this.zombieTerminationEnabled = enabled;
    this.cacheExpiresAt = 0;
  }

  public resolveLibreOfficePath(): {
    configuredPath: string;
    resolvedPath: string | null;
    executableFound: boolean;
  } {
    const configuredPath =
      process.env.PRINTBIT_LIBREOFFICE_PATH ||
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe';

    if (fs.existsSync(configuredPath)) {
      if (configuredPath.toLowerCase().endsWith('soffice.exe')) {
        const comPath =
          configuredPath.slice(0, -4) +
          (configuredPath.endsWith('.EXE') ? '.COM' : '.com');
        if (fs.existsSync(comPath)) {
          return { configuredPath, resolvedPath: comPath, executableFound: true };
        }
      }
      return { configuredPath, resolvedPath: configuredPath, executableFound: true };
    }

    const candidates = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.com',
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return { configuredPath, resolvedPath: candidate, executableFound: true };
      }
    }

    return { configuredPath, resolvedPath: null, executableFound: false };
  }

  public async checkPipeConnection(
    pipeName = DOCUMENT_CONVERSION_PIPE_NAME,
    timeoutMs = 1200,
  ): Promise<boolean> {
    const pipePath = pipeName.startsWith('\\\\.\\pipe\\')
      ? pipeName
      : `\\\\.\\pipe\\${pipeName}`;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const socket = net.connect(pipePath);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          resolve(false);
        }
      }, timeoutMs);

      socket.once('connect', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.removeAllListeners();
          socket.destroy();
          resolve(true);
        }
      });

      socket.once('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.removeAllListeners();
          socket.destroy();
          resolve(false);
        }
      });
    });
  }

  public async countZombieProcesses(): Promise<number> {
    if (process.platform !== 'win32') return 0;

    try {
      let count = 0;
      const targets = ['soffice.bin', 'soffice.exe'];

      for (const target of targets) {
        try {
          const { stdout } = await execFileAsync('tasklist', [
            '/FI',
            `IMAGENAME eq ${target}`,
            '/FO',
            'CSV',
            '/NH',
          ]);
          const lines = stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && l.toLowerCase().includes(target.toLowerCase()));
          count += lines.length;
        } catch {
          // Tasklist returns non-zero if no matching tasks found
        }
      }

      return count;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return 0;
    }
  }

  public async terminateZombieProcesses(): Promise<TerminateZombiesResult> {
    let terminatedCount = 0;
    let cleanedLocksCount = 0;

    if (process.platform === 'win32') {
      const targets = ['soffice.bin', 'soffice.exe'];
      for (const target of targets) {
        try {
          const { stdout } = await execFileAsync('taskkill', ['/F', '/T', '/IM', target]);
          if (stdout && stdout.toLowerCase().includes('success')) {
            const matches = stdout.match(/PID \d+/gi);
            terminatedCount += matches ? matches.length : 1;
          }
        } catch {
          // No process matching target existed
        }
      }
    }

    // Clean stale lock files from known profile directories
    const profileDirsToClean = [
      'C:\\ProgramData\\PrintBit\\lo-profile',
      'C:\\ProgramData\\PrintBit\\lo-profiles',
      path.join(os.tmpdir(), 'printbit-lo-profile'),
      path.join(os.tmpdir(), 'printbit-lo-profiles'),
    ];

    for (const baseDir of profileDirsToClean) {
      if (!fs.existsSync(baseDir)) continue;

      try {
        const scanAndRemoveLocks = (dir: string) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanAndRemoveLocks(fullPath);
            } else if (entry.name === '.lock' || entry.name.startsWith('.~lock.')) {
              try {
                fs.unlinkSync(fullPath);
                cleanedLocksCount++;
              } catch {
                // Ignore locked files
              }
            }
          }
        };

        scanAndRemoveLocks(baseDir);
      } catch {
        // Ignore directory read errors
      }
    }

    this.lastTerminationAt = new Date().toISOString();
    this.totalZombiesTerminated += terminatedCount;
    this.cacheExpiresAt = 0;

    const message =
      terminatedCount > 0 || cleanedLocksCount > 0
        ? `Terminated ${terminatedCount} zombie process(es) and purged ${cleanedLocksCount} lock file(s).`
        : 'No zombie processes or lock files detected.';

    return {
      success: true,
      terminatedCount,
      cleanedLocksCount,
      message,
    };
  }

  public async getStatus(forceFresh = false): Promise<DocumentConversionStatus> {
    const now = Date.now();
    if (!forceFresh && this.cachedStatus && now < this.cacheExpiresAt) {
      return this.cachedStatus;
    }

    const { configuredPath, resolvedPath, executableFound } =
      this.resolveLibreOfficePath();
    const pipeConnected = await this.checkPipeConnection();
    const activeZombieProcesses = await this.countZombieProcesses();

    let status: 'operational' | 'degraded' | 'offline' = 'offline';
    if (pipeConnected && executableFound) {
      status = 'operational';
    } else if (pipeConnected || executableFound) {
      status = 'degraded';
    }

    const result: DocumentConversionStatus = {
      connected: pipeConnected,
      status,
      engine: 'LibreOffice Headless',
      configuredPath,
      executableFound,
      resolvedPath,
      pipeName: DOCUMENT_CONVERSION_PIPE_NAME,
      pipeConnected,
      zombieTerminationEnabled: this.zombieTerminationEnabled,
      activeZombieProcesses,
      lastTerminationAt: this.lastTerminationAt,
      totalZombiesTerminated: this.totalZombiesTerminated,
      lastError: this.lastError,
      lastCheckedAt: new Date().toISOString(),
    };

    this.cachedStatus = result;
    this.cacheExpiresAt = now + 4000; // 4s cache window
    return result;
  }

  public async testConversion(): Promise<TestConversionResult> {
    const tempDir = path.join(os.tmpdir(), `pb-conv-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Minimal valid TXT or RTF document for fast testing
    const testDocPath = path.join(tempDir, 'conversion-probe.txt');
    fs.writeFileSync(
      testDocPath,
      'PrintBit Document Conversion Probe - ' + new Date().toISOString(),
      'utf-8',
    );

    const startTime = Date.now();
    try {
      const result = await convertDocumentViaWorker(testDocPath, {
        outputDirectory: tempDir,
        timeoutSeconds: 20,
      });

      const durationMs = Date.now() - startTime;

      if (!result.success || !result.outputPath || !fs.existsSync(result.outputPath)) {
        return {
          success: false,
          durationMs,
          message:
            result.errorMessage ||
            'Conversion finished but output PDF was not found or is empty.',
        };
      }

      const stat = fs.statSync(result.outputPath);
      if (stat.size === 0) {
        return {
          success: false,
          durationMs,
          message: 'Conversion produced a 0-byte output PDF file.',
        };
      }

      return {
        success: true,
        durationMs,
        pageCount: result.pageCount ?? 1,
        message: `Conversion successful in ${durationMs}ms (${stat.size} bytes).`,
      };
    } catch (err) {
      return {
        success: false,
        durationMs: Date.now() - startTime,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
  }
}

export const documentConversionMonitor = new DocumentConversionMonitor();
export const getDocumentConversionStatus =
  documentConversionMonitor.getStatus.bind(documentConversionMonitor);
export const terminateZombieProcesses =
  documentConversionMonitor.terminateZombieProcesses.bind(
    documentConversionMonitor,
  );
export const testDocumentConversion =
  documentConversionMonitor.testConversion.bind(documentConversionMonitor);
export const setZombieTerminationEnabled =
  documentConversionMonitor.setZombieTerminationEnabled.bind(
    documentConversionMonitor,
  );
export const isZombieTerminationEnabled =
  documentConversionMonitor.isZombieTerminationEnabled.bind(
    documentConversionMonitor,
  );
