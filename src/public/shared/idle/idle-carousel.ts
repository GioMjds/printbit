import {
  IDLE_SLIDE_DURATION_DEFAULT_SECONDS,
  type IdleInfo,
  type IdleSlideId,
} from '@/shared/idle-screen-contract';
import type { IdleLang } from './idle-copy';
import { buildPlaylist, type IdlePlaylist } from './idle-slides';

export interface IdleCarouselDeps {
  getInfo: () => IdleInfo | null;
  showSlide: (id: IdleSlideId, lang: IdleLang, durationMs: number) => void;
}

/** Steps through playlists with one setTimeout chain. */
export class IdleCarousel {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cycleIndex = -1;
  private position = 0;
  private playlist: IdlePlaylist | null = null;
  private rebuildPending = false;
  private lastShown: IdleSlideId | null = null;

  constructor(private readonly deps: IdleCarouselDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.cycleIndex = -1;
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
      this.playlist = buildPlaylist(info, this.cycleIndex);
      this.position = this.playlist.slides[0] === this.lastShown ? 1 : 0;
    }
    if (!this.playlist || this.position >= this.playlist.slides.length) {
      this.cycleIndex += 1;
      this.playlist = buildPlaylist(info, this.cycleIndex);
      this.position = 0;
      // A fresh build already uses the latest info.
      this.rebuildPending = false;
    }

    const id = this.playlist.slides[this.position];
    this.position += 1;
    this.lastShown = id;
    const seconds =
      info?.settings.slideDurationSeconds ?? IDLE_SLIDE_DURATION_DEFAULT_SECONDS;
    const durationMs = seconds * 1000;
    this.deps.showSlide(id, this.playlist.lang, durationMs);
    this.timer = setTimeout(() => this.step(), durationMs);
  }
}
