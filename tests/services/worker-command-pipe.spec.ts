import net from 'node:net';

import { sendWorkerRequest } from '../../src/services/worker-command-pipe';

function uniquePipeName(label: string): string {
  return `printbit-test-${label}-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

function pipePath(pipeName: string): string {
  return `\\\\.\\pipe\\${pipeName}`;
}

function startOneShotServer(
  pipeName: string,
  delayMs: number,
  response: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTimer = setTimeout(() => {
      const server = net.createServer((socket) => {
        let request = '';

        socket.on('data', (chunk) => {
          request += chunk.toString('utf8');
          if (!request.includes('\n')) return;

          server.close();
          socket.end(`${JSON.stringify(response)}\n`);
        });
      });

      server.once('error', reject);
      server.once('close', resolve);
      server.listen(pipePath(pipeName));

      const cleanupTimer = setTimeout(() => server.close(), 1_000);
      cleanupTimer.unref();
    }, delayMs);

    startTimer.unref();
  });
}

function startDisconnectingServer(
  pipeName: string,
  listenForMs: number,
): { done: Promise<number>; ready: Promise<void> } {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const done = new Promise<number>((resolve, reject) => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });

    server.once('error', reject);
    server.listen(pipePath(pipeName), () => {
      resolveReady();
      setTimeout(() => server.close(() => resolve(connections)), listenForMs);
    });
  });

  return { done, ready };
}

describe('sendWorkerRequest', () => {
  it('waits for a worker pipe that appears before the request deadline', async () => {
    const requestId = 'delayed-1';
    const testPipeName = uniquePipeName('delayed');
    const serverDone = startOneShotServer(testPipeName, 75, {
      requestId,
      success: true,
    });

    await expect(
      sendWorkerRequest(
        { requestId, type: 'GetPrinterRecoveryStatus' },
        {
          pipeName: testPipeName,
          timeoutMs: 2_000,
          logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        },
      ),
    ).resolves.toEqual({ requestId, success: true });

    await serverDone;
  });

  it('does not reconnect after a server accepts the command connection', async () => {
    const testPipeName = uniquePipeName('disconnect');
    const server = startDisconnectingServer(testPipeName, 250);
    await server.ready;

    await expect(
      sendWorkerRequest(
        { requestId: 'disconnect-1', type: 'GetPrinterRecoveryStatus' },
        {
          pipeName: testPipeName,
          timeoutMs: 1_000,
          connectRetry: { initialDelayMs: 5, maxDelayMs: 10 },
          logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        },
      ),
    ).resolves.toBeNull();

    await expect(server.done).resolves.toBe(1);
  });

  it('uses one overall deadline across all connection attempts', async () => {
    const startedAt = Date.now();

    await expect(
      sendWorkerRequest(
        { requestId: 'deadline-1', type: 'GetPrinterRecoveryStatus' },
        {
          pipeName: uniquePipeName('absent'),
          timeoutMs: 120,
          connectRetry: { initialDelayMs: 5, maxDelayMs: 20 },
          logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        },
      ),
    ).resolves.toBeNull();

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('does not retry an authorization failure', async () => {
    const connectSpy = jest.spyOn(net, 'connect').mockImplementation(() => {
      const socket = new net.Socket();
      process.nextTick(() => {
        socket.emit(
          'error',
          Object.assign(new Error('access denied'), { code: 'EPERM' }),
        );
      });
      return socket;
    });

    try {
      await expect(
        sendWorkerRequest(
          { requestId: 'acl-1', type: 'GetPrinterRecoveryStatus' },
          {
            pipeName: uniquePipeName('acl'),
            timeoutMs: 1_000,
            connectRetry: { initialDelayMs: 5, maxDelayMs: 10 },
            logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
          },
        ),
      ).resolves.toBeNull();

      expect(connectSpy).toHaveBeenCalledTimes(1);
    } finally {
      connectSpy.mockRestore();
    }
  });
});
