import {
  adaptDotLottie,
  type DotLottieLike,
  type DotLottieLoadConfig,
} from './idle-dotlottie-adapter';
import { IDLE_LOTTIE_RENDER_CONFIG } from './idle-lottie';

type EventName = 'ready' | 'load' | 'loadError' | 'renderError';

/** Models DotLottie: load() is a no-op until async WASM init emits `ready`. */
class FakeDotLottie implements DotLottieLike {
  private listeners = new Map<EventName, Array<() => void>>();
  private coreReady = false;
  readonly loaded: DotLottieLoadConfig[] = [];
  setFrame = jest.fn();
  destroy = jest.fn();
  totalFrames = 60;
  duration = 2;
  load(config: DotLottieLoadConfig): void {
    if (!this.coreReady) return; // real runtime: this._dotLottieCore !== null && ...
    this.loaded.push(config);
  }
  addEventListener(type: EventName, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: EventName): void {
    if (type === 'ready') this.coreReady = true;
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const config = (n: number): DotLottieLoadConfig => ({
  data: new ArrayBuffer(n),
  autoplay: false,
  loop: false,
  renderConfig: IDLE_LOTTIE_RENDER_CONFIG,
});

describe('adaptDotLottie', () => {
  it('replays the latest load requested before the player is ready', () => {
    const fake = new FakeDotLottie();
    const player = adaptDotLottie(fake);
    player.load(config(1));
    player.load(config(2));
    expect(fake.loaded).toHaveLength(0);
    fake.emit('ready');
    expect(fake.loaded).toHaveLength(1);
    expect(fake.loaded[0].data.byteLength).toBe(2);
  });

  it('passes loads straight through once ready', () => {
    const fake = new FakeDotLottie();
    const player = adaptDotLottie(fake);
    fake.emit('ready');
    player.load(config(3));
    expect(fake.loaded).toHaveLength(1);
  });

  it('reports loadError on every later load after init failed', () => {
    const fake = new FakeDotLottie();
    const player = adaptDotLottie(fake);
    const onError = jest.fn();
    player.addEventListener('loadError', onError);
    player.load(config(1));
    fake.emit('loadError'); // WASM init failed: the only event the runtime sends
    expect(onError).toHaveBeenCalledTimes(1);
    player.load(config(2));
    player.load(config(3));
    expect(onError).toHaveBeenCalledTimes(3);
    expect(fake.loaded).toHaveLength(0);
  });

  it('treats a loadError after ready as an ordinary failure', () => {
    const fake = new FakeDotLottie();
    const player = adaptDotLottie(fake);
    const onError = jest.fn();
    player.addEventListener('loadError', onError);
    fake.emit('ready');
    player.load(config(1));
    fake.emit('loadError');
    player.load(config(2));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(fake.loaded).toHaveLength(2);
  });

  it('forwards frames, sizes, and destroy', () => {
    const fake = new FakeDotLottie();
    const player = adaptDotLottie(fake);
    player.setFrame(7);
    player.destroy();
    expect(fake.setFrame).toHaveBeenCalledWith(7);
    expect(fake.destroy).toHaveBeenCalled();
    expect(player.totalFrames).toBe(60);
    expect(player.duration).toBe(2);
  });
});
