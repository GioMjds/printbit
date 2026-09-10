import {
  sendWorkerCommand,
  sendWorkerRequest,
  type SendWorkerCommandOptions,
  type WorkerCommandPayload,
  type WorkerHardwareResponse,
} from '../../services/worker-command-pipe';
import {
  sendWorkerError,
  type WorkerErrorPayload,
} from '../../services/worker-error-pipe';
import {
  handoffToWorker,
  type WorkerHandoffError,
} from '../../services/worker-handoff';
import {
  startWorkerReturnPipeServer,
  type WorkerPrintEvent,
  type WorkerReturnPipeServerHandle,
} from '../../services/worker-return-pipe';
import {
  PlatformWorkerClient,
  type PlatformWorkerClientDeps,
} from '../../services/platform-worker-client';

export const STABLE_WORKER_PROTOCOL_VERSION = 2 as const;

export interface WorkerClientDependencies extends PlatformWorkerClientDeps {
  sendRequest?: typeof sendWorkerRequest;
  sendCommand?: typeof sendWorkerCommand;
  sendError?: typeof sendWorkerError;
  handoffToWorker?: typeof handoffToWorker;
  startReturnPipeServer?: typeof startWorkerReturnPipeServer;
}

/**
 * Stable Node-side entrypoint for the PrintBit worker protocol.
 *
 * The wire contract remains line-delimited JSON over named pipes. This class
 * only composes transport adapters; domain policy and migration fallbacks stay
 * in their owning services.
 */
export class WorkerClient {
  private readonly platformClient: PlatformWorkerClient;
  readonly sendRequest: typeof sendWorkerRequest;
  readonly sendCommand: typeof sendWorkerCommand;
  readonly sendError: typeof sendWorkerError;
  readonly handoffToWorker: typeof handoffToWorker;
  readonly startReturnPipeServer: typeof startWorkerReturnPipeServer;

  constructor(deps: WorkerClientDependencies = {}) {
    this.platformClient = new PlatformWorkerClient(deps);
    this.sendRequest = deps.sendRequest ?? sendWorkerRequest;
    this.sendCommand = deps.sendCommand ?? sendWorkerCommand;
    this.sendError = deps.sendError ?? sendWorkerError;
    this.handoffToWorker = deps.handoffToWorker ?? handoffToWorker;
    this.startReturnPipeServer =
      deps.startReturnPipeServer ?? startWorkerReturnPipeServer;
  }

  getDefenderHealth() {
    return this.platformClient.getDefenderHealth();
  }

  scanFileSecurity(filePath: string) {
    return this.platformClient.scanFileSecurity(filePath);
  }

  listUsbDrives() {
    return this.platformClient.listUsbDrives();
  }

  exportScanToUsb(sourcePath: string, drive: string) {
    return this.platformClient.exportScanToUsb(sourcePath, drive);
  }

  getTrustedTimeStatus(input: { ntpServer: string | null; maxDriftMs: number }) {
    return this.platformClient.getTrustedTimeStatus(input);
  }

  prepareHotspotPlatform(input: {
    preferredSubnetPrefixes: string[];
    port: number;
  }) {
    return this.platformClient.prepareHotspotPlatform(input);
  }

  request<TResponse = WorkerHardwareResponse>(
    payload: Record<string, unknown>,
    options?: SendWorkerCommandOptions,
  ): Promise<TResponse | null> {
    return this.sendRequest<TResponse>(
      { protocolVersion: STABLE_WORKER_PROTOCOL_VERSION, ...payload },
      options,
    );
  }

  command(
    payload: WorkerCommandPayload,
    options?: SendWorkerCommandOptions,
  ): Promise<boolean> {
    return this.sendCommand(
      { protocolVersion: STABLE_WORKER_PROTOCOL_VERSION, ...payload },
      options,
    );
  }

  error(payload: WorkerErrorPayload, pipeName: string): Promise<void> {
    return this.sendError(payload, pipeName);
  }

  handoff(input: Parameters<typeof handoffToWorker>[0]): ReturnType<typeof handoffToWorker> {
    return this.handoffToWorker(input);
  }

  listen(input: Parameters<typeof startWorkerReturnPipeServer>[0]): WorkerReturnPipeServerHandle {
    return this.startReturnPipeServer(input);
  }
}

export type { WorkerPrintEvent, WorkerReturnPipeServerHandle, WorkerHandoffError };

export const workerClient = new WorkerClient();
export const printWorkerClient = workerClient;
