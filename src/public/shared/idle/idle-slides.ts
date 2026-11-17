import {
  createDefaultIdleScreenSettings,
  isDisableableIdleSlideId,
  type IdleInfo,
  type IdleServiceName,
  type IdleSlideId,
} from '@/shared/idle-screen-contract';

const SLOT_BASE = '/assets/lottie/idle';

export interface IdleSlideDef {
  id: IdleSlideId;
  /** Slot file. Overwrite the file to swap the animation; no code change. */
  src: string;
  /** Static fallback shown when the animation cannot render. */
  poster: string;
  /** Slide is skipped while this service is unavailable. */
  service: IdleServiceName | null;
  disableable: boolean;
}

const slot = (
  id: IdleSlideId,
  file: string,
  service: IdleServiceName | null,
): IdleSlideDef => ({
  id,
  src: `${SLOT_BASE}/${file}.lottie`,
  poster: `${SLOT_BASE}/posters/${file}.svg`,
  service,
  disableable: isDisableableIdleSlideId(id),
});

export const IDLE_SLIDES: readonly IdleSlideDef[] = [
  slot('welcome', 'welcome', null),
  slot('howToPrint', 'how-to-print', 'print'),
  slot('howToCopy', 'how-to-copy', 'copy'),
  slot('idCardCopy', 'id-card-copy', 'copy'),
  slot('scanToPhone', 'scan-to-phone', 'scan'),
  slot('prices', 'prices', null),
  slot('paying', 'paying', null),
  slot('supportedFiles', 'supported-files', 'print'),
  slot('privacyReceipt', 'privacy-receipt', null),
];

export function getSlideDef(id: IdleSlideId): IdleSlideDef {
  const def = IDLE_SLIDES.find((slide) => slide.id === id);
  if (!def) throw new Error(`Unknown idle slide: ${id}`);
  return def;
}

/**
 * Orders one cycle of slides. Disabled slides, slides for unavailable
 * services, and prices without pricing data are dropped.
 */
export function buildPlaylist(info: IdleInfo | null): IdleSlideId[] {
  const settings = info?.settings ?? createDefaultIdleScreenSettings();
  return IDLE_SLIDES.filter((slide) => {
    if (
      slide.disableable &&
      isDisableableIdleSlideId(slide.id) &&
      !settings.slides[slide.id]
    ) {
      return false;
    }
    if (slide.service && info?.services[slide.service].state === 'unavailable') {
      return false;
    }
    if (slide.id === 'prices' && !info?.pricing) return false;
    return true;
  }).map((slide) => slide.id);
}

/** Changes only when something that reorders the playlist changes. */
export function playlistSignature(info: IdleInfo | null): string {
  if (!info) return 'none';
  return JSON.stringify([
    info.settings,
    info.services.print.state,
    info.services.copy.state,
    info.services.scan.state,
    info.change.exactCoinsOnly,
    info.pricing === null,
  ]);
}
