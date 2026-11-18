import type { IdleLottiePlayer } from './idle-lottie';

export type DotLottieLoadConfig = Parameters<IdleLottiePlayer['load']>[0];

/** The slice of DotLottie the adapter uses (kept small so tests can fake it). */
export interface DotLottieLike {
  load(config: DotLottieLoadConfig): void;
  setFrame(frame: number): void;
  addEventListener(
    type: 'ready' | 'load' | 'loadError' | 'renderError',
    listener: () => void,
  ): void;
  readonly totalFrames: number;
  readonly duration: number;
  destroy(): void;
}

/**
 * DotLottie starts its WASM core asynchronously and silently ignores load()
 * until the core exists (`ready`). If init fails it sends one `loadError` and
 * then stays inert. This adapter hides both: loads requested before `ready`
 * are replayed (latest wins), and after an init failure every load reports
 * `loadError` at once so the stage shows that slide's poster.
 */
export function adaptDotLottie(player: DotLottieLike): IdleLottiePlayer {
  let ready = false;
  let initFailed = false;
  let pending: DotLottieLoadConfig | null = null;
  const errorListeners: Array<() => void> = [];

  player.addEventListener('ready', () => {
    ready = true;
    if (pending) {
      const config = pending;
      pending = null;
      player.load(config);
    }
  });
  // Registered before any caller listener, so the flag is set first.
  player.addEventListener('loadError', () => {
    if (!ready) {
      initFailed = true;
      pending = null;
    }
  });

  return {
    load(config) {
      if (initFailed) {
        for (const listener of errorListeners) listener();
        return;
      }
      if (!ready) {
        pending = config;
        return;
      }
      player.load(config);
    },
    setFrame: (frame) => player.setFrame(frame),
    addEventListener(type, listener) {
      if (type === 'loadError') errorListeners.push(listener);
      player.addEventListener(type, () => listener());
    },
    get totalFrames() {
      return player.totalFrames;
    },
    get duration() {
      return player.duration;
    },
    destroy: () => player.destroy(),
  };
}
