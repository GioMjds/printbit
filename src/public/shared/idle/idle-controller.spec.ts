/**
 * @jest-environment jsdom
 */
jest.mock('./idle-dotlottie', () => ({
  createDotLottiePlayer: jest.fn(() => {
    throw new Error('real player must not be used in tests');
  }),
  fetchLottieAsset: jest.fn(),
}));

import {
  createDefaultIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';
import { createIdleAttract } from './idle-controller';
import type { IdleLottiePlayer } from './idle-lottie';

const MARKUP = `
  <div id="idleOverlay" data-i18n-skip>
    <ul data-idle="chips">
      <li data-service="print" data-state="unknown"><span data-idle="chip-name"></span><span data-idle="chip-state"></span></li>
      <li data-service="copy" data-state="unknown"><span data-idle="chip-name"></span><span data-idle="chip-state"></span></li>
      <li data-service="scan" data-state="unknown"><span data-idle="chip-name"></span><span data-idle="chip-state"></span></li>
    </ul>
    <span data-idle="clock-time"></span><span data-idle="clock-date"></span>
    <div data-idle="slide">
      <img data-idle="poster" hidden />
      <canvas data-idle="canvas" hidden></canvas>
      <p data-idle="eyebrow"></p><h2 data-idle="title"></h2><p data-idle="body"></p>
      <ol data-idle="steps"></ol>
    </div>
    <p data-idle="status-line"></p>
    <span data-idle="progress"></span>
    <p data-idle="cta"></p>
  </div>`;

const INFO: IdleInfo = {
  settings: createDefaultIdleScreenSettings(),
  pricing: { printBwFrom: 3, printColorFrom: 18, copyBw: 3, copyColor: 5, scan: 5 },
  services: {
    print: { state: 'ready', reason: null },
    copy: { state: 'unavailable', reason: 'paper_out' },
    scan: { state: 'ready', reason: null },
  },
  paper: { level: 'out' },
  change: { exactCoinsOnly: false },
  coins: [1, 5, 10, 20],
  maxUploadMb: 25,
  wordUploads: true,
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function makePlayer(): IdleLottiePlayer {
  return {
    load: jest.fn(),
    setFrame: jest.fn(),
    addEventListener: jest.fn(),
    totalFrames: 60,
    duration: 2,
    destroy: jest.fn(),
  };
}

function setup(fetchInfo: () => Promise<IdleInfo>) {
  document.body.innerHTML = MARKUP;
  const root = document.getElementById('idleOverlay')!;
  const createPlayer = jest.fn(makePlayer);
  const attract = createIdleAttract(root, {
    fetchInfo,
    fetchAsset: async () => new ArrayBuffer(8),
    createPlayer,
    reducedMotion: true,
  })!;
  const text = (hook: string) =>
    root.querySelector(`[data-idle="${hook}"]`)!.textContent;
  return { root, attract, createPlayer, text };
}

describe('createIdleAttract', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('returns null when the markup is incomplete', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    document.body.innerHTML = '<div id="x"></div>';
    expect(createIdleAttract(document.getElementById('x')!)).toBeNull();
    warn.mockRestore();
  });

  it('renders text and Checking… chips before idle info arrives', async () => {
    const { root, attract, text } = setup(() => new Promise<IdleInfo>(() => {}));
    attract.start();
    await flush();
    expect(text('title')).toBe('Print, copy, and scan.');
    expect(text('cta')).toBe('Tap anywhere to start');
    const printChip = root.querySelector('[data-service="print"]') as HTMLElement;
    expect(printChip.dataset.state).toBe('unknown');
    expect(printChip.textContent).toContain('Checking…');
    attract.stop();
  });

  it('shows live chip states once idle info arrives', async () => {
    const { root, attract, text } = setup(async () => INFO);
    attract.start();
    await flush();
    const copyChip = root.querySelector('[data-service="copy"]') as HTMLElement;
    expect(copyChip.dataset.state).toBe('unavailable');
    expect(text('status-line')).toContain('Copy — Unavailable: out of paper');
    attract.stop();
  });

  it('leaves no timers after stop and reuses one player across restarts', async () => {
    const { attract, createPlayer } = setup(async () => INFO);
    attract.start();
    await flush();
    jest.advanceTimersByTime(8000);
    await flush();
    attract.stop();
    expect(jest.getTimerCount()).toBe(0);

    attract.start();
    await flush();
    jest.advanceTimersByTime(8000);
    await flush();
    attract.stop();
    expect(jest.getTimerCount()).toBe(0);
    expect(createPlayer).toHaveBeenCalledTimes(1);
  });

  it('ignores visibility changes after stop', async () => {
    const { attract } = setup(async () => INFO);
    attract.start();
    await flush();
    attract.stop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(jest.getTimerCount()).toBe(0);
  });
});
