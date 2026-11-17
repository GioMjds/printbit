/**
 * Contract for the homepage idle (attract) screen, shared by the server
 * route GET /api/idle/info, the admin settings, and the kiosk client.
 */

export const IDLE_SLIDE_IDS = [
  'welcome',
  'status',
  'howToPrint',
  'howToCopy',
  'idCardCopy',
  'scanToPhone',
  'prices',
  'paying',
  'supportedFiles',
  'privacyReceipt',
] as const;
export type IdleSlideId = (typeof IDLE_SLIDE_IDS)[number];

/** Every slide except `welcome` and `status`, which always show. */
export const DISABLEABLE_IDLE_SLIDE_IDS = [
  'howToPrint',
  'howToCopy',
  'idCardCopy',
  'scanToPhone',
  'prices',
  'paying',
  'supportedFiles',
  'privacyReceipt',
] as const;
export type DisableableIdleSlideId = (typeof DISABLEABLE_IDLE_SLIDE_IDS)[number];

export function isDisableableIdleSlideId(
  value: string,
): value is DisableableIdleSlideId {
  return (DISABLEABLE_IDLE_SLIDE_IDS as readonly string[]).includes(value);
}

export type IdleServiceName = 'print' | 'copy' | 'scan';
export type IdleServiceState = 'ready' | 'limited' | 'unavailable' | 'unknown';
export type IdleServiceReason =
  | 'printer_offline'
  | 'printer_error'
  | 'paper_out'
  | 'paper_low'
  | 'scanner_unavailable';

export interface IdleServiceStatus {
  state: IdleServiceState;
  reason: IdleServiceReason | null;
}

export type IdlePaperLevel = 'ok' | 'low' | 'out' | 'unknown';

export interface IdleScreenSettings {
  slideDurationSeconds: number;
  slides: Record<DisableableIdleSlideId, boolean>;
}

export interface IdlePricingSummary {
  printBwFrom: number;
  printColorFrom: number;
  copyBw: number;
  copyColor: number;
  scan: number;
}

export interface IdleInfo {
  settings: IdleScreenSettings;
  pricing: IdlePricingSummary | null;
  services: Record<IdleServiceName, IdleServiceStatus>;
  paper: { level: IdlePaperLevel };
  change: { exactCoinsOnly: boolean };
  coins: number[];
  maxUploadMb: number;
  wordUploads: boolean;
}

export const IDLE_SLIDE_DURATION_MIN_SECONDS = 5;
export const IDLE_SLIDE_DURATION_MAX_SECONDS = 20;
export const IDLE_SLIDE_DURATION_DEFAULT_SECONDS = 8;

export function createDefaultIdleScreenSettings(): IdleScreenSettings {
  const slides = {} as Record<DisableableIdleSlideId, boolean>;
  for (const id of DISABLEABLE_IDLE_SLIDE_IDS) slides[id] = true;
  return { slideDurationSeconds: IDLE_SLIDE_DURATION_DEFAULT_SECONDS, slides };
}

function isValidDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= IDLE_SLIDE_DURATION_MIN_SECONDS &&
    value <= IDLE_SLIDE_DURATION_MAX_SECONDS
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads stored settings, keeping valid values and defaulting the rest. */
export function normalizeIdleScreenSettings(raw: unknown): IdleScreenSettings {
  const result = createDefaultIdleScreenSettings();
  if (!isPlainObject(raw)) return result;
  if (isValidDuration(raw.slideDurationSeconds)) {
    result.slideDurationSeconds = raw.slideDurationSeconds;
  }
  if (isPlainObject(raw.slides)) {
    for (const [key, value] of Object.entries(raw.slides)) {
      if (isDisableableIdleSlideId(key) && typeof value === 'boolean') {
        result.slides[key] = value;
      }
    }
  }
  return result;
}

export interface IdleScreenSettingsPatch {
  slideDurationSeconds?: number;
  slides?: Partial<Record<DisableableIdleSlideId, boolean>>;
}

export type IdleScreenPatchResult =
  | { ok: true; patch: IdleScreenSettingsPatch }
  | { ok: false; error: string };

/** Validates a partial `idleScreen` object from PUT /api/admin/settings. */
export function validateIdleScreenSettingsPatch(
  raw: unknown,
): IdleScreenPatchResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'idleScreen must be an object.' };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'slideDurationSeconds' && key !== 'slides') {
      return { ok: false, error: `idleScreen.${key} is not a known field.` };
    }
  }

  const patch: IdleScreenSettingsPatch = {};
  if (raw.slideDurationSeconds !== undefined) {
    if (!isValidDuration(raw.slideDurationSeconds)) {
      return {
        ok: false,
        error: `idleScreen.slideDurationSeconds must be a whole number between ${IDLE_SLIDE_DURATION_MIN_SECONDS} and ${IDLE_SLIDE_DURATION_MAX_SECONDS}.`,
      };
    }
    patch.slideDurationSeconds = raw.slideDurationSeconds;
  }

  if (raw.slides !== undefined) {
    if (!isPlainObject(raw.slides)) {
      return { ok: false, error: 'idleScreen.slides must be an object.' };
    }
    const slides: Partial<Record<DisableableIdleSlideId, boolean>> = {};
    for (const [key, value] of Object.entries(raw.slides)) {
      if (!isDisableableIdleSlideId(key)) {
        return {
          ok: false,
          error: `idleScreen.slides.${key} is not a slide that can be turned off.`,
        };
      }
      if (typeof value !== 'boolean') {
        return {
          ok: false,
          error: `idleScreen.slides.${key} must be true or false.`,
        };
      }
      slides[key] = value;
    }
    patch.slides = slides;
  }

  return { ok: true, patch };
}

export function applyIdleScreenSettingsPatch(
  current: IdleScreenSettings,
  patch: IdleScreenSettingsPatch,
): IdleScreenSettings {
  return {
    slideDurationSeconds:
      patch.slideDurationSeconds ?? current.slideDurationSeconds,
    slides: { ...current.slides, ...patch.slides },
  };
}

/** True when the idle screen should lead with the status slide. */
export function isIdleDegraded(info: IdleInfo | null): boolean {
  if (!info) return false;
  if (info.change.exactCoinsOnly) return true;
  return Object.values(info.services).some(
    (service) =>
      service.state === 'limited' || service.state === 'unavailable',
  );
}
