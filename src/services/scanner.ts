import path from 'node:path';
import type { ScanJobSettings, PageSource } from './job-store';
import {
  sendWorkerRequest,
  type SendWorkerCommandOptions,
} from './worker-command-pipe';

export interface ScannerJobResult {
  outputPath: string;
  pageCount: number;
  format: string;
  durationMs?: number;
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
  scan(settings: ScanJobSettings, outputDir: string): Promise<ScannerJobResult>;
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

interface WorkerScannerStatusResponse {
  requestId: string;
  type: string;
  connected: boolean;
  adapter?: string;
  driver?: string;
  deviceName?: string;
  capabilities?: {
    available: boolean;
    sources?: string[];
    colorModes?: string[];
    dpiOptions?: number[];
    duplex?: boolean;
  };
  error?: string;
}

interface WorkerStartScanResponse {
  requestId: string;
  type: string;
  success: boolean;
  outputPath?: string;
  pageCount?: number;
  format?: string;
  errorCode?: string;
  message?: string;
  durationMs?: number;
}

interface WorkerCancelScanResponse {
  requestId: string;
  type: string;
  success: boolean;
  message?: string;
}

const PREFERRED_SCANNER_NAME =
  process.env.PRINTBIT_SCANNER_NAME ?? 'EPSON L5290 Series';
const SCAN_COMMAND_TIMEOUT_MS = 100_000; // 100s (giving 90s worker scan headroom)

let cachedRuntimeStatus: ScannerRuntimeStatus = {
  connected: false,
  adapter: 'naps2',
  driver: 'none',
  deviceName: null,
  preferredName: PREFERRED_SCANNER_NAME,
  probes: { twain: [], wia: [] },
  capabilities: null,
  usingStub: false,
  lastCheckedAt: new Date().toISOString(),
  lastError: null,
  preflight: {
    naps2Path: 'Managed by C# Worker',
    naps2Exists: true,
    scanDir: path.resolve('uploads', 'scans'),
  },
};

/**
 * WorkerScannerAdapter delegates scanner execution and probing to the
 * native C# PrintBit.Infrastructure.Windows.Scanning service over Named Pipe IPC.
 */
export class WorkerScannerAdapter implements ScannerAdapter {
  private activeRequestId: string | null = null;

  async probe(): Promise<ScannerCapabilities> {
    const requestId = `probe-${Date.now()}`;
    const resp = await sendWorkerRequest<WorkerScannerStatusResponse>(
      {
        type: 'ProbeScanner',
        requestId,
      },
      { timeoutMs: 20_000 },
    );

    if (!resp) {
      return {
        available: false,
        sources: [],
        colorModes: [],
        dpiOptions: [],
        duplex: false,
      };
    }

    const caps = resp.capabilities;
    return {
      available: Boolean(resp.connected && caps?.available),
      sources: (caps?.sources as PageSource[]) ?? ['flatbed', 'adf'],
      colorModes: (caps?.colorModes as ('colored' | 'grayscale')[]) ?? [
        'colored',
        'grayscale',
      ],
      dpiOptions: caps?.dpiOptions ?? [150, 300, 600],
      duplex: Boolean(caps?.duplex),
    };
  }

  async scan(
    settings: ScanJobSettings,
    outputDir: string,
  ): Promise<ScannerJobResult> {
    const requestId = `scan-${Date.now()}`;
    this.activeRequestId = requestId;

    const startMs = Date.now();
    const opts: SendWorkerCommandOptions = {
      timeoutMs: SCAN_COMMAND_TIMEOUT_MS,
    };

    const resp = await sendWorkerRequest<WorkerStartScanResponse>(
      {
        type: 'StartScan',
        requestId,
        source: settings.source === 'adf' ? 'adf' : 'flatbed',
        dpi: settings.dpi,
        colorMode: settings.colorMode,
        format: settings.format,
        paperSize: settings.paperSize,
        outputDir: path.resolve(outputDir),
        maxPages: settings.maxPages,
      },
      opts,
    );

    this.activeRequestId = null;
    const elapsed = Date.now() - startMs;

    if (!resp) {
      throw new Error(
        'Scan failed: No response received from C# Worker (IPC timeout or disconnected).',
      );
    }

    if (!resp.success || !resp.outputPath) {
      const detail = resp.message || resp.errorCode || 'Unknown scanning error';
      throw new Error(`Scan failed: ${detail}`);
    }

    console.log(
      `[SCANNER] ✓ C# Worker scan complete in ${elapsed}ms → ${resp.outputPath}`,
    );

    return {
      outputPath: resp.outputPath,
      pageCount: resp.pageCount ?? 1,
      format: resp.format ?? settings.format,
      durationMs: resp.durationMs ?? elapsed,
    };
  }

  cancel(): void {
    if (!this.activeRequestId) return;
    const targetId = this.activeRequestId;
    this.activeRequestId = null;

    void sendWorkerRequest<WorkerCancelScanResponse>({
      type: 'CancelScan',
      requestId: `cancel-${Date.now()}`,
      targetRequestId: targetId,
    }).catch((err) => {
      console.warn(`[SCANNER] Failed sending CancelScan to worker: ${err}`);
    });
  }
}

class ScannerService {
  private activeAdapter: ScannerAdapter = new WorkerScannerAdapter();

  setAdapter(adapter: ScannerAdapter): void {
    this.activeAdapter = adapter;
  }

  getAdapter(): ScannerAdapter {
    return this.activeAdapter;
  }

  getStatus(): ScannerRuntimeStatus {
    return cachedRuntimeStatus;
  }

  async detect(): Promise<void> {
    console.log('[SCANNER] ── Detecting scanner via C# Worker ─────────────');
    const requestId = `detect-${Date.now()}`;

    try {
      const resp = await sendWorkerRequest<WorkerScannerStatusResponse>(
        {
          type: 'GetScannerStatus',
          requestId,
        },
        { timeoutMs: 15_000 },
      );

      if (resp) {
        const caps: ScannerCapabilities | null = resp.capabilities
          ? {
              available: Boolean(resp.capabilities.available),
              sources: (resp.capabilities.sources as PageSource[]) ?? [
                'flatbed',
                'adf',
              ],
              colorModes: (resp.capabilities.colorModes as (
                | 'colored'
                | 'grayscale'
              )[]) ?? ['colored', 'grayscale'],
              dpiOptions: resp.capabilities.dpiOptions ?? [150, 300, 600],
              duplex: Boolean(resp.capabilities.duplex),
            }
          : null;

        cachedRuntimeStatus = {
          connected: resp.connected,
          adapter: (resp.adapter as 'naps2' | 'stub') ?? 'naps2',
          driver: (resp.driver as ScannerDriver | 'stub' | 'none') ?? 'none',
          deviceName: resp.deviceName ?? null,
          preferredName: PREFERRED_SCANNER_NAME,
          probes: { twain: [], wia: [] },
          capabilities: caps,
          usingStub: resp.adapter === 'stub',
          lastCheckedAt: new Date().toISOString(),
          lastError: resp.error ?? null,
          preflight: {
            naps2Path: 'Managed by C# Worker',
            naps2Exists: true,
            scanDir: path.resolve('uploads', 'scans'),
          },
        };

        console.log(
          `[SCANNER] C# Worker reports scanner connected: ${resp.connected} (${resp.deviceName ?? 'No device'})`,
        );
        return;
      }
    } catch (err) {
      console.warn(`[SCANNER] Failed querying scanner status from C#: ${err}`);
    }

    // Fallback status if worker unreachable
    cachedRuntimeStatus = {
      connected: false,
      adapter: 'stub',
      driver: 'none',
      deviceName: null,
      preferredName: PREFERRED_SCANNER_NAME,
      probes: { twain: [], wia: [] },
      capabilities: null,
      usingStub: true,
      lastCheckedAt: new Date().toISOString(),
      lastError: 'Unable to connect to PrintBit.HardwareService worker pipe',
      preflight: {
        naps2Path: 'Managed by C# Worker',
        naps2Exists: false,
        scanDir: path.resolve('uploads', 'scans'),
      },
    };
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