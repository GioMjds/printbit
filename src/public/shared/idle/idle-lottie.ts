/**
 * One Lottie player for the whole idle screen. The player's own playback loop
 * is never started; frames are stepped from one 30 Hz interval so rendering
 * cost is capped whatever frame rate a slot file was authored at.
 */

export const IDLE_LOTTIE_FPS = 30;
/** Whole milliseconds so timers fire on a stable grid (33 ms ≈ 30 Hz). */
export const IDLE_LOTTIE_FRAME_MS = Math.round(1000 / IDLE_LOTTIE_FPS);
export const IDLE_LOTTIE_MAX_FAILURES = 3;
export const IDLE_LOTTIE_RENDER_CONFIG = {
  devicePixelRatio: 1,
  autoResize: true,
  freezeOnOffscreen: true,
};

export interface IdleLottiePlayer {
  load(config: {
    data: ArrayBuffer;
    autoplay: boolean;
    loop: boolean;
    renderConfig: typeof IDLE_LOTTIE_RENDER_CONFIG;
  }): void;
  setFrame(frame: number): void;
  addEventListener(
    type: 'load' | 'loadError' | 'renderError',
    listener: () => void,
  ): void;
  readonly totalFrames: number;
  /** Seconds. */
  readonly duration: number;
  destroy(): void;
}

export interface IdleStageSlide {
  src: string;
  poster: string;
}

export interface IdleLottieStageDeps {
  canvas: HTMLCanvasElement;
  poster: HTMLImageElement;
  createPlayer: (canvas: HTMLCanvasElement) => IdleLottiePlayer;
  fetchAsset: (src: string) => Promise<ArrayBuffer>;
  reducedMotion: boolean;
  now?: () => number;
}

export class IdleLottieStage {
  private player: IdleLottiePlayer | null = null;
  private playerUnavailable = false;
  private readonly buffers = new Map<string, ArrayBuffer>();
  private failures = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private current: IdleStageSlide | null = null;
  private loaded = false;
  private paused = true;

  constructor(private readonly deps: IdleLottieStageDeps) {
    deps.poster.addEventListener('error', () => {
      deps.poster.hidden = true;
    });
  }

  /** Fetch slot files once; a failed fetch leaves that slide on its poster. */
  async prefetch(srcs: readonly string[]): Promise<void> {
    const missing = srcs.filter((src) => !this.buffers.has(src));
    await Promise.all(
      missing.map(async (src) => {
        try {
          this.buffers.set(src, await this.deps.fetchAsset(src));
        } catch (error) {
          console.warn(`[IdleScreen] Lottie slot ${src} unavailable.`, error);
        }
      }),
    );
  }

  show(slide: IdleStageSlide): void {
    this.stopTicker();
    this.current = slide;
    this.loaded = false;
    const data = this.buffers.get(slide.src);
    const player = data ? this.ensurePlayer() : null;
    if (!data || !player) {
      this.showPoster();
      return;
    }
    this.deps.canvas.hidden = true;
    player.load({
      data,
      autoplay: false,
      loop: false,
      renderConfig: IDLE_LOTTIE_RENDER_CONFIG,
    });
  }

  pause(): void {
    this.paused = true;
    this.stopTicker();
  }

  resume(): void {
    this.paused = false;
    if (this.loaded && !this.deps.reducedMotion) this.startTicker();
  }

  destroy(): void {
    this.pause();
    this.player?.destroy();
    this.player = null;
  }

  private ensurePlayer(): IdleLottiePlayer | null {
    if (this.player || this.playerUnavailable) return this.player;
    try {
      const player = this.deps.createPlayer(this.deps.canvas);
      player.addEventListener('load', () => this.onLoaded());
      player.addEventListener('loadError', () => this.onFailed());
      player.addEventListener('renderError', () => this.onFailed());
      this.player = player;
    } catch (error) {
      console.warn(
        '[IdleScreen] Lottie player unavailable; using posters.',
        error,
      );
      this.playerUnavailable = true;
    }
    return this.player;
  }

  private onLoaded(): void {
    const player = this.player;
    if (!player) return;
    this.failures = 0;
    this.loaded = true;
    this.deps.canvas.hidden = false;
    this.deps.poster.hidden = true;
    if (this.deps.reducedMotion) {
      player.setFrame(Math.floor(player.totalFrames / 2));
      return;
    }
    player.setFrame(0);
    if (!this.paused) this.startTicker();
  }

  private onFailed(): void {
    this.loaded = false;
    this.stopTicker();
    this.showPoster();
    this.failures += 1;
    if (this.failures >= IDLE_LOTTIE_MAX_FAILURES && this.player) {
      this.player.destroy();
      this.player = null;
      this.playerUnavailable = true;
    }
  }

  private showPoster(): void {
    this.deps.canvas.hidden = true;
    if (!this.current) return;
    this.deps.poster.src = this.current.poster;
    this.deps.poster.hidden = false;
  }

  private startTicker(): void {
    this.stopTicker();
    this.startedAt = (this.deps.now ?? Date.now)();
    this.ticker = setInterval(() => this.tick(), IDLE_LOTTIE_FRAME_MS);
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private tick(): void {
    const player = this.player;
    if (!player || player.totalFrames <= 0 || player.duration <= 0) return;
    const elapsedSeconds =
      ((this.deps.now ?? Date.now)() - this.startedAt) / 1000;
    const progress = (elapsedSeconds % player.duration) / player.duration;
    player.setFrame(
      Math.min(
        player.totalFrames - 1,
        Math.floor(progress * player.totalFrames),
      ),
    );
  }
}
