import {
  WorkerClient,
  type WorkerClientDependencies,
} from '../../src/infrastructure/worker';

describe('WorkerClient stable protocol facade', () => {
  it('exposes one typed entrypoint for all worker transports', () => {
    const dependencies: WorkerClientDependencies = {
      sendRequest: jest.fn(),
      sendCommand: jest.fn(),
      sendError: jest.fn(),
      handoffToWorker: jest.fn(),
      startReturnPipeServer: jest.fn(),
    };

    const client = new WorkerClient(dependencies);

    expect(client.sendRequest).toBe(dependencies.sendRequest);
    expect(client.sendCommand).toBe(dependencies.sendCommand);
    expect(client.sendError).toBe(dependencies.sendError);
    expect(client.handoffToWorker).toBe(dependencies.handoffToWorker);
    expect(client.startReturnPipeServer).toBe(
      dependencies.startReturnPipeServer,
    );
  });

  it('stamps outgoing stable protocol requests and commands with version 2', async () => {
    const sendRequest = jest.fn().mockResolvedValue(null);
    const sendCommand = jest.fn().mockResolvedValue(true);
    const client = new WorkerClient({ sendRequest, sendCommand });

    await client.request({ type: 'GetPrinterRecoveryStatus', requestId: 'r-1' });
    await client.command({ type: 'pause_job', requestId: 'r-2' });

    expect(sendRequest).toHaveBeenCalledWith(
      { type: 'GetPrinterRecoveryStatus', requestId: 'r-1', protocolVersion: 2 },
      undefined,
    );
    expect(sendCommand).toHaveBeenCalledWith(
      { type: 'pause_job', requestId: 'r-2', protocolVersion: 2 },
      undefined,
    );
  });
});
