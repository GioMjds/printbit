import {
  IDLE_SLIDE_DURATION_DEFAULT_SECONDS,
  type IdleInfo,
  type IdleSlideId,
} from '@/shared/idle-screen-contract';
import { buildPlaylist } from './idle-slides';

export interface IdleCarouselDeps {
  getInfo: () => IdleInfo | null;
  showSlide: (id: IdleSlideId, durationMs: number) => void;
}

/** Steps through playlists with one setTimeout chain. */
export class IdleCarousel {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private position = 0;
  private playlist: IdleSlideId[] | null = null;
  private rebuildPending = false;
  private lastShown: IdleSlideId | null = null;

  constructor(private readonly deps: IdleCarouselDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.position = 0;
    this.playlist = null;
    this.rebuildPending = false;
    this.lastShown = null;
    this.step();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Rebuild the current cycle's playlist before the next slide. */
  invalidate(): void {
    this.rebuildPending = true;
  }

  private step(): void {
    if (!this.running) return;
    const info = this.deps.getInfo();

    if (this.rebuildPending && this.playlist) {
      this.rebuildPending = false;
      this.playlist = buildPlaylist(info);
      this.position = this.playlist[0] === this.lastShown ? 1 : 0;
    }
    if (!this.playlist || this.position >= this.playlist.length) {
      this.playlist = buildPlaylist(info);
      this.position = 0;
      // A fresh build already uses the latest info.
      this.rebuildPending = false;
    }

    const id = this.playlist[this.position];
    this.position += 1;
    this.lastShown = id;
    const seconds =
      info?.settings.slideDurationSeconds ?? IDLE_SLIDE_DURATION_DEFAULT_SECONDS;
    const durationMs = seconds * 1000;
    this.deps.showSlide(id, durationMs);
    this.timer = setTimeout(() => this.step(), durationMs);
  }
}
