import type { IdleInfo } from '@/shared/idle-screen-contract';
import { IdleCarousel } from './idle-carousel';
import { renderSlideText, type IdleLang } from './idle-copy';
import { createDotLottiePlayer, fetchLottieAsset } from './idle-dotlottie';
import { IdleLottieStage, type IdleLottiePlayer } from './idle-lottie';
import { IDLE_SLIDES, getSlideDef, playlistSignature } from './idle-slides';
import { IdleStatusPoller, fetchIdleInfo } from './idle-status';
import { IdleView, queryIdleViewElements } from './idle-view';

const CLOCK_REFRESH_MS = 30_000;

export interface IdleAttract {
  start(): void;
  stop(): void;
}

export interface IdleAttractOverrides {
  fetchInfo?: () => Promise<IdleInfo>;
  fetchAsset?: (src: string) => Promise<ArrayBuffer>;
  createPlayer?: (canvas: HTMLCanvasElement) => IdleLottiePlayer;
  reducedMotion?: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Wires the idle screen for one overlay. start() and stop() are called from
 * the idle overlay's onShow and onHide; after stop() no timer, listener, or
 * poll is left running.
 */
export function createIdleAttract(
  root: HTMLElement,
  overrides: IdleAttractOverrides = {},
): IdleAttract | null {
  const els = queryIdleViewElements(root);
  if (!els) {
    console.warn('[IdleScreen] Idle overlay markup is incomplete.');
    return null;
  }

  const reducedMotion = overrides.reducedMotion ?? prefersReducedMotion();
  const view = new IdleView(els, { reducedMotion });
  const stage = new IdleLottieStage({
    canvas: els.canvas,
    poster: els.poster,
    createPlayer: overrides.createPlayer ?? createDotLottiePlayer,
    fetchAsset: overrides.fetchAsset ?? fetchLottieAsset,
    reducedMotion,
  });

  let running = false;
  let lang: IdleLang = 'en';
  let lastSignature = playlistSignature(null);
  let clockTimer: ReturnType<typeof setInterval> | null = null;

  const poller = new IdleStatusPoller({
    fetchInfo: overrides.fetchInfo ?? fetchIdleInfo,
    onUpdate: (info) => {
      view.renderChips(info, lang);
      const signature = playlistSignature(info);
      if (signature !== lastSignature) {
        lastSignature = signature;
        carousel.invalidate();
      }
    },
  });

  const carousel = new IdleCarousel({
    getInfo: () => poller.latest,
    showSlide: (id, slideLang, durationMs) => {
      lang = slideLang;
      view.renderLanguage(lang);
      view.renderChips(poller.latest, lang);
      view.renderClock(new Date(), lang);
      view.showSlide(renderSlideText(id, lang, poller.latest), durationMs, () =>
        stage.show(getSlideDef(id)),
      );
    },
  });

  const onVisibilityChange = (): void => {
    if (document.hidden) stage.pause();
    else stage.resume();
  };

  return {
    start() {
      if (running) return;
      running = true;
      lang = 'en';
      view.renderLanguage(lang);
      view.renderChips(poller.latest, lang);
      view.renderClock(new Date(), lang);
      clockTimer = setInterval(
        () => view.renderClock(new Date(), lang),
        CLOCK_REFRESH_MS,
      );
      document.addEventListener('visibilitychange', onVisibilityChange);
      stage.resume();
      poller.start();
      void stage.prefetch(IDLE_SLIDES.map((slide) => slide.src)).then(() => {
        if (running) carousel.start();
      });
    },
    stop() {
      if (!running) return;
      running = false;
      carousel.stop();
      poller.stop();
      view.stop();
      stage.pause();
      if (clockTimer !== null) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
