import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  convertDocumentViaWorker,
  _resetConversionQueueForTesting,
  getDocumentConversionQueueLength,
} from './document-conversion-pipe';

jest.mock('node:net');

describe('document-conversion-pipe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetConversionQueueForTesting();
  });

  it('serializes requests so jobs execute in order and subsequent timeouts do not tick while waiting', async () => {
    const executionOrder: string[] = [];
    const sockets: any[] = [];

    (net.connect as unknown as jest.Mock).mockImplementation(() => {
      const emitter = new EventEmitter() as any;
      emitter.write = jest.fn((_data: string, _enc: string, cb?: (err?: Error) => void) => {
        if (cb) cb();
      });
      emitter.destroy = jest.fn();
      emitter.removeAllListeners = jest.fn();
      sockets.push(emitter);

      setTimeout(() => {
        emitter.emit('connect');
      }, 5);

      return emitter;
    });

    const job1Promise = convertDocumentViaWorker('doc1.docx', { pipeName: 'test-pipe-1' });
    const job2Promise = convertDocumentViaWorker('doc2.docx', { pipeName: 'test-pipe-1' });

    expect(getDocumentConversionQueueLength()).toBe(2);

    // Yield to let job1 microtask run and call net.connect
    await new Promise((r) => setImmediate(r));
    expect(net.connect).toHaveBeenCalledTimes(1);
    expect(sockets.length).toBe(1);

    await new Promise((r) => setTimeout(r, 10));
    executionOrder.push('job1-started');
    sockets[0].emit('data', Buffer.from(JSON.stringify({
      requestId: 'req-1',
      success: true,
      outputPath: 'doc1.pdf',
      pageCount: 2,
      durationMs: 100,
    }) + '\n'));

    const result1 = await job1Promise;
    expect(result1.success).toBe(true);
    executionOrder.push('job1-finished');

    // Yield to let job2 microtask run
    await new Promise((r) => setImmediate(r));
    expect(net.connect).toHaveBeenCalledTimes(2);
    expect(sockets.length).toBe(2);
    executionOrder.push('job2-started');

    await new Promise((r) => setTimeout(r, 10));
    sockets[1].emit('data', Buffer.from(JSON.stringify({
      requestId: 'req-2',
      success: true,
      outputPath: 'doc2.pdf',
      pageCount: 3,
      durationMs: 150,
    }) + '\n'));

    const result2 = await job2Promise;
    expect(result2.success).toBe(true);
    executionOrder.push('job2-finished');

    expect(executionOrder).toEqual([
      'job1-started',
      'job1-finished',
      'job2-started',
      'job2-finished',
    ]);
    expect(getDocumentConversionQueueLength()).toBe(0);
  });

  it('continues queue processing even if a preceding job fails', async () => {
    const sockets: any[] = [];

    (net.connect as unknown as jest.Mock).mockImplementation(() => {
      const emitter = new EventEmitter() as any;
      emitter.write = jest.fn((_data: string, _enc: string, cb?: (err?: Error) => void) => {
        if (cb) cb();
      });
      emitter.destroy = jest.fn();
      emitter.removeAllListeners = jest.fn();
      sockets.push(emitter);

      setTimeout(() => {
        emitter.emit('connect');
      }, 5);

      return emitter;
    });

    const job1Promise = convertDocumentViaWorker('fail.docx', { pipeName: 'test-pipe-2' });
    const job2Promise = convertDocumentViaWorker('success.docx', { pipeName: 'test-pipe-2' });

    // Yield for job 1
    await new Promise((r) => setImmediate(r));
    expect(sockets.length).toBe(1);

    await new Promise((r) => setTimeout(r, 10));
    sockets[0].emit('close');

    await expect(job1Promise).rejects.toThrow('closed the connection');

    // Yield for job 2
    await new Promise((r) => setImmediate(r));
    expect(net.connect).toHaveBeenCalledTimes(2);
    expect(sockets.length).toBe(2);

    await new Promise((r) => setTimeout(r, 10));
    sockets[1].emit('data', Buffer.from(JSON.stringify({
      requestId: 'req-2',
      success: true,
      outputPath: 'success.pdf',
      pageCount: 1,
      durationMs: 50,
    }) + '\n'));

    const result2 = await job2Promise;
    expect(result2.success).toBe(true);
    expect(result2.outputPath).toBe('success.pdf');
    expect(getDocumentConversionQueueLength()).toBe(0);
  });
});
