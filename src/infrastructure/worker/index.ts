export {
  WorkerClient,
  workerClient,
  printWorkerClient,
  STABLE_WORKER_PROTOCOL_VERSION,
  type WorkerClientDependencies,
} from './worker-client';

export {
  sendWorkerCommand,
  sendWorkerRequest,
  type SendWorkerCommandOptions,
  type WorkerCommandPayload,
  type WorkerCommandType,
  type WorkerHardwareResponse,
} from '../../services/worker-command-pipe';

export {
  sendWorkerError,
  buildWorkerErrorPayload,
  serializeWorkerError,
  type WorkerErrorPayload,
} from '../../services/worker-error-pipe';

export {
  handoffToWorker,
  WorkerHandoffError,
  type WorkerHandoffErrorCode,
} from '../../services/worker-handoff';

export {
  startWorkerReturnPipeServer,
  parseWorkerEventLine,
  mapWorkerEventToSocket,
  handleWorkerPowerEvent,
  type WorkerPrintEvent,
  type WorkerReturnPipeServerHandle,
} from '../../services/worker-return-pipe';

export * from '../../services/platform-worker-client';
