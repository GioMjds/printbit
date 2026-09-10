import { randomUUID } from 'node:crypto';
import {
  sendWorkerRequest,
  SendWorkerCommandOptions,
} from './worker-command-pipe';

export interface DefenderHealthWorkerResponse {
  requestId: string;
  type: 'GetDefenderHealth';
  success: boolean;
  status: string;
  signatureAgeHours?: number | null;
  detail?: string | null;
  errorCode?: string | null;
}

export interface FileSecurityWorkerResponse {
  requestId: string;
  type: 'ScanFileSecurity';
  success: boolean;
  status: string;
  detectionName?: string | null;
  detail?: string | null;
  errorCode?: string | null;
}

export interface WorkerUsbDriveDto {
  drive: string;
  label?: string | null;
  freeBytes: number;
  totalBytes: number;
}

export interface ListUsbDrivesWorkerResponse {
  requestId: string;
  type: 'ListUsbDrives';
  success: boolean;
  drives: WorkerUsbDriveDto[];
  errorCode?: string | null;
  message?: string | null;
}

export interface ExportScanToUsbWorkerResponse {
  requestId: string;
  type: 'ExportScanToUsb';
  success: boolean;
  exportPath?: string | null;
  drive?: string | null;
  errorCode?: string | null;
  message?: string | null;
}

export interface TrustedTimeWorkerResponse {
  requestId: string;
  type: 'GetTrustedTimeStatus';
  success: boolean;
  source: string;
  synced: boolean;
  offsetMs?: number | null;
  driftExceeded: boolean;
  maxDriftMs: number;
  checkedAt: string;
  ntpSource?: string | null;
  lastSuccessfulSyncAt?: string | null;
  detail?: string | null;
  errorCode?: string | null;
}

export interface NetworkPlatformWorkerResponse {
  requestId: string;
  type: 'PrepareHotspotPlatform';
  success: boolean;
  kioskIp?: string | null;
  firewallReady: boolean;
  errorCode?: string | null;
  detail?: string | null;
}

export interface PlatformWorkerClientDeps {
  sendRequest?: typeof sendWorkerRequest;
  logger?: Pick<Console, 'warn' | 'error' | 'log'>;
  defenderTimeoutMs?: number;
}

export class PlatformWorkerClient {
  private readonly sendRequest: typeof sendWorkerRequest;
  private readonly logger: Pick<Console, 'warn' | 'error' | 'log'>;
  private readonly defenderTimeoutMs: number;

  constructor(deps: PlatformWorkerClientDeps = {}) {
    this.sendRequest = deps.sendRequest ?? sendWorkerRequest;
    this.logger = deps.logger ?? console;
    this.defenderTimeoutMs = deps.defenderTimeoutMs ?? 30000;
  }

  private validateEnvelope<
    T extends { requestId: string; type: string; success: boolean },
  >(res: unknown, expectedType: string): T | null {
    if (!res || typeof res !== 'object') {
      return null;
    }
    const r = res as Record<string, unknown>;
    if (
      typeof r.requestId !== 'string' ||
      typeof r.success !== 'boolean' ||
      r.type !== expectedType
    ) {
      this.logger.warn(
        `[PLATFORM_WORKER_CLIENT] Malformed or mismatched response for ${expectedType}: ${JSON.stringify(res)}`,
      );
      return null;
    }
    return res as T;
  }

  async getDefenderHealth(): Promise<DefenderHealthWorkerResponse | null> {
    const requestId = randomUUID();
    const res = await this.sendRequest<DefenderHealthWorkerResponse>(
      { type: 'GetDefenderHealth', requestId },
      { timeoutMs: 15000, logger: this.logger },
    );
    return this.validateEnvelope<DefenderHealthWorkerResponse>(
      res,
      'GetDefenderHealth',
    );
  }

  async scanFileSecurity(
    filePath: string,
  ): Promise<FileSecurityWorkerResponse | null> {
    const requestId = randomUUID();
    const res = await this.sendRequest<FileSecurityWorkerResponse>(
      { type: 'ScanFileSecurity', requestId, filePath },
      { timeoutMs: this.defenderTimeoutMs, logger: this.logger },
    );
    return this.validateEnvelope<FileSecurityWorkerResponse>(
      res,
      'ScanFileSecurity',
    );
  }

  async listUsbDrives(): Promise<ListUsbDrivesWorkerResponse | null> {
    const requestId = randomUUID();
    const res = await this.sendRequest<ListUsbDrivesWorkerResponse>(
      { type: 'ListUsbDrives', requestId },
      { timeoutMs: 15000, logger: this.logger },
    );
    return this.validateEnvelope<ListUsbDrivesWorkerResponse>(
      res,
      'ListUsbDrives',
    );
  }

  async exportScanToUsb(
    sourcePath: string,
    drive: string,
  ): Promise<ExportScanToUsbWorkerResponse | null> {
    const requestId = randomUUID();
    const res = await this.sendRequest<ExportScanToUsbWorkerResponse>(
      { type: 'ExportScanToUsb', requestId, sourcePath, drive },
      { timeoutMs: 15000, logger: this.logger },
    );
    return this.validateEnvelope<ExportScanToUsbWorkerResponse>(
      res,
      'ExportScanToUsb',
    );
  }

  async getTrustedTimeStatus(input: {
    ntpServer: string | null;
    maxDriftMs: number;
  }): Promise<TrustedTimeWorkerResponse | null> {
    const requestId = randomUUID();
    const res = await this.sendRequest<TrustedTimeWorkerResponse>(
      {
        type: 'GetTrustedTimeStatus',
        requestId,
        ntpServer: input.ntpServer,
        maxDriftMs: input.maxDriftMs,
      },
      { timeoutMs: 15000, logger: this.logger },
    );
    return this.validateEnvelope<TrustedTimeWorkerResponse>(
      res,
      'GetTrustedTimeStatus',
    );
  }

  async prepareHotspotPlatform(input: {
    preferredSubnetPrefixes: string[];
    port: number;
  }): Promise<NetworkPlatformWorkerResponse | null> {
    const requestId = randomUUID();
    const res = await this.sendRequest<NetworkPlatformWorkerResponse>(
      {
        type: 'PrepareHotspotPlatform',
        requestId,
        preferredSubnetPrefixes: input.preferredSubnetPrefixes,
        port: input.port,
      },
      { timeoutMs: 15000, logger: this.logger },
    );
    return this.validateEnvelope<NetworkPlatformWorkerResponse>(
      res,
      'PrepareHotspotPlatform',
    );
  }
}

export const platformWorkerClient = new PlatformWorkerClient();
