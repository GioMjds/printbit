/**
 * @jest-environment jsdom
 */
import {
  IDLE_LOTTIE_RENDER_CONFIG,
  IdleLottieStage,
  type IdleLottiePlayer,
} from './idle-lottie';

type EventName = 'load' | 'loadError' | 'renderError';

class FakePlayer implements IdleLottiePlayer {
  private listeners = new Map<EventName, Array<() => void>>();
  load = jest.fn();
  setFrame = jest.fn();
  destroy = jest.fn();
  totalFrames = 60;
  duration = 2;
  addEventListener(type: EventName, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: EventName): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const SLIDE_A = { src: '/a.lottie', poster: '/a.svg' };
const SLIDE_B = { src: '/b.lottie', poster: '/b.svg' };

function setup(
  options: { reducedMotion?: boolean; createThrows?: boolean } = {},
) {
  const canvas = document.createElement('canvas');
  const poster = document.createElement('img');
  const players: FakePlayer[] = [];
  const createPlayer = jest.fn(() => {
    if (options.createThrows) throw new Error('wasm failed');
    const player = new FakePlayer();
    players.push(player);
    return player;
  });
  const fetchAsset = jest.fn(async (_src: string) => new ArrayBuffer(8));
  const stage = new IdleLottieStage({
    canvas,
    poster,
    createPlayer,
    fetchAsset,
    reducedMotion: options.reducedMotion ?? false,
  });
  return { stage, canvas, poster, players, createPlayer, fetchAsset };
}

describe('IdleLottieStage', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
  });

  it('uses one player for every slide and never autoplays', async () => {
    const { stage, players, createPlayer } = setup();
    await stage.prefetch([SLIDE_A.src, SLIDE_B.src]);
    stage.resume();
    stage.show(SLIDE_A);
    stage.show(SLIDE_B);
    expect(createPlayer).toHaveBeenCalledTimes(1);
    expect(players[0].load).toHaveBeenLastCalledWith({
      data: expect.any(ArrayBuffer),
      autoplay: false,
      loop: false,
      renderConfig: IDLE_LOTTIE_RENDER_CONFIG,
    });
    stage.destroy();
  });

  it('steps frames at 30 Hz from elapsed time after load', async () => {
    const { stage, canvas, poster, players } = setup();
    await stage.prefetch([SLIDE_A.src]);
    stage.resume();
    stage.show(SLIDE_A);
    players[0].emit('load');
    expect(canvas.hidden).toBe(false);
    expect(poster.hidden).toBe(true);
    players[0].setFrame.mockClear();
    jest.advanceTimersByTime(990);
    expect(players[0].setFrame).toHaveBeenCalledTimes(30);
    // Last tick at 990 ms of a 2 s, 60-frame animation: floor(0.495 * 60).
    expect(players[0].setFrame).toHaveBeenLastCalledWith(29);
    expect(jest.getTimerCount()).toBe(1);
    stage.destroy();
  });

  it('shows the poster without loading when the asset is missing', async () => {
    const { stage, poster, players, fetchAsset } = setup();
    fetchAsset.mockRejectedValueOnce(new Error('404'));
    await stage.prefetch([SLIDE_A.src]);
    stage.resume();
    stage.show(SLIDE_A);
    expect(players).toHaveLength(0);
    expect(poster.hidden).toBe(false);
    expect(poster.getAttribute('src')).toBe('/a.svg');
  });

  it('shows the poster on loadError', async () => {
    const { stage, canvas, poster, players } = setup();
    await stage.prefetch([SLIDE_A.src]);
    stage.resume();
    stage.show(SLIDE_A);
    players[0].emit('loadError');
    expect(canvas.hidden).toBe(true);
    expect(poster.hidden).toBe(false);
    expect(poster.getAttribute('src')).toBe('/a.svg');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('destroys the player after 3 failures in a row and stays on posters', async () => {
    const { stage, poster, players, createPlayer } = setup();
    await stage.prefetch([SLIDE_A.src, SLIDE_B.src]);
    stage.resume();
    for (let i = 0; i < 3; i += 1) {
      stage.show(SLIDE_A);
      players[0].emit('renderError');
    }
    expect(players[0].destroy).toHaveBeenCalledTimes(1);
    stage.show(SLIDE_B);
    expect(createPlayer).toHaveBeenCalledTimes(1);
    expect(poster.getAttribute('src')).toBe('/b.svg');
    expect(poster.hidden).toBe(false);
  });

  it('resets the failure count after a good load', async () => {
    const { stage, players } = setup();
    await stage.prefetch([SLIDE_A.src]);
    stage.resume();
    const fail = () => {
      stage.show(SLIDE_A);
      players[0].emit('loadError');
    };
    fail();
    fail();
    stage.show(SLIDE_A);
    players[0].emit('load');
    fail();
    fail();
    expect(players[0].destroy).not.toHaveBeenCalled();
    stage.destroy();
  });

  it('falls back to posters when the player cannot be created', async () => {
    const { stage, poster } = setup({ createThrows: true });
    await stage.prefetch([SLIDE_A.src]);
    stage.resume();
    expect(() => stage.show(SLIDE_A)).not.toThrow();
    expect(poster.hidden).toBe(false);
  });

  it('stops the ticker on pause and restarts it on resume', async () => {
    const { stage, players } = setup();
    await stage.prefetch([SLIDE_A.src]);
    stage.resume();
    stage.show(SLIDE_A);
    players[0].emit('load');
    stage.pause();
    expect(jest.getTimerCount()).toBe(0);
    stage.resume();
    expect(jest.getTimerCount()).toBe(1);
    stage.destroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not start ticking when the load lands after pause', async () => {
    const { stage, players } = setup();
    await stage.prefetch([SLIDE_A.src]);
    stage.resume();
    stage.show(SLIDE_A);
    stage.pause();
    players[0].emit('load');
    expect(players[0].setFrame).toHaveBeenCalledTimes(1);
    expect(players[0].setFrame).toHaveBeenCalledWith(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shows a fixed middle frame and no ticker under reduced motion', async () => {
    const { stage, players } = setup({ reducedMotion: true });
    await stage.prefetch([SLIDE_A.src]);
    stage.resume();
    stage.show(SLIDE_A);
    players[0].emit('load');
    expect(players[0].setFrame).toHaveBeenLastCalledWith(30);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('hides a poster image that fails to load', () => {
    const { poster } = setup();
    poster.hidden = false;
    poster.dispatchEvent(new Event('error'));
    expect(poster.hidden).toBe(true);
  });
});
