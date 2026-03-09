import path from 'node:path';
import fs from 'node:fs';
import { execFile, type ChildProcess } from 'node:child_process';
import type { ScanJobSettings, PageSource } from './job-store';

export interface ScanResult {
  outputPath: string;
  pageCount: number;
  format: string;
}

export interface ScannerCapabilities {
  available: boolean;
  sources: PageSource[];
  colorModes: ('colored' | 'grayscale')[];
  dpiOptions: number[];
  duplex: boolean;
}

export interface ScannerAdapter {
  probe(): Promise<ScannerCapabilities>;
  scan(settings: ScanJobSettings, outputDir: string): Promise<ScanResult>;
  cancel(): void;
}

type ScannerDriver = 'twain' | 'wia';

export interface ScannerRuntimeStatus {
  connected: boolean;
  adapter: 'naps2' | 'stub';
  driver: ScannerDriver | 'stub' | 'none';
  deviceName: string | null;
  preferredName: string;
  probes: {
    twain: string[];
    wia: string[];
  };
  capabilities: ScannerCapabilities | null;
  usingStub: boolean;
  lastCheckedAt: string;
  lastError: string | null;
  preflight: {
    naps2Path: string;
    naps2Exists: boolean;
    scanDir: string;
  };
}

const NAPS2_PATH =
  process.env.PRINTBIT_NAPS2_PATH ??
  'C:\\Program Files\\NAPS2\\NAPS2.Console.exe';
const SCAN_TIMEOUT_MS = 90_000;
const PREFERRED_SCANNER_NAME =
  process.env.PRINTBIT_SCANNER_NAME ?? 'EPSON L5290 Series';

let runtimeStatus: ScannerRuntimeStatus = {
  connected: false,
  adapter: 'stub',
  driver: 'none',
  deviceName: null,
  preferredName: PREFERRED_SCANNER_NAME,
  probes: { twain: [], wia: [] },
  capabilities: null,
  usingStub: true,
  lastCheckedAt: new Date().toISOString(),
  lastError: null,
  preflight: {
    naps2Path: NAPS2_PATH,
    naps2Exists: false,
    scanDir: path.resolve('uploads', 'scans'),
  },
};

export class StubScannerAdapter implements ScannerAdapter {
  private cancelled = false;

  async probe(): Promise<ScannerCapabilities> {
    const caps: ScannerCapabilities = {
      available: true,
      sources: ['adf', 'flatbed'],
      colorModes: ['colored', 'grayscale'],
      dpiOptions: [150, 300, 600],
      duplex: false,
    };
    console.log('[SCANNER] Stub capabilities:', JSON.stringify(caps));
    return caps;
  }

  async scan(
    settings: ScanJobSettings,
    outputDir: string,
  ): Promise<ScanResult> {
    this.cancelled = false;
    console.log('[SCANNER] ── New stub scan job ─────────────────────────');
    console.log('[SCANNER] Settings:', JSON.stringify(settings));
    console.log('[SCANNER] Output dir:', outputDir);

    fs.mkdirSync(outputDir, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2_000);
      const check = setInterval(() => {
        if (this.cancelled) {
          clearTimeout(timer);
          clearInterval(check);
          reject(new Error('Scan cancelled by user'));
        }
      }, 100);
      timer.unref?.();
      void new Promise<void>((r) => setTimeout(r, 2_000)).then(() =>
        clearInterval(check),
      );
    });

    const filename = `stub-scan-${Date.now()}.${settings.format}`;
    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, 'Stub scan output', 'utf-8');
    console.log(`[SCANNER] ✓ Stub scan complete → ${outputPath}`);

    return {
      outputPath,
      pageCount: 1,
      format: settings.format,
    };
  }

  cancel(): void {
    this.cancelled = true;
  }
}

// ── NAPS2 adapter (real hardware via NAPS2.Console.exe) ──────────────

export class Naps2ScannerAdapter implements ScannerAdapter {
  private readonly deviceName: string;
  private readonly driver: ScannerDriver;
  private childProc: ChildProcess | null = null;

  constructor(deviceName: string, driver: ScannerDriver) {
    this.deviceName = deviceName;
    this.driver = driver;
  }

  async probe(): Promise<ScannerCapabilities> {
    const devices = await listNaps2Devices(this.driver);
    const found = devices.some(
      (d) => d.toLowerCase() === this.deviceName.toLowerCase(),
    );

    if (!found) {
      return {
        available: false,
        sources: [],
        colorModes: [],
        dpiOptions: [],
        duplex: false,
      };
    }

    return {
      available: true,
      sources: ['adf', 'flatbed'],
      colorModes: ['colored', 'grayscale'],
      dpiOptions: [150, 300, 600],
      duplex: false,
    };
  }

  async scan(
    settings: ScanJobSettings,
    outputDir: string,
  ): Promise<ScanResult> {
    fs.mkdirSync(outputDir, { recursive: true });

    const ext =
      settings.format === 'jpg'
        ? 'jpg'
        : settings.format === 'png'
          ? 'png'
          : 'pdf';
    const filename = `scan-${Date.now()}.${ext}`;
    const outputPath = path.join(outputDir, filename);
    const args = buildNaps2Args(
      this.deviceName,
      this.driver,
      settings,
      outputPath,
    );

    const startMs = Date.now();

    return new Promise<ScanResult>((resolve, reject) => {
      const proc = execFile(
        NAPS2_PATH,
        args,
        { timeout: SCAN_TIMEOUT_MS, windowsHide: true },
        (error, stdout, stderr) => {
          this.childProc = null;
          const elapsed = Date.now() - startMs;

          if (stdout) console.log(`[SCANNER] stdout: ${stdout.trim()}`);
          if (stderr) console.warn(`[SCANNER] stderr: ${stderr.trim()}`);

          if (error) {
            return reject(
              new Error(
                `Scan failed: ${error.message}${stderr ? ` — ${stderr.trim()}` : ''}`,
              ),
            );
          }

          if (!fs.existsSync(outputPath)) {
            return reject(
              new Error('Scan completed but no output file was created'),
            );
          }

          const stat = fs.statSync(outputPath);
          console.log(
            `[SCANNER] ✓ Scan complete in ${elapsed}ms → ${outputPath} (${stat.size} bytes)`,
          );

          resolve({
            outputPath,
            pageCount: 1,
            format: settings.format,
          });
        },
      );

      this.childProc = proc;
    });
  }

  cancel(): void {
    if (this.childProc && !this.childProc.killed) {
      this.childProc.kill('SIGTERM');
      this.childProc = null;
    }
  }
}

function buildNaps2Args(
  deviceName: string,
  driver: ScannerDriver,
  settings: ScanJobSettings,
  outputPath: string,
): string[] {
  const args = [
    '-o',
    outputPath,
    '--driver',
    driver,
    '--device',
    deviceName,
    '--source',
    settings.source === 'adf' ? 'feeder' : 'glass',
    '--dpi',
    String(settings.dpi),
    '--bitdepth',
    settings.colorMode === 'colored' ? 'color' : 'gray',
    '--force',
    '--verbose',
  ];

  if (settings.paperSize) {
    args.push('--pagesize', settings.paperSize.toLowerCase());
  }

  return args;
}

function parseDeviceLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function listNaps2Devices(driver: ScannerDriver): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      NAPS2_PATH,
      ['--listdevices', '--driver', driver],
      { timeout: 15_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          console.log(
            `[SCANNER] ⚠ NAPS2 --listdevices (${driver}) failed: ${error.message}`,
          );
          resolve([]);
          return;
        }
        resolve(parseDeviceLines(stdout));
      },
    );
  });
}

function selectPreferredDevice(
  devices: string[],
  preferredName: string,
): string | null {
  if (devices.length === 0) return null;

  const preferredLower = preferredName.toLowerCase();
  const exact = devices.find(
    (device) => device.toLowerCase() === preferredLower,
  );
  if (exact) return exact;

  const partial = devices.find((device) =>
    device.toLowerCase().includes(preferredLower),
  );
  if (partial) return partial;

  const epson = devices.find((device) =>
    device.toLowerCase().includes('epson'),
  );
  if (epson) return epson;

  return devices[0] ?? null;
}

class ScannerService {
  private runtimeStatus: ScannerRuntimeStatus = runtimeStatus;
  private activeAdapter: ScannerAdapter = new StubScannerAdapter();

  setAdapter(adapter: ScannerAdapter): void {
    this.activeAdapter = adapter;
  }

  getAdapter(): ScannerAdapter {
    return this.activeAdapter;
  }

  getStatus(): ScannerRuntimeStatus {
    return {
      ...this.runtimeStatus,
      probes: {
        twain: [...this.runtimeStatus.probes.twain],
        wia: [...this.runtimeStatus.probes.wia],
      },
      capabilities: this.runtimeStatus.capabilities
        ? { ...this.runtimeStatus.capabilities }
        : null,
    };
  }

  async detect(): Promise<void> {
    console.log('[SCANNER] ── Detecting scanner ──────────────────────────');

    const scanDir = path.resolve('uploads', 'scans');
    fs.mkdirSync(scanDir, { recursive: true });

    const naps2Exists = fs.existsSync(NAPS2_PATH);
    runtimeStatus = {
      connected: false,
      adapter: 'stub',
      driver: 'none',
      deviceName: null,
      preferredName: PREFERRED_SCANNER_NAME,
      probes: { twain: [], wia: [] },
      capabilities: null,
      usingStub: true,
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      preflight: {
        naps2Path: NAPS2_PATH,
        naps2Exists,
        scanDir,
      },
    };

    if (naps2Exists) {
      for (const driver of ['twain', 'wia'] as const) {
        try {
          const devices = await listNaps2Devices(driver);
          this.runtimeStatus.probes[driver] = devices;
          console.log(
            `[SCANNER] NAPS2 ${driver.toUpperCase()} devices: [${devices.join(', ')}]`,
          );

          const deviceName = selectPreferredDevice(
            devices,
            PREFERRED_SCANNER_NAME,
          );
          if (!deviceName) continue;

          const adapter = new Naps2ScannerAdapter(deviceName, driver);
          const caps = await adapter.probe();
          if (!caps.available) continue;

          this.setAdapter(adapter);
          this.runtimeStatus = {
            ...this.runtimeStatus,
            connected: true,
            adapter: 'naps2',
            driver,
            deviceName,
            capabilities: caps,
            usingStub: false,
            lastCheckedAt: new Date().toISOString(),
            lastError: null,
          };

          console.log(
            `[SCANNER] ✓ Using ${driver.toUpperCase()} scanner: "${deviceName}"`,
          );
          return;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.runtimeStatus = {
            ...this.runtimeStatus,
            lastError: message,
            lastCheckedAt: new Date().toISOString(),
          };
        }
      }
    }

    this.setAdapter(new StubScannerAdapter());
    const caps = await this.activeAdapter.probe();
    this.runtimeStatus = {
      ...this.runtimeStatus,
      connected: false,
      adapter: 'stub',
      driver: 'stub',
      deviceName: 'Stub scanner',
      capabilities: caps,
      usingStub: true,
      lastCheckedAt: new Date().toISOString(),
      lastError:
        this.runtimeStatus.lastError ??
        (naps2Exists
          ? 'No TWAIN/WIA scanner device was found.'
          : `NAPS2 not found at ${NAPS2_PATH}`),
    };
    console.log('[SCANNER] \u26a0 Falling back to stub scanner adapter');
  }
}

export const scannerService = new ScannerService();

export function setAdapter(adapter: ScannerAdapter): void {
  scannerService.setAdapter(adapter);
}
export function getAdapter(): ScannerAdapter {
  return scannerService.getAdapter();
}
export function getScannerStatus(): ScannerRuntimeStatus {
  return scannerService.getStatus();
}
export async function detectScanner(): Promise<void> {
  return scannerService.detect();
}
