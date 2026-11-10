import {
  ANALYSIS_FAILED_TEXT,
  ANALYSIS_WAIT_TIMEOUT_MS,
  createCoalescedRunner,
  createSessionSocket,
  decideContinueAction,
  filesSignature,
  getAnalysisBadge,
  pollDocumentAnalysis,
  type SocketLike,
  type UploadedFile,
} from './print-session';

const file = (over: Partial<UploadedFile> = {}): UploadedFile => ({
  documentId: 'doc-1',
  filename: 'a.pdf',
  size: 10,
  pageCount: 5,
  analysisStatus: 'completed',
  ...over,
});

describe('filesSignature', () => {
  it('changes when the max-pages limit changes so badges re-render', () => {
    const files = [file()];
    expect(filesSignature(files, 30)).not.toBe(filesSignature(files, 3));
  });

  it('is stable for identical input', () => {
    expect(filesSignature([file()], 30)).toBe(filesSignature([file()], 30));
  });
});

describe('getAnalysisBadge', () => {
  it('returns null for completed documents', () => {
    expect(getAnalysisBadge(file({ analysisStatus: 'completed' }))).toBeNull();
  });

  it('shows analyzing for pending documents', () => {
    expect(getAnalysisBadge(file({ analysisStatus: 'pending' }))?.state).toBe(
      'analyzing',
    );
  });

  it('shows failed with a retry hint and never claims it is printable', () => {
    const badge = getAnalysisBadge(file({ analysisStatus: 'failed' }));
    expect(badge?.state).toBe('failed');
    expect(badge?.text).toBe(ANALYSIS_FAILED_TEXT);
    expect(ANALYSIS_FAILED_TEXT.toLowerCase()).not.toContain('still printable');
    expect(ANALYSIS_FAILED_TEXT.toLowerCase()).toContain('retry');
  });
});

describe('decideContinueAction', () => {
  it('proceeds when analysis is completed', () => {
    expect(decideContinueAction(file())).toBe('proceed');
  });

  it('waits while analysis is pending or unknown', () => {
    expect(decideContinueAction(file({ analysisStatus: 'pending' }))).toBe(
      'wait',
    );
    expect(decideContinueAction(file({ analysisStatus: undefined }))).toBe(
      'wait',
    );
    expect(decideContinueAction(null)).toBe('wait');
  });

  it('retries analysis instead of dead-ending when it failed', () => {
    expect(decideContinueAction(file({ analysisStatus: 'failed' }))).toBe(
      'retry-then-wait',
    );
  });
});

describe('pollDocumentAnalysis', () => {
  function harness(
    responses: Array<
      | { ok: true; documents: UploadedFile[] }
      | { ok: false }
      | Error
    >,
  ) {
    let t = 0;
    let i = 0;
    const fetchSession = jest.fn(async () => {
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    });
    const sleep = jest.fn(async (ms: number) => {
      t += ms;
    });
    return {
      fetchSession,
      sleep,
      now: () => t,
      base: {
        documentId: 'doc-1',
        isCancelled: () => false,
        intervalMs: 750,
        timeoutMs: ANALYSIS_WAIT_TIMEOUT_MS,
      },
    };
  }

  it('resolves ready once analysis completes', async () => {
    const h = harness([
      { ok: true, documents: [file({ analysisStatus: 'pending' })] },
      { ok: true, documents: [file({ analysisStatus: 'completed' })] },
    ]);
    const result = await pollDocumentAnalysis({ ...h.base, ...h });
    expect(result.ready).toBe(true);
  });

  it('gives up with a message when analysis never finishes', async () => {
    const h = harness([
      { ok: true, documents: [file({ analysisStatus: 'pending' })] },
    ]);
    const result = await pollDocumentAnalysis({ ...h.base, ...h });
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.message).toMatch(/longer than expected/i);
    expect(h.fetchSession.mock.calls.length).toBeLessThan(
      ANALYSIS_WAIT_TIMEOUT_MS / 750 + 5,
    );
  });

  it('still times out when every poll throws', async () => {
    const h = harness([new Error('network')]);
    const result = await pollDocumentAnalysis({ ...h.base, ...h });
    expect(result.ready).toBe(false);
  });

  it('survives a transient network error and keeps polling', async () => {
    const h = harness([
      new Error('network'),
      { ok: true, documents: [file({ analysisStatus: 'completed' })] },
    ]);
    const result = await pollDocumentAnalysis({ ...h.base, ...h });
    expect(result.ready).toBe(true);
  });

  it('reports the server error for failed analysis', async () => {
    const h = harness([
      {
        ok: true,
        documents: [
          file({ analysisStatus: 'failed', analysisError: 'Corrupt PDF' }),
        ],
      },
    ]);
    const result = await pollDocumentAnalysis({ ...h.base, ...h });
    expect(result).toEqual({ ready: false, message: 'Corrupt PDF' });
  });

  it('reports an expired session and a missing document', async () => {
    const expired = await pollDocumentAnalysis({
      ...harness([{ ok: false }]).base,
      ...harness([{ ok: false }]),
    });
    expect(expired.ready).toBe(false);

    const missing = harness([{ ok: true, documents: [] }]);
    const result = await pollDocumentAnalysis({ ...missing.base, ...missing });
    expect(result.ready).toBe(false);
  });

  it('stops quietly when cancelled', async () => {
    const h = harness([
      { ok: true, documents: [file({ analysisStatus: 'pending' })] },
    ]);
    const result = await pollDocumentAnalysis({
      ...h.base,
      ...h,
      isCancelled: () => true,
    });
    expect(result).toEqual({ ready: false, message: '' });
  });
});

describe('createCoalescedRunner', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('does not start a second concurrent run from runIfIdle', async () => {
    const gate = deferred();
    const fn = jest.fn(() => gate.promise);
    const runner = createCoalescedRunner(fn);

    const first = runner.runIfIdle();
    void runner.runIfIdle();
    void runner.runIfIdle();
    expect(fn).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reruns once after the current run when run() is called meanwhile', async () => {
    const gates = [deferred(), deferred()];
    let call = 0;
    const fn = jest.fn(() => gates[call++].promise);
    const runner = createCoalescedRunner(fn);

    const first = runner.run();
    const second = runner.run();
    void runner.run();
    expect(fn).toHaveBeenCalledTimes(1);

    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(2);
    gates[1].resolve();
    await Promise.all([first, second]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('can run again after finishing, even after a failure', async () => {
    const fn = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const runner = createCoalescedRunner(fn);
    await expect(runner.run()).rejects.toThrow('boom');
    await expect(runner.run()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('createSessionSocket', () => {
  function fakeSocket() {
    const socket = {
      on: jest.fn(),
      emit: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
    };
    return socket as typeof socket & SocketLike;
  }

  it('creates one socket and registers handlers once across refreshes', () => {
    const socket = fakeSocket();
    const factory = jest.fn(() => socket);
    const register = jest.fn();
    const binder = createSessionSocket(factory, register);

    binder.attach('s1');
    binder.attach('s2');
    binder.attach('s3');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('leaves the old room by reconnecting, then joins the new session', () => {
    const socket = fakeSocket();
    const binder = createSessionSocket(() => socket, jest.fn());

    binder.attach('s1');
    expect(socket.disconnect).not.toHaveBeenCalled();
    binder.attach('s2');

    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenLastCalledWith('joinSession', 's2');
  });

  it('ignores re-attaching the same session', () => {
    const socket = fakeSocket();
    const binder = createSessionSocket(() => socket, jest.fn());
    binder.attach('s1');
    binder.attach('s1');
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });

  it('does nothing when socket.io is not loaded', () => {
    const register = jest.fn();
    const binder = createSessionSocket(undefined, register);
    expect(() => binder.attach('s1')).not.toThrow();
    expect(register).not.toHaveBeenCalled();
  });
});
