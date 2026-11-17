import type { IdleInfo } from '@/shared/idle-screen-contract';
import { IdleStatusPoller } from './idle-status';

const INFO = { coins: [1] } as unknown as IdleInfo;
const LATER = { coins: [5] } as unknown as IdleInfo;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('IdleStatusPoller', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fetches at start and every 30 s while running, then stops cleanly', async () => {
    const fetchInfo = jest.fn().mockResolvedValue(INFO);
    const onUpdate = jest.fn();
    const poller = new IdleStatusPoller({ fetchInfo, onUpdate });

    poller.start();
    await flush();
    expect(fetchInfo).toHaveBeenCalledTimes(1);
    expect(poller.latest).toBe(INFO);
    expect(onUpdate).toHaveBeenCalledWith(INFO);

    jest.advanceTimersByTime(30_000);
    await flush();
    expect(fetchInfo).toHaveBeenCalledTimes(2);

    poller.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(90_000);
    await flush();
    expect(fetchInfo).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good info when a fetch fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchInfo = jest
      .fn()
      .mockResolvedValueOnce(INFO)
      .mockRejectedValueOnce(new Error('offline'));
    const poller = new IdleStatusPoller({ fetchInfo, onUpdate: jest.fn() });
    poller.start();
    await flush();
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(poller.latest).toBe(INFO);
    poller.stop();
    warn.mockRestore();
  });

  it('ignores a response that lands after stop', async () => {
    let resolve: (info: IdleInfo) => void = () => {};
    const fetchInfo = jest.fn(
      () =>
        new Promise<IdleInfo>((r) => {
          resolve = r;
        }),
    );
    const onUpdate = jest.fn();
    const poller = new IdleStatusPoller({ fetchInfo, onUpdate });
    poller.start();
    poller.stop();
    resolve(LATER);
    await flush();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(poller.latest).toBeNull();
  });

  it('does not start a second interval when started twice', async () => {
    const fetchInfo = jest.fn().mockResolvedValue(INFO);
    const poller = new IdleStatusPoller({ fetchInfo, onUpdate: jest.fn() });
    poller.start();
    poller.start();
    expect(jest.getTimerCount()).toBe(1);
    poller.stop();
  });
});
