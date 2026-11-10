import { fetchWithTimeout } from './fetch-with-timeout';

describe('fetchWithTimeout', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  it('returns the response when fetch finishes in time', async () => {
    const response = { ok: true } as Response;
    global.fetch = jest.fn().mockResolvedValue(response);

    await expect(
      fetchWithTimeout('/x', { method: 'POST' }, 1000, 'Scan'),
    ).resolves.toBe(response);
  });

  it('aborts and throws a timed-out error when fetch hangs', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    ) as typeof fetch;

    const pending = fetchWithTimeout('/x', {}, 5000, 'Scan');
    const assertion = expect(pending).rejects.toThrow(
      'Scan timed out after 5 seconds',
    );
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('rethrows non-timeout errors unchanged', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('network down'));

    await expect(fetchWithTimeout('/x', {}, 1000, 'Scan')).rejects.toThrow(
      'network down',
    );
  });
});
