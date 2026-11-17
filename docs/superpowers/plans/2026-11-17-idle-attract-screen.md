# Idle Attract Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the homepage's CSS-keyframe idle screen with an informative,
admin-configurable slide carousel that shows live kiosk status and prices and
animates through a single Lottie player.

**Architecture:** A new public route `GET /api/idle/info` builds one JSON
snapshot from printer, scanner, hopper, paper, pricing, and settings sources
through pure, tested functions. On the kiosk, a small set of client units
(poller, playlist builder, carousel, Lottie stage, DOM view) is wired by one
controller that starts when the existing idle overlay shows and stops when it
hides. One `DotLottie` instance is stepped by hand at 30 Hz; all other motion is
CSS `opacity`/`transform` transitions.

**Tech Stack:** TypeScript, Express, Jest (`ts-jest`, `jsdom` where DOM is
needed), `supertest`, `@lottiefiles/dotlottie-web` 0.79 (already installed),
esbuild client bundles, static HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-11-17-idle-attract-screen-design.md`

## Global Constraints

- Work on branch `feat/id-card-copy`. Do not create or switch branches.
- The working tree has unrelated uncommitted changes
  (`src/public/confirm/index.html`, `src/public/confirm/styles.css`,
  `src/public/scan/app.ts`, `worker/src/PrintBit.HardwareService/appsettings*.json`).
  Never stage them. Stage only the files each task names; never `git add -A` or
  `git add .`.
- Every commit message ends with these two lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014rjHKifhi2dZSffedNp7Z9
  ```
- No new npm dependencies.
- No CSS `@keyframes` anywhere in the idle screen. Idle motion is the Lottie
  canvas plus CSS `opacity` and `transform` transitions only.
- One `DotLottie` instance per page. Frames are stepped by one 30 Hz
  `setInterval`. `devicePixelRatio: 1`. The player's own playback is never
  started (`autoplay: false`, no `play()` calls).
- The overlay keeps `id="idleOverlay"`, the `is-visible` / `is-leaving` classes,
  and the 260 ms fade-out that `src/public/shared/idle-screen.ts` waits for.
- `GET /api/idle/info` is public and read-only, sends `Cache-Control: no-store`,
  and returns no error text, device names, or telemetry beyond the contract.
- Slide duration: whole seconds, 5 to 20, default 8. Status poll: every 30 s,
  only while the overlay is visible.
- Only the printer's own `E_NO_PAPER` error makes a service `unavailable` for
  paper. The staff-maintained `paperCurrentSheets` estimate can only produce
  `limited` / `paper_low`.
- Commands: tests `pnpm exec jest <path>`; typecheck
  `node_modules/.bin/tsc --noEmit -p tsconfig.json` (clean on the base commit);
  lint `pnpm lint`; client build `pnpm build`.

## Review Focus

1. **Kiosk static mode kills transitions.** `globals.css` sets
   `transition: none !important` on every element under
   `html[data-kiosk-static='true']`, which `index.html` always sets. Expected:
   the overlay fade, slide crossfade, and progress bar still animate. Pinned by
   the specificity rules in Task 12 and the manual check in Task 13.
2. **Boot flow `/?idle=boot`.** The overlay shows before the server timeout is
   fetched. Expected: the carousel starts and fills text immediately. Pinned by
   the controller start test in Task 11 and the manual check in Task 13.
3. **Tap while the Lottie is still loading.** The overlay hides before the
   player's `load` event fires. Expected: no frame ticker starts afterwards.
   Pinned by the "load arrives while paused" test in Task 9.
4. **First show before `/api/idle/info` answers.** Expected: chips read
   "Checking…", slides render, nothing throws. Pinned by the null-info tests in
   Tasks 7 and 11.
5. **Repeated show/hide cycles.** Expected: still one player, no leftover
   timers or listeners. Pinned by the start/stop/start test in Task 11.

---

## File map

| File                                                                                                 | Responsibility                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/shared/idle-screen-contract.ts` (new)                                                           | Slide ids, `IdleInfo` types, settings defaults/normalize/validate/apply, `isIdleDegraded`. Shared by server and client. |
| `src/shared/accepted-coins.ts` (new)                                                                 | `ACCEPTED_COIN_VALUES` list.                                                                                            |
| `src/core/database/models/admin.model.ts`                                                            | `idleScreen` field on `AdminSettings`.                                                                                  |
| `src/core/database/db.ts`                                                                            | `idleScreen` default and normalization.                                                                                 |
| `src/modules/admin/admin.controller.ts`                                                              | Validate and save `idleScreen` in `PUT /api/admin/settings`.                                                            |
| `src/modules/page/idle-info.ts` (new)                                                                | Pure `deriveIdleServices`, `summarizeIdlePricing`, `buildIdleInfo`.                                                     |
| `src/modules/page/idle-info.sources.ts` (new)                                                        | Wires real singletons into `buildIdleInfo`.                                                                             |
| `src/modules/page/page.controller.ts`, `page.module.ts`                                              | `GET /api/idle/info` route.                                                                                             |
| `src/modules/financial/financial.service.ts`                                                         | Uses shared coin list.                                                                                                  |
| `src/public/admin/shared.ts`, `src/public/admin/settings/{index.html,app.ts}`                        | Admin "Idle screen" controls.                                                                                           |
| `src/public/shared/kiosk-i18n.ts`                                                                    | `isI18nSkipped` opt-out.                                                                                                |
| `src/public/shared/idle/idle-copy.ts` (new)                                                          | English/Filipino idle text and pure renderers.                                                                          |
| `src/public/shared/idle/idle-slides.ts` (new)                                                        | Slide catalog, `buildPlaylist`, `playlistSignature`.                                                                    |
| `src/public/shared/idle/idle-status.ts` (new)                                                        | `IdleStatusPoller`, `fetchIdleInfo`.                                                                                    |
| `src/public/shared/idle/idle-carousel.ts` (new)                                                      | `IdleCarousel` slide timing.                                                                                            |
| `src/public/shared/idle/idle-lottie.ts` (new)                                                        | `IdleLottieStage`: one player, 30 Hz stepping, posters, failure handling.                                               |
| `src/public/shared/idle/idle-dotlottie.ts` (new)                                                     | Adapter from `DotLottie` to the stage's player interface.                                                               |
| `src/public/shared/idle/idle-view.ts` (new)                                                          | DOM writes, crossfade, step highlight, progress bar, clock.                                                             |
| `src/public/shared/idle/idle-controller.ts` (new)                                                    | `createIdleAttract`: wires everything for one overlay.                                                                  |
| `scripts/lib/dotlottie-zip.js`, `scripts/build-idle-lottie-slots.js` (new)                           | Fill slot `.lottie` files and posters.                                                                                  |
| `src/public/assets/lottie/idle/**` (new)                                                             | 10 slot animations and 10 SVG posters.                                                                                  |
| `src/public/index.html`, `src/public/idle-screen.css`, `src/public/globals.css`, `src/public/app.ts` | New markup, new stylesheet, removed overrides, wiring.                                                                  |

---

### Task 1: Shared idle contract and settings rules

**Files:**

- Create: `src/shared/idle-screen-contract.ts`
- Test: `src/shared/idle-screen-contract.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (exact exports):
  - `IDLE_SLIDE_IDS`, `type IdleSlideId`
  - `DISABLEABLE_IDLE_SLIDE_IDS`, `type DisableableIdleSlideId`, `isDisableableIdleSlideId(value: string): value is DisableableIdleSlideId`
  - `type IdleServiceName = 'print' | 'copy' | 'scan'`
  - `type IdleServiceState = 'ready' | 'limited' | 'unavailable' | 'unknown'`
  - `type IdleServiceReason = 'printer_offline' | 'printer_error' | 'paper_out' | 'paper_low' | 'scanner_unavailable'`
  - `interface IdleServiceStatus { state: IdleServiceState; reason: IdleServiceReason | null }`
  - `type IdlePaperLevel = 'ok' | 'low' | 'out' | 'unknown'`
  - `interface IdleScreenSettings { slideDurationSeconds: number; slides: Record<DisableableIdleSlideId, boolean> }`
  - `interface IdlePricingSummary { printBwFrom; printColorFrom; copyBw; copyColor; scan }` (all `number`)
  - `interface IdleInfo { settings; pricing: IdlePricingSummary | null; services: Record<IdleServiceName, IdleServiceStatus>; paper: { level: IdlePaperLevel }; change: { exactCoinsOnly: boolean }; coins: number[]; maxUploadMb: number; wordUploads: boolean }`
  - `IDLE_SLIDE_DURATION_MIN_SECONDS = 5`, `IDLE_SLIDE_DURATION_MAX_SECONDS = 20`, `IDLE_SLIDE_DURATION_DEFAULT_SECONDS = 8`
  - `createDefaultIdleScreenSettings(): IdleScreenSettings`
  - `normalizeIdleScreenSettings(raw: unknown): IdleScreenSettings`
  - `interface IdleScreenSettingsPatch { slideDurationSeconds?: number; slides?: Partial<Record<DisableableIdleSlideId, boolean>> }`
  - `validateIdleScreenSettingsPatch(raw: unknown): { ok: true; patch: IdleScreenSettingsPatch } | { ok: false; error: string }`
  - `applyIdleScreenSettingsPatch(current: IdleScreenSettings, patch: IdleScreenSettingsPatch): IdleScreenSettings`
  - `isIdleDegraded(info: IdleInfo | null): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/shared/idle-screen-contract.spec.ts`:

```ts
import {
  DISABLEABLE_IDLE_SLIDE_IDS,
  applyIdleScreenSettingsPatch,
  createDefaultIdleScreenSettings,
  isDisableableIdleSlideId,
  isIdleDegraded,
  normalizeIdleScreenSettings,
  validateIdleScreenSettingsPatch,
  type IdleInfo,
} from './idle-screen-contract';

const healthyInfo = (overrides: Partial<IdleInfo> = {}): IdleInfo => ({
  settings: createDefaultIdleScreenSettings(),
  pricing: null,
  services: {
    print: { state: 'ready', reason: null },
    copy: { state: 'ready', reason: null },
    scan: { state: 'ready', reason: null },
  },
  paper: { level: 'ok' },
  change: { exactCoinsOnly: false },
  coins: [1, 5, 10, 20],
  maxUploadMb: 25,
  wordUploads: true,
  ...overrides,
});

describe('idle screen contract', () => {
  it('defaults to 8 seconds with every slide on', () => {
    const settings = createDefaultIdleScreenSettings();
    expect(settings.slideDurationSeconds).toBe(8);
    for (const id of DISABLEABLE_IDLE_SLIDE_IDS) {
      expect(settings.slides[id]).toBe(true);
    }
  });

  it('returns a fresh defaults object each call', () => {
    const first = createDefaultIdleScreenSettings();
    first.slides.prices = false;
    expect(createDefaultIdleScreenSettings().slides.prices).toBe(true);
  });

  it('knows which slides can be turned off', () => {
    expect(isDisableableIdleSlideId('prices')).toBe(true);
    expect(isDisableableIdleSlideId('welcome')).toBe(false);
    expect(isDisableableIdleSlideId('status')).toBe(false);
    expect(isDisableableIdleSlideId('bogus')).toBe(false);
  });

  describe('normalizeIdleScreenSettings', () => {
    it('uses defaults when nothing is stored', () => {
      expect(normalizeIdleScreenSettings(undefined)).toEqual(
        createDefaultIdleScreenSettings(),
      );
    });

    it('keeps valid stored values and fills the rest', () => {
      const result = normalizeIdleScreenSettings({
        slideDurationSeconds: 12,
        slides: { prices: false },
      });
      expect(result.slideDurationSeconds).toBe(12);
      expect(result.slides.prices).toBe(false);
      expect(result.slides.howToPrint).toBe(true);
    });

    it('drops an out-of-range duration and invalid slide entries', () => {
      const result = normalizeIdleScreenSettings({
        slideDurationSeconds: 99,
        slides: { welcome: false, prices: 'no' },
      });
      expect(result).toEqual(createDefaultIdleScreenSettings());
    });
  });

  describe('validateIdleScreenSettingsPatch', () => {
    it.each([4, 21, 7.5, '8'])('rejects duration %p', (value) => {
      expect(
        validateIdleScreenSettingsPatch({ slideDurationSeconds: value }).ok,
      ).toBe(false);
    });

    it.each([5, 20])('accepts duration %p', (value) => {
      expect(
        validateIdleScreenSettingsPatch({ slideDurationSeconds: value }),
      ).toEqual({ ok: true, patch: { slideDurationSeconds: value } });
    });

    it('rejects a slide that cannot be turned off', () => {
      const result = validateIdleScreenSettingsPatch({
        slides: { status: false },
      });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toContain('idleScreen.slides.status');
    });

    it('rejects an unknown slide id', () => {
      expect(
        validateIdleScreenSettingsPatch({ slides: { bogus: true } }).ok,
      ).toBe(false);
    });

    it('rejects a non-boolean slide value', () => {
      expect(
        validateIdleScreenSettingsPatch({ slides: { prices: 1 } }).ok,
      ).toBe(false);
    });

    it('rejects an unknown top-level field', () => {
      expect(validateIdleScreenSettingsPatch({ theme: 'dark' }).ok).toBe(false);
    });

    it.each([null, [], 'x', 3])('rejects non-object input %p', (value) => {
      expect(validateIdleScreenSettingsPatch(value).ok).toBe(false);
    });

    it('accepts a partial slides patch', () => {
      expect(
        validateIdleScreenSettingsPatch({ slides: { prices: false } }),
      ).toEqual({ ok: true, patch: { slides: { prices: false } } });
    });
  });

  it('applies a patch without dropping other slides', () => {
    const next = applyIdleScreenSettingsPatch(
      createDefaultIdleScreenSettings(),
      { slides: { prices: false } },
    );
    expect(next.slides.prices).toBe(false);
    expect(next.slides.paying).toBe(true);
    expect(next.slideDurationSeconds).toBe(8);
  });

  describe('isIdleDegraded', () => {
    it('is false for null info and a healthy kiosk', () => {
      expect(isIdleDegraded(null)).toBe(false);
      expect(isIdleDegraded(healthyInfo())).toBe(false);
    });

    it('is false when a service is only unknown', () => {
      const info = healthyInfo();
      info.services.scan = { state: 'unknown', reason: null };
      expect(isIdleDegraded(info)).toBe(false);
    });

    it('is true for a limited or unavailable service', () => {
      const limited = healthyInfo();
      limited.services.print = { state: 'limited', reason: 'paper_low' };
      expect(isIdleDegraded(limited)).toBe(true);
      const down = healthyInfo();
      down.services.scan = {
        state: 'unavailable',
        reason: 'scanner_unavailable',
      };
      expect(isIdleDegraded(down)).toBe(true);
    });

    it('is true when only exact coins are accepted', () => {
      expect(
        isIdleDegraded(healthyInfo({ change: { exactCoinsOnly: true } })),
      ).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/shared/idle-screen-contract.spec.ts`
Expected: FAIL with `Cannot find module './idle-screen-contract'`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/idle-screen-contract.ts`:

```ts
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
export type DisableableIdleSlideId =
  (typeof DISABLEABLE_IDLE_SLIDE_IDS)[number];

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
  { ok: true; patch: IdleScreenSettingsPatch } | { ok: false; error: string };

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
    (service) => service.state === 'limited' || service.state === 'unavailable',
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/shared/idle-screen-contract.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/idle-screen-contract.ts src/shared/idle-screen-contract.spec.ts
git commit -m "feat(idle): add shared idle screen contract and settings rules"
```

---

### Task 2: Persist `idleScreen` settings

**Files:**

- Modify: `src/core/database/models/admin.model.ts` (`AdminSettings`, around line 184)
- Modify: `src/core/database/db.ts` (imports; default settings near line 253; normalization near line 1267)
- Modify: `src/modules/admin/admin.controller.ts` (`handleUpdateSettings`, body type near line 1771, validation near line 1945, apply near line 2067)
- Test: `src/shared/idle-screen-contract.spec.ts` already covers the rules; this task is checked by typecheck.

**Interfaces:**

- Consumes (Task 1): `IdleScreenSettings`, `createDefaultIdleScreenSettings`, `normalizeIdleScreenSettings`, `validateIdleScreenSettingsPatch`, `applyIdleScreenSettingsPatch`, `IdleScreenSettingsPatch`.
- Produces: `db.data.settings.idleScreen: IdleScreenSettings`, always present after load. `PUT /api/admin/settings` accepts `idleScreen` and returns 400 with the validator's `error` on bad input. `GET /api/admin/settings` returns `idleScreen` as part of `settings`.

- [ ] **Step 1: Add the model field**

In `src/core/database/models/admin.model.ts`, add to the imports at the top:

```ts
import type { IdleScreenSettings } from '@/shared/idle-screen-contract';
```

In `export interface AdminSettings`, directly under `idleScreenTimeoutSeconds: number;`, add:

```ts
idleScreen: IdleScreenSettings;
```

- [ ] **Step 2: Run typecheck to see the missing default**

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: FAIL with errors in `src/core/database/db.ts` saying property `idleScreen` is missing.

- [ ] **Step 3: Add the default and normalization in `db.ts`**

Add to the imports at the top of `src/core/database/db.ts`:

```ts
import {
  createDefaultIdleScreenSettings,
  normalizeIdleScreenSettings,
} from '@/shared/idle-screen-contract';
```

In the default settings object, directly after `idleScreenTimeoutSeconds: 30,`, add:

```ts
    idleScreen: createDefaultIdleScreenSettings(),
```

In the normalized settings object, directly after this existing block:

```ts
      idleScreenTimeoutSeconds: finiteOr(
        (data?.settings as { idleScreenTimeoutSeconds?: number })
          ?.idleScreenTimeoutSeconds,
        DEFAULT_DATA.settings.idleScreenTimeoutSeconds,
      ),
```

add:

```ts
      idleScreen: normalizeIdleScreenSettings(
        (data?.settings as { idleScreen?: unknown })?.idleScreen,
      ),
```

- [ ] **Step 4: Validate and apply in the admin controller**

In `src/modules/admin/admin.controller.ts`, add to the imports:

```ts
import {
  applyIdleScreenSettingsPatch,
  normalizeIdleScreenSettings,
  validateIdleScreenSettingsPatch,
  type IdleScreenSettingsPatch,
} from '@/shared/idle-screen-contract';
```

In `handleUpdateSettings`, in the `body` type, directly under `idleScreenTimeoutSeconds?: number;`, add:

```ts
      idleScreen?: unknown;
```

Directly after the existing `idleScreenTimeoutSeconds` validation block (the
one that returns `'idleScreenTimeoutSeconds must be a whole number between 10 and 600.'`), add:

```ts
let idleScreenPatch: IdleScreenSettingsPatch | null = null;
if (body.idleScreen !== undefined) {
  const idleScreenResult = validateIdleScreenSettingsPatch(body.idleScreen);
  if (!idleScreenResult.ok) {
    return res.status(400).json({ error: idleScreenResult.error });
  }
  idleScreenPatch = idleScreenResult.patch;
}
```

Directly after the existing apply block:

```ts
if (body.idleScreenTimeoutSeconds !== undefined) {
  nextSettings.idleScreenTimeoutSeconds = Math.floor(
    body.idleScreenTimeoutSeconds,
  );
}
```

add:

```ts
if (idleScreenPatch) {
  nextSettings.idleScreen = applyIdleScreenSettingsPatch(
    normalizeIdleScreenSettings(originalSettings.idleScreen),
    idleScreenPatch,
  );
}
```

- [ ] **Step 5: Run typecheck and related tests**

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: exit 0, no output.

Run: `pnpm exec jest src/shared/idle-screen-contract.spec.ts src/middleware/admin-auth.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/database/models/admin.model.ts src/core/database/db.ts src/modules/admin/admin.controller.ts
git commit -m "feat(idle): store idle screen slide settings"
```

---

### Task 3: Derive idle status and prices (pure server logic)

**Files:**

- Create: `src/modules/page/idle-info.ts`
- Test: `src/modules/page/idle-info.spec.ts`

**Interfaces:**

- Consumes (Task 1): `IdleInfo`, `IdlePaperLevel`, `IdlePricingSummary`, `IdleScreenSettings`, `IdleServiceName`, `IdleServiceReason`, `IdleServiceState`, `IdleServiceStatus`, `createDefaultIdleScreenSettings`. `PrinterErrorCode` from `@/shared/printer-error-catalog`.
- Produces:
  - `type PrinterProjectionStatus = 'ready' | 'printing' | 'offline' | 'error'`
  - `interface PaperForecastReading { enabled: boolean; currentSheets: number; capacitySheets: number }`
  - `interface IdleSourceReaders { printerStatus(): PrinterProjectionStatus; activePrinterErrorCode(): PrinterErrorCode | null; scannerReady(): boolean; hopperLastError(): string | null; paperForecast(): PaperForecastReading }` (each a `() => T` property)
  - `paperLowThreshold(capacitySheets: number): number`
  - `deriveIdleServices(readers: IdleSourceReaders): { services; paper; change }`
  - `interface IdlePricingSource { paperProfiles: Record<string, { paperCost: number; bwPrint: { low: number }; colorPrint: { low: number } }>; copyBwPerPage?: number; copyPerPage?: number; copyColorPerPage?: number; scanDocument?: number }`
  - `summarizeIdlePricing(source: IdlePricingSource): IdlePricingSummary`
  - `interface IdleInfoInputs { readers; settings(): IdleScreenSettings; pricing(): IdlePricingSource; coins: readonly number[]; maxUploadBytes: number; wordUploads(): boolean }`
  - `buildIdleInfo(inputs: IdleInfoInputs): IdleInfo`

- [ ] **Step 1: Write the failing test**

Create `src/modules/page/idle-info.spec.ts`:

```ts
import { createDefaultIdleScreenSettings } from '@/shared/idle-screen-contract';
import {
  buildIdleInfo,
  deriveIdleServices,
  paperLowThreshold,
  summarizeIdlePricing,
  type IdleInfoInputs,
  type IdlePricingSource,
  type IdleSourceReaders,
} from './idle-info';

const healthy = (): IdleSourceReaders => ({
  printerStatus: () => 'ready',
  activePrinterErrorCode: () => null,
  scannerReady: () => true,
  hopperLastError: () => null,
  paperForecast: () => ({
    enabled: true,
    currentSheets: 80,
    capacitySheets: 100,
  }),
});
const derive = (overrides: Partial<IdleSourceReaders> = {}) =>
  deriveIdleServices({ ...healthy(), ...overrides });
const boom = (): never => {
  throw new Error('source down');
};
const READY = { state: 'ready', reason: null };

describe('deriveIdleServices', () => {
  it('reports everything ready on a healthy kiosk', () => {
    expect(derive()).toEqual({
      services: { print: READY, copy: READY, scan: READY },
      paper: { level: 'ok' },
      change: { exactCoinsOnly: false },
    });
  });

  it('marks print and copy unavailable when the printer is offline', () => {
    const result = derive({ printerStatus: () => 'offline' });
    expect(result.services.print).toEqual({
      state: 'unavailable',
      reason: 'printer_offline',
    });
    expect(result.services.copy).toEqual({
      state: 'unavailable',
      reason: 'printer_offline',
    });
    expect(result.services.scan).toEqual(READY);
  });

  it('treats an active E_OFFLINE error as offline', () => {
    const result = derive({ activePrinterErrorCode: () => 'E_OFFLINE' });
    expect(result.services.print.reason).toBe('printer_offline');
  });

  it('marks a non-paper printer error as printer_error', () => {
    const result = derive({ activePrinterErrorCode: () => 'E_COVER_OPEN' });
    expect(result.services.print).toEqual({
      state: 'unavailable',
      reason: 'printer_error',
    });
  });

  it('marks printer status error without a code as printer_error', () => {
    const result = derive({ printerStatus: () => 'error' });
    expect(result.services.print.reason).toBe('printer_error');
  });

  it('ignores the low-ink warning', () => {
    const result = derive({ activePrinterErrorCode: () => 'W_INK_LOW' });
    expect(result.services.print).toEqual(READY);
  });

  it('says paper_out for E_NO_PAPER even though the printer status is error', () => {
    const result = derive({
      printerStatus: () => 'error',
      activePrinterErrorCode: () => 'E_NO_PAPER',
    });
    expect(result.services.print).toEqual({
      state: 'unavailable',
      reason: 'paper_out',
    });
    expect(result.services.copy).toEqual({
      state: 'unavailable',
      reason: 'paper_out',
    });
    expect(result.paper.level).toBe('out');
  });

  it('never marks unavailable from the estimate alone, even at 0 sheets', () => {
    const result = derive({
      paperForecast: () => ({
        enabled: true,
        currentSheets: 0,
        capacitySheets: 100,
      }),
    });
    expect(result.services.print).toEqual({
      state: 'limited',
      reason: 'paper_low',
    });
    expect(result.paper.level).toBe('low');
  });

  it.each<[number, number, string]>([
    [100, 10, 'low'],
    [100, 11, 'ok'],
    [500, 50, 'low'],
    [500, 51, 'ok'],
  ])('capacity %p with %p sheets is paper %p', (capacity, sheets, level) => {
    const result = derive({
      paperForecast: () => ({
        enabled: true,
        currentSheets: sheets,
        capacitySheets: capacity,
      }),
    });
    expect(result.paper.level).toBe(level);
  });

  it('reports paper unknown when forecasting is disabled', () => {
    const result = derive({
      paperForecast: () => ({
        enabled: false,
        currentSheets: 0,
        capacitySheets: 100,
      }),
    });
    expect(result.paper.level).toBe('unknown');
    expect(result.services.print).toEqual(READY);
  });

  it('marks scan and copy unavailable when the scanner is not ready', () => {
    const result = derive({ scannerReady: () => false });
    expect(result.services.scan).toEqual({
      state: 'unavailable',
      reason: 'scanner_unavailable',
    });
    expect(result.services.copy).toEqual({
      state: 'unavailable',
      reason: 'scanner_unavailable',
    });
    expect(result.services.print).toEqual(READY);
  });

  it.each<[string | null, boolean]>([
    ['ESP32 hopper dispense failed: EMPTY', true],
    ['hopper empty', true],
    ['JAM', false],
    [null, false],
  ])('hopper last error %p gives exactCoinsOnly %p', (message, expected) => {
    expect(
      derive({ hopperLastError: () => message }).change.exactCoinsOnly,
    ).toBe(expected);
  });

  it('marks print and copy unknown when printer sources throw', () => {
    const result = derive({ printerStatus: boom });
    expect(result.services.print).toEqual({ state: 'unknown', reason: null });
    expect(result.services.copy).toEqual({ state: 'unknown', reason: null });
    expect(result.paper.level).toBe('unknown');
  });

  it('marks scan and copy unknown when the scanner source throws', () => {
    const result = derive({ scannerReady: boom });
    expect(result.services.scan).toEqual({ state: 'unknown', reason: null });
    expect(result.services.copy).toEqual({ state: 'unknown', reason: null });
  });

  it('keeps going when the paper or hopper source throws', () => {
    const result = derive({ paperForecast: boom, hopperLastError: boom });
    expect(result.paper.level).toBe('unknown');
    expect(result.services.print).toEqual(READY);
    expect(result.change.exactCoinsOnly).toBe(false);
  });

  it('keeps the first reason for equal states and the worst state overall', () => {
    const result = derive({
      activePrinterErrorCode: () => 'E_NO_PAPER',
      scannerReady: () => false,
    });
    expect(result.services.copy).toEqual({
      state: 'unavailable',
      reason: 'paper_out',
    });
    expect(result.services.scan.reason).toBe('scanner_unavailable');
  });

  it('does not downgrade offline to limited when paper is low', () => {
    const result = derive({
      printerStatus: () => 'offline',
      paperForecast: () => ({
        enabled: true,
        currentSheets: 1,
        capacitySheets: 100,
      }),
    });
    expect(result.services.print).toEqual({
      state: 'unavailable',
      reason: 'printer_offline',
    });
  });
});

describe('paperLowThreshold', () => {
  it('is at least 10 sheets and otherwise 10% rounded up', () => {
    expect(paperLowThreshold(50)).toBe(10);
    expect(paperLowThreshold(250)).toBe(25);
    expect(paperLowThreshold(255)).toBe(26);
  });
});

const PRICING: IdlePricingSource = {
  paperProfiles: {
    a4: { paperCost: 1, bwPrint: { low: 2 }, colorPrint: { low: 17 } },
    shortBond: { paperCost: 1, bwPrint: { low: 2 }, colorPrint: { low: 17 } },
    longBond: { paperCost: 1, bwPrint: { low: 3 }, colorPrint: { low: 19 } },
  },
  copyBwPerPage: 3,
  copyColorPerPage: 5,
  scanDocument: 5,
};

describe('summarizeIdlePricing', () => {
  it('uses the cheapest paper plus low-coverage rate as the "from" price', () => {
    expect(summarizeIdlePricing(PRICING)).toEqual({
      printBwFrom: 3,
      printColorFrom: 18,
      copyBw: 3,
      copyColor: 5,
      scan: 5,
    });
  });

  it('falls back to copyPerPage and pricing-config defaults', () => {
    const summary = summarizeIdlePricing({
      paperProfiles: PRICING.paperProfiles,
      copyPerPage: 4,
    });
    expect(summary.copyBw).toBe(4);
    expect(summary.copyColor).toBe(5);
    expect(summary.scan).toBe(5);
  });

  it('throws when there are no paper profiles', () => {
    expect(() => summarizeIdlePricing({ paperProfiles: {} })).toThrow();
  });
});

describe('buildIdleInfo', () => {
  const inputs = (overrides: Partial<IdleInfoInputs> = {}): IdleInfoInputs => ({
    readers: healthy(),
    settings: () => createDefaultIdleScreenSettings(),
    pricing: () => PRICING,
    coins: [1, 5, 10, 20],
    maxUploadBytes: 25 * 1024 * 1024,
    wordUploads: () => true,
    ...overrides,
  });

  it('returns exactly the contract fields', () => {
    const info = buildIdleInfo(inputs());
    expect(Object.keys(info).sort()).toEqual([
      'change',
      'coins',
      'maxUploadMb',
      'paper',
      'pricing',
      'services',
      'settings',
      'wordUploads',
    ]);
    expect(info.maxUploadMb).toBe(25);
    expect(info.coins).toEqual([1, 5, 10, 20]);
    expect(info.wordUploads).toBe(true);
  });

  it('returns null pricing when pricing throws', () => {
    expect(buildIdleInfo(inputs({ pricing: boom })).pricing).toBeNull();
  });

  it('returns default settings when settings throw', () => {
    expect(buildIdleInfo(inputs({ settings: boom })).settings).toEqual(
      createDefaultIdleScreenSettings(),
    );
  });

  it('returns wordUploads false when that source throws', () => {
    expect(buildIdleInfo(inputs({ wordUploads: boom })).wordUploads).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/modules/page/idle-info.spec.ts`
Expected: FAIL with `Cannot find module './idle-info'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/page/idle-info.ts`:

```ts
import type { PrinterErrorCode } from '@/shared/printer-error-catalog';
import {
  createDefaultIdleScreenSettings,
  type IdleInfo,
  type IdlePaperLevel,
  type IdlePricingSummary,
  type IdleScreenSettings,
  type IdleServiceName,
  type IdleServiceReason,
  type IdleServiceState,
  type IdleServiceStatus,
} from '@/shared/idle-screen-contract';

export type PrinterProjectionStatus =
  'ready' | 'printing' | 'offline' | 'error';

export interface PaperForecastReading {
  enabled: boolean;
  currentSheets: number;
  capacitySheets: number;
}

/** Each reader may throw; deriveIdleServices isolates every one. */
export interface IdleSourceReaders {
  printerStatus: () => PrinterProjectionStatus;
  activePrinterErrorCode: () => PrinterErrorCode | null;
  scannerReady: () => boolean;
  hopperLastError: () => string | null;
  paperForecast: () => PaperForecastReading;
}

export interface IdleServicesResult {
  services: Record<IdleServiceName, IdleServiceStatus>;
  paper: { level: IdlePaperLevel };
  change: { exactCoinsOnly: boolean };
}

const STATE_RANK: Record<IdleServiceState, number> = {
  ready: 0,
  unknown: 1,
  limited: 2,
  unavailable: 3,
};

const PRINTER_SERVICES: IdleServiceName[] = ['print', 'copy'];
const SCANNER_SERVICES: IdleServiceName[] = ['scan', 'copy'];

type Reading<T> = { ok: true; value: T } | { ok: false };

function read<T>(fn: () => T): Reading<T> {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
}

/** Sheets at or below this count are "paper low". */
export function paperLowThreshold(capacitySheets: number): number {
  return Math.max(10, Math.ceil(capacitySheets * 0.1));
}

/**
 * Maps hardware sources to idle service states. Rules are applied in priority
 * order; a later rule only replaces a service's status when its state is worse,
 * so for equal states the first reason wins.
 *
 * Only the printer's own E_NO_PAPER makes a service unavailable for paper. The
 * sheet count is a staff-maintained estimate and can only mark paper low.
 */
export function deriveIdleServices(
  readers: IdleSourceReaders,
): IdleServicesResult {
  const services: Record<IdleServiceName, IdleServiceStatus> = {
    print: { state: 'ready', reason: null },
    copy: { state: 'ready', reason: null },
    scan: { state: 'ready', reason: null },
  };
  const raise = (
    names: IdleServiceName[],
    state: IdleServiceState,
    reason: IdleServiceReason | null,
  ): void => {
    for (const name of names) {
      if (STATE_RANK[state] > STATE_RANK[services[name].state]) {
        services[name] = { state, reason };
      }
    }
  };

  let paper: IdlePaperLevel = 'unknown';
  const printer = read(() => ({
    status: readers.printerStatus(),
    code: readers.activePrinterErrorCode(),
  }));

  if (!printer.ok) {
    raise(PRINTER_SERVICES, 'unknown', null);
  } else {
    const { status, code } = printer.value;
    if (code === 'E_NO_PAPER') {
      raise(PRINTER_SERVICES, 'unavailable', 'paper_out');
      paper = 'out';
    }
    if (status === 'offline' || code === 'E_OFFLINE') {
      raise(PRINTER_SERVICES, 'unavailable', 'printer_offline');
    }
    const otherError =
      code !== null &&
      code !== 'E_NO_PAPER' &&
      code !== 'E_OFFLINE' &&
      code !== 'W_INK_LOW';
    if (otherError || (status === 'error' && code !== 'E_NO_PAPER')) {
      raise(PRINTER_SERVICES, 'unavailable', 'printer_error');
    }
    if (paper !== 'out') {
      const forecast = read(readers.paperForecast);
      if (forecast.ok && forecast.value.enabled) {
        const { currentSheets, capacitySheets } = forecast.value;
        if (currentSheets <= paperLowThreshold(capacitySheets)) {
          paper = 'low';
          raise(PRINTER_SERVICES, 'limited', 'paper_low');
        } else {
          paper = 'ok';
        }
      }
    }
  }

  const scanner = read(readers.scannerReady);
  if (!scanner.ok) {
    raise(SCANNER_SERVICES, 'unknown', null);
  } else if (!scanner.value) {
    raise(SCANNER_SERVICES, 'unavailable', 'scanner_unavailable');
  }

  const hopper = read(readers.hopperLastError);
  const exactCoinsOnly = hopper.ok && /empty/i.test(hopper.value ?? '');

  return { services, paper: { level: paper }, change: { exactCoinsOnly } };
}

export interface IdlePricingSource {
  paperProfiles: Record<
    string,
    { paperCost: number; bwPrint: { low: number }; colorPrint: { low: number } }
  >;
  copyBwPerPage?: number;
  copyPerPage?: number;
  copyColorPerPage?: number;
  scanDocument?: number;
}

/**
 * Print prices vary by paper size and ink coverage, so the idle screen shows
 * "from" prices: the cheapest paper cost plus the low-coverage rate.
 * Copy and scan defaults match GET /api/pricing-config.
 */
export function summarizeIdlePricing(
  source: IdlePricingSource,
): IdlePricingSummary {
  const profiles = Object.values(source.paperProfiles);
  if (profiles.length === 0) {
    throw new Error('No paper profiles configured.');
  }
  const cheapest = (pick: (p: (typeof profiles)[number]) => number): number =>
    Math.min(...profiles.map((profile) => profile.paperCost + pick(profile)));
  return {
    printBwFrom: cheapest((p) => p.bwPrint.low),
    printColorFrom: cheapest((p) => p.colorPrint.low),
    copyBw: source.copyBwPerPage ?? source.copyPerPage ?? 3,
    copyColor: source.copyColorPerPage ?? 5,
    scan: source.scanDocument ?? 5,
  };
}

export interface IdleInfoInputs {
  readers: IdleSourceReaders;
  settings: () => IdleScreenSettings;
  pricing: () => IdlePricingSource;
  coins: readonly number[];
  maxUploadBytes: number;
  wordUploads: () => boolean;
}

export function buildIdleInfo(inputs: IdleInfoInputs): IdleInfo {
  const derived = deriveIdleServices(inputs.readers);
  const pricing = read(() => summarizeIdlePricing(inputs.pricing()));
  const settings = read(inputs.settings);
  const wordUploads = read(inputs.wordUploads);
  return {
    settings: settings.ok ? settings.value : createDefaultIdleScreenSettings(),
    pricing: pricing.ok ? pricing.value : null,
    services: derived.services,
    paper: derived.paper,
    change: derived.change,
    coins: [...inputs.coins],
    maxUploadMb: Math.round(inputs.maxUploadBytes / (1024 * 1024)),
    wordUploads: wordUploads.ok ? Boolean(wordUploads.value) : false,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/modules/page/idle-info.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/page/idle-info.ts src/modules/page/idle-info.spec.ts
git commit -m "feat(idle): derive idle service status and from-prices"
```

---

### Task 4: `GET /api/idle/info` route and real sources

**Files:**

- Create: `src/shared/accepted-coins.ts`
- Modify: `src/modules/financial/financial.service.ts:115`
- Create: `src/modules/page/idle-info.sources.ts`
- Modify: `src/modules/page/page.controller.ts` (deps interface, `initializeRoutes`, new handler)
- Modify: `src/modules/page/page.module.ts`
- Test: `src/modules/page/idle-info.route.spec.ts`

**Interfaces:**

- Consumes (Task 3): `buildIdleInfo`. (Task 1): `normalizeIdleScreenSettings`, `IdleInfo`.
- Produces:
  - `ACCEPTED_COIN_VALUES: readonly [1, 5, 10, 20]` from `@/shared/accepted-coins`.
  - `createIdleInfoProvider(): () => IdleInfo` from `src/modules/page/idle-info.sources.ts`.
  - `PageControllerDeps.idleInfoProvider: () => IdleInfo` (required).
  - Route `GET /api/idle/info`: 200 with `IdleInfo` JSON and `Cache-Control: no-store`; 503 `{ "error": "Idle info unavailable." }` only if the provider itself throws.

- [ ] **Step 1: Write the failing route test**

Create `src/modules/page/idle-info.route.spec.ts`:

```ts
import express from 'express';
import request from 'supertest';
import {
  createDefaultIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';

jest.mock('@/services/db', () => ({
  db: {
    data: {
      settings: { idleTimeoutSeconds: 120, idleScreenTimeoutSeconds: 30 },
    },
  },
}));

import { PageController } from './page.controller';

const INFO: IdleInfo = {
  settings: createDefaultIdleScreenSettings(),
  pricing: {
    printBwFrom: 3,
    printColorFrom: 18,
    copyBw: 3,
    copyColor: 5,
    scan: 5,
  },
  services: {
    print: { state: 'ready', reason: null },
    copy: { state: 'limited', reason: 'paper_low' },
    scan: { state: 'ready', reason: null },
  },
  paper: { level: 'low' },
  change: { exactCoinsOnly: false },
  coins: [1, 5, 10, 20],
  maxUploadMb: 25,
  wordUploads: true,
};

function makeApp(idleInfoProvider: () => IdleInfo): express.Express {
  const controller = new PageController({
    sessionStore: {} as never,
    publicPageRoutes: [],
    resolvePublicBaseUrl: () => new URL('http://localhost'),
    paymentAcceptorGate: {} as never,
    idleInfoProvider,
  });
  const app = express();
  app.use(controller.router);
  return app;
}

describe('GET /api/idle/info', () => {
  it('returns the provider snapshot without caching', async () => {
    const res = await request(makeApp(() => INFO)).get('/api/idle/info');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(INFO);
  });

  it('returns 503 without leaking error text when the provider throws', async () => {
    const res = await request(
      makeApp(() => {
        throw new Error('secret device path C:\\naps2');
      }),
    ).get('/api/idle/info');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Idle info unavailable.' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/modules/page/idle-info.route.spec.ts`
Expected: FAIL. TypeScript reports `idleInfoProvider` does not exist in `PageControllerDeps`, or the route returns 404.

- [ ] **Step 3: Share the coin list**

Create `src/shared/accepted-coins.ts`:

```ts
/** Coin values the acceptor takes, in pesos. */
export const ACCEPTED_COIN_VALUES = [1, 5, 10, 20] as const;
```

In `src/modules/financial/financial.service.ts`, add to the imports:

```ts
import { ACCEPTED_COIN_VALUES as ACCEPTED_COIN_VALUE_LIST } from '@/shared/accepted-coins';
```

and replace line 115:

```ts
const ACCEPTED_COIN_VALUES = new Set([1, 5, 10, 20]);
```

with:

```ts
const ACCEPTED_COIN_VALUES = new Set<number>(ACCEPTED_COIN_VALUE_LIST);
```

- [ ] **Step 4: Add the real source wiring**

Create `src/modules/page/idle-info.sources.ts`:

```ts
import { db, defaultPricingEngine } from '@/services/db';
import { printerStateProjection } from '@/services/printer-state-projection';
import { printerErrorStateManager } from '@/services/printer-error-state';
import { getScannerStatus } from '@/services/scanner';
import { MAX_FILE_SIZE_BYTES } from '@/utils/file-types';
import { ACCEPTED_COIN_VALUES } from '@/shared/accepted-coins';
import {
  normalizeIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';
import { buildIdleInfo } from './idle-info';

/**
 * Reads the live kiosk state for GET /api/idle/info. Every reader is cheap:
 * cached projections and settings only, no device probes.
 */
export function createIdleInfoProvider(): () => IdleInfo {
  return () =>
    buildIdleInfo({
      readers: {
        printerStatus: () => printerStateProjection.getSnapshot().status,
        activePrinterErrorCode: () => {
          const active = printerErrorStateManager.getActiveError();
          return active && active.status !== 'cleared' ? active.code : null;
        },
        scannerReady: () => {
          const scanner = getScannerStatus();
          return scanner.connected || scanner.usingStub;
        },
        hopperLastError: () => db.data!.hopperStats?.lastError ?? null,
        paperForecast: () => {
          const forecast = db.data!.settings.consumablesForecasting;
          return {
            enabled: Boolean(forecast.enabled),
            currentSheets: forecast.paperCurrentSheets,
            capacitySheets: forecast.paperTrayCapacitySheets,
          };
        },
      },
      settings: () => normalizeIdleScreenSettings(db.data!.settings.idleScreen),
      pricing: () => {
        const settings = db.data!.settings;
        return {
          paperProfiles:
            settings.pricingEngine?.paperProfiles ??
            defaultPricingEngine.paperProfiles,
          copyBwPerPage: settings.pricing?.copyBwPerPage,
          copyPerPage: settings.pricing?.copyPerPage,
          copyColorPerPage: settings.pricing?.copyColorPerPage,
          scanDocument: settings.pricing?.scanDocument,
        };
      },
      coins: ACCEPTED_COIN_VALUES,
      maxUploadBytes: MAX_FILE_SIZE_BYTES,
      wordUploads: () =>
        Boolean(db.data!.settings.pipelineSettings?.documentConversionEnabled),
    });
}
```

- [ ] **Step 5: Add the route to the controller**

In `src/modules/page/page.controller.ts`, add to the imports:

```ts
import type { IdleInfo } from '@/shared/idle-screen-contract';
```

In `export interface PageControllerDeps`, add after `kioskAccessService?: KioskAccessService;`:

```ts
/** Builds the GET /api/idle/info snapshot. */
idleInfoProvider: () => IdleInfo;
```

In `initializeRoutes()`, directly after the
`['/api/settings/idle-timeout', '/api/page/settings']` route registration, add:

```ts
// Public, read-only snapshot for the homepage idle (attract) screen.
this.router.get('/api/idle/info', this.handleIdleInfo.bind(this));
```

Add this method directly after `handleIdleTimeout`:

```ts
  private handleIdleInfo(_req: Request, res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(this.deps.idleInfoProvider());
    } catch (error) {
      console.error('[IdleInfo] Failed to build idle info:', error);
      res.status(503).json({ error: 'Idle info unavailable.' });
    }
  }
```

- [ ] **Step 6: Pass the provider from the module**

In `src/modules/page/page.module.ts`, add the import:

```ts
import { createIdleInfoProvider } from './idle-info.sources';
```

and add to the `new PageController({ ... })` options, after `paymentAcceptorGate: deps.paymentAcceptorGate,`:

```ts
    idleInfoProvider: createIdleInfoProvider(),
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `pnpm exec jest src/modules/page`
Expected: PASS (route spec and Task 3 spec).

Run: `pnpm exec jest --findRelatedTests src/modules/financial/financial.service.ts`
Expected: PASS (or "No tests found", which is also fine).

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/shared/accepted-coins.ts src/modules/financial/financial.service.ts src/modules/page/idle-info.sources.ts src/modules/page/page.controller.ts src/modules/page/page.module.ts src/modules/page/idle-info.route.spec.ts
git commit -m "feat(idle): serve live idle info at GET /api/idle/info"
```

---

### Task 5: Admin "Idle screen" controls

**Files:**

- Modify: `src/public/admin/shared.ts` (`AdminSettings` interface, line 245)
- Modify: `src/public/admin/settings/index.html` (after the `settingIdleScreenTimeout` field, around line 754)
- Modify: `src/public/admin/settings/app.ts` (element lookups near line 131, `applySettings` near line 355, save payload near line 940)

**Interfaces:**

- Consumes (Task 1): `IdleScreenSettings`, `normalizeIdleScreenSettings`, `isDisableableIdleSlideId`, `DisableableIdleSlideId`, `IDLE_SLIDE_DURATION_MIN_SECONDS`, `IDLE_SLIDE_DURATION_MAX_SECONDS`. (Task 2): the server accepts `idleScreen`.
- Produces: the settings form sends `idleScreen: { slideDurationSeconds, slides }` on save.

- [ ] **Step 1: Extend the admin client settings type**

In `src/public/admin/shared.ts`, add at the top with the other imports:

```ts
import type { IdleScreenSettings } from '@/shared/idle-screen-contract';
```

Inside `export interface AdminSettings {`, add as the first member:

```ts
  idleScreen?: IdleScreenSettings;
```

- [ ] **Step 2: Add the form controls**

In `src/public/admin/settings/index.html`, find the field that ends with this
hint and its closing `</div>`:

```html
                    <p class="field__hint">
                      How long the homepage stays idle before showing the
                      attractor screen. Minimum 10 s · Maximum 600 s (10 min)
                    </p>
                  </div>
```

Insert directly after that `</div>`:

```html
<div class="field">
  <label class="field__lbl" for="settingIdleSlideDuration"
    >Idle slide duration</label
  >
  <div class="field__wrap field__wrap--post">
    <input
      id="settingIdleSlideDuration"
      type="number"
      min="5"
      max="20"
      step="1"
      class="field__input"
      required
    />
    <span class="field__affix">sec</span>
  </div>
  <p class="field__hint">
    How long each idle screen slide stays up. Minimum 5 s · Maximum 20 s
  </p>
</div>
<fieldset class="field" id="settingIdleSlides">
  <legend class="field__lbl">Idle screen slides</legend>
  <p class="field__hint">
    Welcome and Kiosk status always show. Slides for a service that is down are
    skipped automatically.
  </p>
  <div class="checkbox-row">
    <label class="checkbox-label" for="settingIdleSlide-howToPrint">
      <input
        type="checkbox"
        id="settingIdleSlide-howToPrint"
        class="checkbox-input"
        data-idle-slide="howToPrint"
      />
      <span>How to print</span>
    </label>
  </div>
  <div class="checkbox-row">
    <label class="checkbox-label" for="settingIdleSlide-howToCopy">
      <input
        type="checkbox"
        id="settingIdleSlide-howToCopy"
        class="checkbox-input"
        data-idle-slide="howToCopy"
      />
      <span>How to copy</span>
    </label>
  </div>
  <div class="checkbox-row">
    <label class="checkbox-label" for="settingIdleSlide-idCardCopy">
      <input
        type="checkbox"
        id="settingIdleSlide-idCardCopy"
        class="checkbox-input"
        data-idle-slide="idCardCopy"
      />
      <span>ID card copy</span>
    </label>
  </div>
  <div class="checkbox-row">
    <label class="checkbox-label" for="settingIdleSlide-scanToPhone">
      <input
        type="checkbox"
        id="settingIdleSlide-scanToPhone"
        class="checkbox-input"
        data-idle-slide="scanToPhone"
      />
      <span>Scan to phone</span>
    </label>
  </div>
  <div class="checkbox-row">
    <label class="checkbox-label" for="settingIdleSlide-prices">
      <input
        type="checkbox"
        id="settingIdleSlide-prices"
        class="checkbox-input"
        data-idle-slide="prices"
      />
      <span>Prices</span>
    </label>
  </div>
  <div class="checkbox-row">
    <label class="checkbox-label" for="settingIdleSlide-paying">
      <input
        type="checkbox"
        id="settingIdleSlide-paying"
        class="checkbox-input"
        data-idle-slide="paying"
      />
      <span>Paying with coins</span>
    </label>
  </div>
  <div class="checkbox-row">
    <label class="checkbox-label" for="settingIdleSlide-supportedFiles">
      <input
        type="checkbox"
        id="settingIdleSlide-supportedFiles"
        class="checkbox-input"
        data-idle-slide="supportedFiles"
      />
      <span>Supported files</span>
    </label>
  </div>
  <div class="checkbox-row">
    <label class="checkbox-label" for="settingIdleSlide-privacyReceipt">
      <input
        type="checkbox"
        id="settingIdleSlide-privacyReceipt"
        class="checkbox-input"
        data-idle-slide="privacyReceipt"
      />
      <span>Privacy and e-receipt</span>
    </label>
  </div>
</fieldset>
```

- [ ] **Step 3: Wire load and save**

In `src/public/admin/settings/app.ts`, add to the imports:

```ts
import {
  IDLE_SLIDE_DURATION_MAX_SECONDS,
  IDLE_SLIDE_DURATION_MIN_SECONDS,
  isDisableableIdleSlideId,
  normalizeIdleScreenSettings,
  type DisableableIdleSlideId,
} from '@/shared/idle-screen-contract';
```

Directly after the `settingIdleScreenTimeout` lookup:

```ts
const settingIdleScreenTimeout = document.getElementById(
  'settingIdleScreenTimeout',
) as HTMLInputElement | null;
```

add:

```ts
const settingIdleSlideDuration = document.getElementById(
  'settingIdleSlideDuration',
) as HTMLInputElement | null;
const settingIdleSlideToggles = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[data-idle-slide]'),
);
```

In `applySettings`, directly after:

```ts
if (settingIdleScreenTimeout) {
  settingIdleScreenTimeout.value = String(settings.idleScreenTimeoutSeconds);
}
```

add:

```ts
const idleScreen = normalizeIdleScreenSettings(settings.idleScreen);
if (settingIdleSlideDuration) {
  settingIdleSlideDuration.value = String(idleScreen.slideDurationSeconds);
}
for (const toggle of settingIdleSlideToggles) {
  const slideId = toggle.dataset.idleSlide;
  if (slideId && isDisableableIdleSlideId(slideId)) {
    toggle.checked = idleScreen.slides[slideId];
  }
}
```

In the save handler, directly after the block that ends with
`payload.idleScreenTimeoutSeconds = idleScreenTimeoutValue;` and its closing
`}`, add:

```ts
if (settingIdleSlideDuration) {
  const slideDuration = Number(settingIdleSlideDuration.value);
  if (
    !Number.isInteger(slideDuration) ||
    slideDuration < IDLE_SLIDE_DURATION_MIN_SECONDS ||
    slideDuration > IDLE_SLIDE_DURATION_MAX_SECONDS
  ) {
    setMessage(
      `Idle slide duration must be a whole number between ${IDLE_SLIDE_DURATION_MIN_SECONDS} and ${IDLE_SLIDE_DURATION_MAX_SECONDS} seconds.`,
    );
    return;
  }
  const slides: Partial<Record<DisableableIdleSlideId, boolean>> = {};
  for (const toggle of settingIdleSlideToggles) {
    const slideId = toggle.dataset.idleSlide;
    if (slideId && isDisableableIdleSlideId(slideId)) {
      slides[slideId] = toggle.checked;
    }
  }
  payload.idleScreen = { slideDurationSeconds: slideDuration, slides };
}
```

- [ ] **Step 4: Typecheck and build**

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: exit 0.

Run: `pnpm build`
Expected: ends with `Build completed successfully.`

- [ ] **Step 5: Manual check**

Run `pnpm dev`, open `/admin/settings`, sign in. Expected: the "Idle slide
duration" field shows 8 and all eight slide boxes are checked. Untick
"Prices", set 12, save, reload. Expected: Prices stays unticked and duration
reads 12. Enter 4 and save. Expected: the message "Idle slide duration must be
a whole number between 5 and 20 seconds." and nothing is saved. Set the values
back to 8 and all ticked, then save.

- [ ] **Step 6: Commit**

```bash
git add src/public/admin/shared.ts src/public/admin/settings/index.html src/public/admin/settings/app.ts
git commit -m "feat(idle): add idle screen slide controls to admin settings"
```

`pnpm build` regenerates bundles such as `src/public/admin/settings/app.js`.
Check `git status`. Commit generated `.js` bundles only if they were tracked
before this task (`git ls-files src/public/admin/settings/app.js` prints the
path). Never stage the unrelated files listed in Global Constraints.

---

### Task 6: Let the idle overlay opt out of kiosk translation

**Files:**

- Modify: `src/public/shared/kiosk-i18n.ts` (`applyTextNodeTranslation` near line 53, `applyAttributeTranslation` near line 79)
- Test: `src/public/shared/kiosk-i18n.spec.ts` (new)

**Interfaces:**

- Produces: `export const I18N_SKIP_ATTRIBUTE = 'data-i18n-skip'` and `export function isI18nSkipped(node: Node | null): boolean`. Text and attributes inside an element with `data-i18n-skip` are never rewritten.

- [ ] **Step 1: Write the failing test**

Create `src/public/shared/kiosk-i18n.spec.ts`:

```ts
/**
 * @jest-environment jsdom
 */
import { isI18nSkipped } from './kiosk-i18n';

describe('isI18nSkipped', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div data-i18n-skip><p id="inside">Tap anywhere to start</p></div>' +
      '<p id="outside">Tap anywhere to start</p>';
  });

  it('skips text inside a data-i18n-skip subtree', () => {
    const inside = document.getElementById('inside')!;
    expect(isI18nSkipped(inside.firstChild)).toBe(true);
    expect(isI18nSkipped(inside)).toBe(true);
  });

  it('does not skip text outside it', () => {
    const outside = document.getElementById('outside')!;
    expect(isI18nSkipped(outside.firstChild)).toBe(false);
    expect(isI18nSkipped(outside)).toBe(false);
  });

  it('handles null', () => {
    expect(isI18nSkipped(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/public/shared/kiosk-i18n.spec.ts`
Expected: FAIL with `isI18nSkipped is not a function` (or a TypeScript "has no exported member" error).

- [ ] **Step 3: Implement the opt-out**

In `src/public/shared/kiosk-i18n.ts`, directly after the line
`export const KIOSK_LANGUAGE_CHANGED_EVENT = 'printbit:language-changed';`, add:

```ts
/**
 * Elements carrying this attribute manage their own language (the idle
 * screen alternates English and Filipino), so the kiosk-wide translator
 * leaves their text and attributes alone.
 */
export const I18N_SKIP_ATTRIBUTE = 'data-i18n-skip';

export function isI18nSkipped(node: Node | null): boolean {
  if (!node) return false;
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return Boolean(element?.closest(`[${I18N_SKIP_ATTRIBUTE}]`));
}
```

At the very start of the body of `function applyTextNodeTranslation(node: Text): void {`, add:

```ts
if (isI18nSkipped(node)) return;
```

At the very start of the body of `function applyAttributeTranslation(el: Element): void {`, add:

```ts
if (isI18nSkipped(el)) return;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec jest src/public/shared/kiosk-i18n.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/public/shared/kiosk-i18n.ts src/public/shared/kiosk-i18n.spec.ts
git commit -m "feat(i18n): let a subtree opt out of kiosk translation"
```

---

### Task 7: Idle text and playlist rules (client, pure)

**Files:**

- Create: `src/public/shared/idle/idle-copy.ts`
- Create: `src/public/shared/idle/idle-slides.ts`
- Test: `src/public/shared/idle/idle-copy.spec.ts`
- Test: `src/public/shared/idle/idle-slides.spec.ts`

**Interfaces:**

- Consumes (Task 1): `IdleInfo`, `IdleSlideId`, `IdleServiceName`, `IdleServiceState`, `IdleServiceStatus`, `IdlePricingSummary`, `IdlePaperLevel`, `IdleServiceReason`, `DisableableIdleSlideId`, `IDLE_SLIDE_IDS`, `createDefaultIdleScreenSettings`, `isIdleDegraded`, `isDisableableIdleSlideId`. `formatPeso` from `src/public/shared/pricing-guide.ts`.
- Produces from `idle-copy.ts`:
  - `type IdleLang = 'en' | 'fil'`
  - `IDLE_FALLBACK_COINS: readonly number[]`, `IDLE_FALLBACK_MAX_UPLOAD_MB = 25`
  - `interface IdleSlideText { eyebrow: string; title: string; body: string; lines: string[]; stepped: boolean }`
  - `renderSlideText(id: IdleSlideId, lang: IdleLang, info: IdleInfo | null): IdleSlideText`
  - `statusLines(info: IdleInfo | null, lang: IdleLang): string[]`, `statusSummary(info, lang): string`
  - `serviceLabel(name: IdleServiceName, lang): string`, `chipStateLabel(state: IdleServiceState, lang): string`
  - `IDLE_UI_TEXT: Record<IdleLang, { cta: string; overlayLabel: string; chipsLabel: string }>`
  - `IDLE_SERVICE_ORDER: readonly IdleServiceName[]`
- Produces from `idle-slides.ts`:
  - `interface IdleSlideDef { id: IdleSlideId; src: string; poster: string; service: IdleServiceName | null; disableable: boolean }`
  - `IDLE_SLIDES: readonly IdleSlideDef[]`, `getSlideDef(id: IdleSlideId): IdleSlideDef`
  - `interface IdlePlaylist { slides: IdleSlideId[]; lang: IdleLang }`
  - `buildPlaylist(info: IdleInfo | null, cycleIndex: number): IdlePlaylist`
  - `playlistSignature(info: IdleInfo | null): string`

- [ ] **Step 1: Write the failing tests**

Create `src/public/shared/idle/idle-slides.spec.ts`:

```ts
import {
  createDefaultIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';
import {
  IDLE_SLIDES,
  buildPlaylist,
  getSlideDef,
  playlistSignature,
} from './idle-slides';

const info = (overrides: Partial<IdleInfo> = {}): IdleInfo => ({
  settings: createDefaultIdleScreenSettings(),
  pricing: {
    printBwFrom: 3,
    printColorFrom: 18,
    copyBw: 3,
    copyColor: 5,
    scan: 5,
  },
  services: {
    print: { state: 'ready', reason: null },
    copy: { state: 'ready', reason: null },
    scan: { state: 'ready', reason: null },
  },
  paper: { level: 'ok' },
  change: { exactCoinsOnly: false },
  coins: [1, 5, 10, 20],
  maxUploadMb: 25,
  wordUploads: true,
  ...overrides,
});

const CATALOG = [
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
];

describe('IDLE_SLIDES', () => {
  it('lists every slide once, in catalog order, with slot paths', () => {
    expect(IDLE_SLIDES.map((slide) => slide.id)).toEqual(CATALOG);
    for (const slide of IDLE_SLIDES) {
      expect(slide.src).toMatch(/^\/assets\/lottie\/idle\/[a-z-]+\.lottie$/);
      expect(slide.poster).toMatch(
        /^\/assets\/lottie\/idle\/posters\/[a-z-]+\.svg$/,
      );
    }
    expect(new Set(IDLE_SLIDES.map((slide) => slide.src)).size).toBe(10);
  });

  it('finds a slide by id', () => {
    expect(getSlideDef('howToCopy').service).toBe('copy');
  });
});

describe('buildPlaylist', () => {
  it('shows the whole catalog on a healthy kiosk', () => {
    expect(buildPlaylist(info(), 0).slides).toEqual(CATALOG);
  });

  it('removes slides the admin turned off', () => {
    const settings = createDefaultIdleScreenSettings();
    settings.slides.prices = false;
    settings.slides.howToCopy = false;
    const slides = buildPlaylist(info({ settings }), 0).slides;
    expect(slides).not.toContain('prices');
    expect(slides).not.toContain('howToCopy');
  });

  it('always keeps welcome and status', () => {
    const settings = createDefaultIdleScreenSettings();
    for (const key of Object.keys(settings.slides) as Array<
      keyof typeof settings.slides
    >) {
      settings.slides[key] = false;
    }
    expect(buildPlaylist(info({ settings }), 0).slides).toEqual([
      'welcome',
      'status',
    ]);
  });

  it('skips slides for an unavailable service and leads with repeated status', () => {
    const degraded = info();
    degraded.services.copy = { state: 'unavailable', reason: 'paper_out' };
    expect(buildPlaylist(degraded, 0).slides).toEqual([
      'status',
      'welcome',
      'howToPrint',
      'status',
      'scanToPhone',
      'prices',
      'status',
      'paying',
      'supportedFiles',
      'status',
      'privacyReceipt',
    ]);
  });

  it('skips print slides when print is unavailable', () => {
    const degraded = info();
    degraded.services.print = {
      state: 'unavailable',
      reason: 'printer_offline',
    };
    const slides = buildPlaylist(degraded, 0).slides;
    expect(slides).not.toContain('howToPrint');
    expect(slides).not.toContain('supportedFiles');
  });

  it('keeps how-to slides for a limited service but leads with status', () => {
    const limited = info();
    limited.services.print = { state: 'limited', reason: 'paper_low' };
    const slides = buildPlaylist(limited, 0).slides;
    expect(slides[0]).toBe('status');
    expect(slides).toContain('howToPrint');
  });

  it('treats exact-coins-only as degraded', () => {
    expect(
      buildPlaylist(info({ change: { exactCoinsOnly: true } }), 0).slides[0],
    ).toBe('status');
  });

  it('drops prices when pricing is missing', () => {
    expect(buildPlaylist(info({ pricing: null }), 0).slides).not.toContain(
      'prices',
    );
  });

  it('works before any info has arrived', () => {
    const playlist = buildPlaylist(null, 0);
    expect(playlist.slides).toEqual(CATALOG.filter((id) => id !== 'prices'));
    expect(playlist.lang).toBe('en');
  });

  it('alternates English and Filipino by cycle', () => {
    expect(buildPlaylist(info(), 0).lang).toBe('en');
    expect(buildPlaylist(info(), 1).lang).toBe('fil');
    expect(buildPlaylist(info(), 2).lang).toBe('en');
  });
});

describe('playlistSignature', () => {
  it('changes when a service state changes', () => {
    const changed = info();
    changed.services.scan = {
      state: 'unavailable',
      reason: 'scanner_unavailable',
    };
    expect(playlistSignature(changed)).not.toBe(playlistSignature(info()));
  });

  it('ignores price values but notices missing pricing', () => {
    const cheaper = info({
      pricing: {
        printBwFrom: 2,
        printColorFrom: 10,
        copyBw: 2,
        copyColor: 4,
        scan: 3,
      },
    });
    expect(playlistSignature(cheaper)).toBe(playlistSignature(info()));
    expect(playlistSignature(info({ pricing: null }))).not.toBe(
      playlistSignature(info()),
    );
  });

  it('changes when settings change', () => {
    const settings = createDefaultIdleScreenSettings();
    settings.slides.paying = false;
    expect(playlistSignature(info({ settings }))).not.toBe(
      playlistSignature(info()),
    );
  });
});
```

Create `src/public/shared/idle/idle-copy.spec.ts`:

```ts
import {
  IDLE_SLIDE_IDS,
  createDefaultIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';
import {
  IDLE_UI_TEXT,
  chipStateLabel,
  renderSlideText,
  serviceLabel,
  statusLines,
  statusSummary,
} from './idle-copy';

const info = (overrides: Partial<IdleInfo> = {}): IdleInfo => ({
  settings: createDefaultIdleScreenSettings(),
  pricing: {
    printBwFrom: 3,
    printColorFrom: 18,
    copyBw: 3,
    copyColor: 5,
    scan: 5,
  },
  services: {
    print: { state: 'ready', reason: null },
    copy: { state: 'ready', reason: null },
    scan: { state: 'ready', reason: null },
  },
  paper: { level: 'ok' },
  change: { exactCoinsOnly: false },
  coins: [1, 5, 10, 20],
  maxUploadMb: 25,
  wordUploads: true,
  ...overrides,
});

describe('renderSlideText', () => {
  it.each(['en', 'fil'] as const)(
    'renders every slide in %s with and without info',
    (lang) => {
      for (const id of IDLE_SLIDE_IDS) {
        expect(renderSlideText(id, lang, info()).title.length).toBeGreaterThan(
          0,
        );
        expect(renderSlideText(id, lang, null).title.length).toBeGreaterThan(0);
      }
    },
  );

  it('shows "from" prices', () => {
    const text = renderSlideText('prices', 'en', info());
    expect(text.lines).toEqual([
      'B/W print from ₱3 per page',
      'Color print from ₱18 per page',
      'B/W copy ₱3 per page',
      'Color copy ₱5 per page',
      'Scan ₱5 per document',
    ]);
  });

  it('lists accepted coins and adds the exact-amount note when change is out', () => {
    expect(renderSlideText('paying', 'en', info()).body).toContain(
      '₱1, ₱5, ₱10, ₱20',
    );
    expect(renderSlideText('paying', 'en', info()).body).not.toContain(
      'exact amount',
    );
    expect(
      renderSlideText(
        'paying',
        'en',
        info({ change: { exactCoinsOnly: true } }),
      ).body,
    ).toContain('exact amount');
  });

  it('mentions Word only when Word uploads are on', () => {
    expect(renderSlideText('supportedFiles', 'en', info()).body).toContain(
      'Word',
    );
    expect(
      renderSlideText('supportedFiles', 'en', info({ wordUploads: false }))
        .body,
    ).not.toContain('Word');
    expect(renderSlideText('supportedFiles', 'en', info()).body).toContain(
      '25 MB',
    );
  });

  it('marks only the how-to slides as stepped', () => {
    expect(renderSlideText('howToPrint', 'en', info()).stepped).toBe(true);
    expect(renderSlideText('howToPrint', 'en', info()).lines).toHaveLength(4);
    expect(renderSlideText('prices', 'en', info()).stepped).toBe(false);
    expect(renderSlideText('status', 'en', info()).stepped).toBe(false);
  });

  it('titles the status slide by kiosk health', () => {
    expect(renderSlideText('status', 'en', info()).title).toBe(
      'Everything is ready.',
    );
    const down = info();
    down.services.copy = { state: 'unavailable', reason: 'paper_out' };
    expect(renderSlideText('status', 'en', down).title).toBe(
      'Some services are limited.',
    );
    expect(renderSlideText('status', 'en', null).title).toBe(
      'Checking the kiosk…',
    );
  });
});

describe('status text', () => {
  it('describes each service with its reason, paper, and change', () => {
    const down = info({
      paper: { level: 'out' },
      change: { exactCoinsOnly: true },
    });
    down.services.copy = { state: 'unavailable', reason: 'paper_out' };
    expect(statusLines(down, 'en')).toEqual([
      'Print — Ready',
      'Copy — Unavailable: out of paper',
      'Scan — Ready',
      'Paper: out',
      "Exact coins only: change can't be given right now.",
    ]);
  });

  it('says Checking… for every service before info arrives', () => {
    expect(statusLines(null, 'en')).toEqual([
      'Print — Checking…',
      'Copy — Checking…',
      'Scan — Checking…',
    ]);
    expect(statusLines(null, 'fil')[0]).toBe('Print — Sinusuri…');
  });

  it('joins lines for screen readers', () => {
    expect(statusSummary(null, 'en')).toBe(
      'Print — Checking…. Copy — Checking…. Scan — Checking…',
    );
  });

  it('labels chips and UI in both languages', () => {
    expect(serviceLabel('scan', 'en')).toBe('Scan');
    expect(chipStateLabel('limited', 'fil')).toBe('Limitado');
    expect(IDLE_UI_TEXT.fil.cta).toBe('Pindutin kahit saan para magsimula');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec jest src/public/shared/idle`
Expected: FAIL with `Cannot find module './idle-slides'` and `'./idle-copy'`.

- [ ] **Step 3: Write `idle-copy.ts`**

Create `src/public/shared/idle/idle-copy.ts`:

```ts
/**
 * Idle screen text in English and Filipino. The idle overlay opts out of the
 * kiosk-wide phrase translator (data-i18n-skip) because it alternates
 * languages per cycle, so its strings live here instead of locales/.
 */
import type {
  IdleInfo,
  IdlePaperLevel,
  IdlePricingSummary,
  IdleServiceName,
  IdleServiceReason,
  IdleServiceState,
  IdleServiceStatus,
  IdleSlideId,
} from '@/shared/idle-screen-contract';
import { isIdleDegraded } from '@/shared/idle-screen-contract';
import { formatPeso } from '../pricing-guide';

export type IdleLang = 'en' | 'fil';

export const IDLE_FALLBACK_COINS: readonly number[] = [1, 5, 10, 20];
export const IDLE_FALLBACK_MAX_UPLOAD_MB = 25;
export const IDLE_SERVICE_ORDER: readonly IdleServiceName[] = [
  'print',
  'copy',
  'scan',
];

export interface IdleSlideText {
  eyebrow: string;
  title: string;
  body: string;
  lines: string[];
  stepped: boolean;
}

type FixedSlideId =
  | 'welcome'
  | 'howToPrint'
  | 'howToCopy'
  | 'idCardCopy'
  | 'scanToPhone'
  | 'privacyReceipt';

interface IdleLangTable {
  ui: { cta: string; overlayLabel: string; chipsLabel: string };
  services: Record<IdleServiceName, string>;
  states: Record<IdleServiceState, string>;
  reasons: Record<IdleServiceReason, string>;
  paper: Record<Exclude<IdlePaperLevel, 'unknown'>, string>;
  exactCoins: string;
  status: {
    eyebrow: string;
    titleReady: string;
    titleLimited: string;
    titleChecking: string;
  };
  fixed: Record<FixedSlideId, IdleSlideText>;
  prices: {
    eyebrow: string;
    title: string;
    body: string;
    lines: (p: IdlePricingSummary) => string[];
  };
  paying: {
    eyebrow: string;
    title: string;
    body: (coins: string) => string;
    exactCoins: string;
  };
  supportedFiles: {
    eyebrow: string;
    title: string;
    body: (mb: number, word: boolean) => string;
  };
}

const TEXT: Record<IdleLang, IdleLangTable> = {
  en: {
    ui: {
      cta: 'Tap anywhere to start',
      overlayLabel: 'PrintBit kiosk is idle. Tap anywhere to start.',
      chipsLabel: 'Service status',
    },
    services: { print: 'Print', copy: 'Copy', scan: 'Scan' },
    states: {
      ready: 'Ready',
      limited: 'Limited',
      unavailable: 'Unavailable',
      unknown: 'Checking…',
    },
    reasons: {
      printer_offline: 'printer is offline',
      printer_error: 'printer needs attention',
      paper_out: 'out of paper',
      paper_low: 'paper is running low',
      scanner_unavailable: 'scanner is not available',
    },
    paper: { ok: 'Paper: OK', low: 'Paper: running low', out: 'Paper: out' },
    exactCoins: "Exact coins only: change can't be given right now.",
    status: {
      eyebrow: 'Kiosk status',
      titleReady: 'Everything is ready.',
      titleLimited: 'Some services are limited.',
      titleChecking: 'Checking the kiosk…',
    },
    fixed: {
      welcome: {
        eyebrow: 'PrintBit self-service',
        title: 'Print, copy, and scan.',
        body: 'All you need is coins and your phone.',
        lines: [],
        stepped: false,
      },
      howToPrint: {
        eyebrow: 'How to print',
        title: 'From your phone to paper.',
        body: '',
        lines: [
          'Tap Print and scan the QR code.',
          'Upload your file from your phone.',
          'Choose pages, color, and copies.',
          'Insert coins, then collect your printout.',
        ],
        stepped: true,
      },
      howToCopy: {
        eyebrow: 'How to copy',
        title: 'Photocopy in a few taps.',
        body: '',
        lines: [
          'Tap Copy.',
          'Place your document on the glass or in the feeder.',
          'Set copies and color.',
          'Insert coins, then collect your copies.',
        ],
        stepped: true,
      },
      idCardCopy: {
        eyebrow: 'ID card copy',
        title: 'Both sides on one sheet.',
        body: 'Scan the front, flip the card, scan the back. See the sheet before you pay.',
        lines: [],
        stepped: false,
      },
      scanToPhone: {
        eyebrow: 'Scan to phone',
        title: 'Paper to your pocket.',
        body: '',
        lines: [
          'Tap Scan and place your document.',
          'Scan the QR code on the screen.',
          'Download the PDF on your phone.',
        ],
        stepped: true,
      },
      privacyReceipt: {
        eyebrow: 'Privacy',
        title: 'Your files stay yours.',
        body: 'Files are deleted after your job. Your e-receipt goes to your phone.',
        lines: [],
        stepped: false,
      },
    },
    prices: {
      eyebrow: 'Prices',
      title: 'Pay only for what you use.',
      body: 'Print prices depend on paper size and how much ink a page uses.',
      lines: (p) => [
        `B/W print from ${formatPeso(p.printBwFrom)} per page`,
        `Color print from ${formatPeso(p.printColorFrom)} per page`,
        `B/W copy ${formatPeso(p.copyBw)} per page`,
        `Color copy ${formatPeso(p.copyColor)} per page`,
        `Scan ${formatPeso(p.scan)} per document`,
      ],
    },
    paying: {
      eyebrow: 'Paying',
      title: 'Coins only, whole pesos.',
      body: (coins) =>
        `Accepted coins: ${coins}. The kiosk gives back your change.`,
      exactCoins:
        "Change can't be given right now. Please pay the exact amount.",
    },
    supportedFiles: {
      eyebrow: 'Supported files',
      title: 'Bring your document.',
      body: (mb, word) =>
        word
          ? `PDF, Word, and images (JPG, PNG, GIF, WebP, BMP), up to ${mb} MB per file.`
          : `PDF and images (JPG, PNG, GIF, WebP, BMP), up to ${mb} MB per file.`,
    },
  },
  fil: {
    ui: {
      cta: 'Pindutin kahit saan para magsimula',
      overlayLabel:
        'Nakatigil ang PrintBit kiosk. Pindutin kahit saan para magsimula.',
      chipsLabel: 'Kalagayan ng serbisyo',
    },
    services: { print: 'Print', copy: 'Copy', scan: 'Scan' },
    states: {
      ready: 'Handa',
      limited: 'Limitado',
      unavailable: 'Hindi magagamit',
      unknown: 'Sinusuri…',
    },
    reasons: {
      printer_offline: 'naka-offline ang printer',
      printer_error: 'may problema ang printer',
      paper_out: 'ubos ang papel',
      paper_low: 'paubos na ang papel',
      scanner_unavailable: 'hindi magamit ang scanner',
    },
    paper: { ok: 'Papel: OK', low: 'Papel: paubos na', out: 'Papel: ubos na' },
    exactCoins: 'Eksaktong barya lang: hindi makakapagsukli sa ngayon.',
    status: {
      eyebrow: 'Kalagayan ng kiosk',
      titleReady: 'Handa na ang lahat.',
      titleLimited: 'May limitadong serbisyo ngayon.',
      titleChecking: 'Sinusuri ang kiosk…',
    },
    fixed: {
      welcome: {
        eyebrow: 'PrintBit self-service',
        title: 'Mag-print, mag-copy, at mag-scan.',
        body: 'Barya at cellphone lang ang kailangan mo.',
        lines: [],
        stepped: false,
      },
      howToPrint: {
        eyebrow: 'Paano mag-print',
        title: 'Mula cellphone hanggang papel.',
        body: '',
        lines: [
          'I-tap ang Print at i-scan ang QR code.',
          'I-upload ang file mula sa cellphone mo.',
          'Piliin ang pages, kulay, at dami ng kopya.',
          'Maghulog ng barya, saka kunin ang print mo.',
        ],
        stepped: true,
      },
      howToCopy: {
        eyebrow: 'Paano mag-copy',
        title: 'Photocopy sa ilang tap lang.',
        body: '',
        lines: [
          'I-tap ang Copy.',
          'Ilagay ang dokumento sa salamin o sa feeder.',
          'Itakda ang dami ng kopya at kulay.',
          'Maghulog ng barya, saka kunin ang kopya mo.',
        ],
        stepped: true,
      },
      idCardCopy: {
        eyebrow: 'Kopya ng ID',
        title: 'Harap at likod sa iisang papel.',
        body: 'I-scan ang harap, baligtarin ang card, at i-scan ang likod. Makikita mo muna ang papel bago magbayad.',
        lines: [],
        stepped: false,
      },
      scanToPhone: {
        eyebrow: 'I-scan papunta sa cellphone',
        title: 'Papel papunta sa bulsa mo.',
        body: '',
        lines: [
          'I-tap ang Scan at ilagay ang dokumento.',
          'I-scan ang QR code sa screen.',
          'I-download ang PDF sa cellphone mo.',
        ],
        stepped: true,
      },
      privacyReceipt: {
        eyebrow: 'Privacy',
        title: 'Sa iyo lang ang mga file mo.',
        body: 'Binubura ang mga file pagkatapos ng job. Sa cellphone mo ipapadala ang e-receipt.',
        lines: [],
        stepped: false,
      },
    },
    prices: {
      eyebrow: 'Presyo',
      title: 'Bayaran lang ang ginamit mo.',
      body: 'Nakadepende ang presyo ng print sa laki ng papel at dami ng tinta sa pahina.',
      lines: (p) => [
        `B/W print mula ${formatPeso(p.printBwFrom)} bawat pahina`,
        `Color print mula ${formatPeso(p.printColorFrom)} bawat pahina`,
        `B/W copy ${formatPeso(p.copyBw)} bawat pahina`,
        `Color copy ${formatPeso(p.copyColor)} bawat pahina`,
        `Scan ${formatPeso(p.scan)} bawat dokumento`,
      ],
    },
    paying: {
      eyebrow: 'Pagbabayad',
      title: 'Barya lang, buong piso.',
      body: (coins) => `Tinatanggap: ${coins}. Isusukli ng kiosk ang sobra.`,
      exactCoins:
        'Hindi makakapagsukli sa ngayon. Pakibayaran ang eksaktong halaga.',
    },
    supportedFiles: {
      eyebrow: 'Mga file na puwede',
      title: 'Dalhin ang dokumento mo.',
      body: (mb, word) =>
        word
          ? `PDF, Word, at mga larawan (JPG, PNG, GIF, WebP, BMP), hanggang ${mb} MB bawat file.`
          : `PDF at mga larawan (JPG, PNG, GIF, WebP, BMP), hanggang ${mb} MB bawat file.`,
    },
  },
};

export const IDLE_UI_TEXT: Record<IdleLang, IdleLangTable['ui']> = {
  en: TEXT.en.ui,
  fil: TEXT.fil.ui,
};

export function serviceLabel(name: IdleServiceName, lang: IdleLang): string {
  return TEXT[lang].services[name];
}

export function chipStateLabel(
  state: IdleServiceState,
  lang: IdleLang,
): string {
  return TEXT[lang].states[state];
}

export function statusLines(info: IdleInfo | null, lang: IdleLang): string[] {
  const t = TEXT[lang];
  const lines = IDLE_SERVICE_ORDER.map((name) => {
    const status: IdleServiceStatus = info
      ? info.services[name]
      : { state: 'unknown', reason: null };
    const base = `${t.services[name]} — ${t.states[status.state]}`;
    return status.reason ? `${base}: ${t.reasons[status.reason]}` : base;
  });
  const level = info?.paper.level ?? 'unknown';
  if (level !== 'unknown') lines.push(t.paper[level]);
  if (info?.change.exactCoinsOnly) lines.push(t.exactCoins);
  return lines;
}

export function statusSummary(info: IdleInfo | null, lang: IdleLang): string {
  return statusLines(info, lang).join('. ');
}

export function renderSlideText(
  id: IdleSlideId,
  lang: IdleLang,
  info: IdleInfo | null,
): IdleSlideText {
  const t = TEXT[lang];
  switch (id) {
    case 'status': {
      const title = !info
        ? t.status.titleChecking
        : isIdleDegraded(info)
          ? t.status.titleLimited
          : t.status.titleReady;
      return {
        eyebrow: t.status.eyebrow,
        title,
        body: '',
        lines: statusLines(info, lang),
        stepped: false,
      };
    }
    case 'prices':
      return {
        eyebrow: t.prices.eyebrow,
        title: t.prices.title,
        body: t.prices.body,
        lines: info?.pricing ? t.prices.lines(info.pricing) : [],
        stepped: false,
      };
    case 'paying': {
      const coins = (info?.coins ?? IDLE_FALLBACK_COINS)
        .map(formatPeso)
        .join(', ');
      const body = info?.change.exactCoinsOnly
        ? `${t.paying.body(coins)} ${t.paying.exactCoins}`
        : t.paying.body(coins);
      return {
        eyebrow: t.paying.eyebrow,
        title: t.paying.title,
        body,
        lines: [],
        stepped: false,
      };
    }
    case 'supportedFiles':
      return {
        eyebrow: t.supportedFiles.eyebrow,
        title: t.supportedFiles.title,
        body: t.supportedFiles.body(
          info?.maxUploadMb ?? IDLE_FALLBACK_MAX_UPLOAD_MB,
          info?.wordUploads ?? false,
        ),
        lines: [],
        stepped: false,
      };
    default: {
      const fixed = t.fixed[id];
      return { ...fixed, lines: [...fixed.lines] };
    }
  }
}
```

- [ ] **Step 4: Write `idle-slides.ts`**

Create `src/public/shared/idle/idle-slides.ts`:

```ts
import {
  createDefaultIdleScreenSettings,
  isDisableableIdleSlideId,
  isIdleDegraded,
  type IdleInfo,
  type IdleServiceName,
  type IdleSlideId,
} from '@/shared/idle-screen-contract';
import type { IdleLang } from './idle-copy';

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
  slot('status', 'status', null),
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

export interface IdlePlaylist {
  slides: IdleSlideId[];
  lang: IdleLang;
}

/**
 * Orders one cycle of slides. Disabled slides, slides for unavailable
 * services, and prices without pricing data are dropped. When the kiosk is
 * degraded, status leads and repeats after every two other slides.
 */
export function buildPlaylist(
  info: IdleInfo | null,
  cycleIndex: number,
): IdlePlaylist {
  const settings = info?.settings ?? createDefaultIdleScreenSettings();
  const base = IDLE_SLIDES.filter((slide) => {
    if (
      slide.disableable &&
      isDisableableIdleSlideId(slide.id) &&
      !settings.slides[slide.id]
    ) {
      return false;
    }
    if (
      slide.service &&
      info?.services[slide.service].state === 'unavailable'
    ) {
      return false;
    }
    if (slide.id === 'prices' && !info?.pricing) return false;
    return true;
  }).map((slide) => slide.id);

  const lang: IdleLang = cycleIndex % 2 === 0 ? 'en' : 'fil';
  if (!isIdleDegraded(info)) return { slides: base, lang };

  const others = base.filter((id) => id !== 'status');
  const slides: IdleSlideId[] = ['status'];
  others.forEach((id, index) => {
    slides.push(id);
    const isLast = index === others.length - 1;
    if ((index + 1) % 2 === 0 && !isLast) slides.push('status');
  });
  return { slides, lang };
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec jest src/public/shared/idle`
Expected: PASS for both spec files.

- [ ] **Step 6: Commit**

```bash
git add src/public/shared/idle/idle-copy.ts src/public/shared/idle/idle-slides.ts src/public/shared/idle/idle-copy.spec.ts src/public/shared/idle/idle-slides.spec.ts
git commit -m "feat(idle): add bilingual idle copy and playlist rules"
```

---

### Task 8: Status poller and carousel timing

**Files:**

- Create: `src/public/shared/idle/idle-status.ts`
- Create: `src/public/shared/idle/idle-carousel.ts`
- Test: `src/public/shared/idle/idle-status.spec.ts`
- Test: `src/public/shared/idle/idle-carousel.spec.ts`

**Interfaces:**

- Consumes (Task 1): `IdleInfo`, `IdleSlideId`, `IDLE_SLIDE_DURATION_DEFAULT_SECONDS`. (Task 7): `buildPlaylist`, `IdlePlaylist`, `IdleLang`.
- Produces:
  - `fetchIdleInfo(): Promise<IdleInfo>` (GET `/api/idle/info`, `cache: 'no-store'`, throws on non-OK).
  - `IDLE_STATUS_POLL_MS = 30_000`
  - `class IdleStatusPoller { constructor(deps: { fetchInfo: () => Promise<IdleInfo>; onUpdate: (info: IdleInfo) => void; intervalMs?: number }); get latest(): IdleInfo | null; start(): void; stop(): void }`
  - `class IdleCarousel { constructor(deps: { getInfo: () => IdleInfo | null; showSlide: (id: IdleSlideId, lang: IdleLang, durationMs: number) => void }); start(): void; stop(): void; invalidate(): void }`

- [ ] **Step 1: Write the failing tests**

Create `src/public/shared/idle/idle-status.spec.ts`:

```ts
import type { IdleInfo } from '@/shared/idle-screen-contract';
import { IdleStatusPoller } from './idle-status';

const INFO = { coins: [1] } as unknown as IdleInfo;
const LATER = { coins: [5] } as unknown as IdleInfo;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('IdleStatusPoller', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fetches at start and every 30 s while running, then stops cleanly', async () => {
    const fetchInfo = jest.fn().mockResolvedValue(INFO);
    const onUpdate = jest.fn();
    const poller = new IdleStatusPoller({ fetchInfo, onUpdate });

    poller.start();
    await flush();
    expect(fetchInfo).toHaveBeenCalledTimes(1);
    expect(poller.latest).toBe(INFO);
    expect(onUpdate).toHaveBeenCalledWith(INFO);

    jest.advanceTimersByTime(30_000);
    await flush();
    expect(fetchInfo).toHaveBeenCalledTimes(2);

    poller.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(90_000);
    await flush();
    expect(fetchInfo).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good info when a fetch fails', async () => {
    const fetchInfo = jest
      .fn()
      .mockResolvedValueOnce(INFO)
      .mockRejectedValueOnce(new Error('offline'));
    const poller = new IdleStatusPoller({ fetchInfo, onUpdate: jest.fn() });
    poller.start();
    await flush();
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(poller.latest).toBe(INFO);
    poller.stop();
  });

  it('ignores a response that lands after stop', async () => {
    let resolve: (info: IdleInfo) => void = () => {};
    const fetchInfo = jest.fn(
      () =>
        new Promise<IdleInfo>((r) => {
          resolve = r;
        }),
    );
    const onUpdate = jest.fn();
    const poller = new IdleStatusPoller({ fetchInfo, onUpdate });
    poller.start();
    poller.stop();
    resolve(LATER);
    await flush();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(poller.latest).toBeNull();
  });

  it('does not start a second interval when started twice', async () => {
    const fetchInfo = jest.fn().mockResolvedValue(INFO);
    const poller = new IdleStatusPoller({ fetchInfo, onUpdate: jest.fn() });
    poller.start();
    poller.start();
    expect(jest.getTimerCount()).toBe(1);
    poller.stop();
  });
});
```

Create `src/public/shared/idle/idle-carousel.spec.ts`:

```ts
import {
  createDefaultIdleScreenSettings,
  type IdleInfo,
} from '@/shared/idle-screen-contract';
import { IdleCarousel } from './idle-carousel';

const info = (overrides: Partial<IdleInfo> = {}): IdleInfo => ({
  settings: createDefaultIdleScreenSettings(),
  pricing: {
    printBwFrom: 3,
    printColorFrom: 18,
    copyBw: 3,
    copyColor: 5,
    scan: 5,
  },
  services: {
    print: { state: 'ready', reason: null },
    copy: { state: 'ready', reason: null },
    scan: { state: 'ready', reason: null },
  },
  paper: { level: 'ok' },
  change: { exactCoinsOnly: false },
  coins: [1, 5, 10, 20],
  maxUploadMb: 25,
  wordUploads: true,
  ...overrides,
});

describe('IdleCarousel', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows slides in order, then starts the next cycle in Filipino', () => {
    const showSlide = jest.fn();
    const carousel = new IdleCarousel({ getInfo: () => info(), showSlide });
    carousel.start();
    expect(showSlide).toHaveBeenLastCalledWith('welcome', 'en', 8000);
    jest.advanceTimersByTime(8000);
    expect(showSlide).toHaveBeenLastCalledWith('status', 'en', 8000);
    jest.advanceTimersByTime(8000 * 8);
    expect(showSlide).toHaveBeenLastCalledWith('privacyReceipt', 'en', 8000);
    jest.advanceTimersByTime(8000);
    expect(showSlide).toHaveBeenLastCalledWith('welcome', 'fil', 8000);
    carousel.stop();
  });

  it('uses the configured slide duration', () => {
    const settings = createDefaultIdleScreenSettings();
    settings.slideDurationSeconds = 12;
    const showSlide = jest.fn();
    const carousel = new IdleCarousel({
      getInfo: () => info({ settings }),
      showSlide,
    });
    carousel.start();
    expect(showSlide).toHaveBeenLastCalledWith('welcome', 'en', 12000);
    carousel.stop();
  });

  it('runs with no info yet using the default duration', () => {
    const showSlide = jest.fn();
    const carousel = new IdleCarousel({ getInfo: () => null, showSlide });
    carousel.start();
    expect(showSlide).toHaveBeenLastCalledWith('welcome', 'en', 8000);
    carousel.stop();
  });

  it('leaves no timers after stop and ignores a second start', () => {
    const carousel = new IdleCarousel({
      getInfo: () => info(),
      showSlide: jest.fn(),
    });
    carousel.start();
    carousel.start();
    expect(jest.getTimerCount()).toBe(1);
    carousel.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rebuilds after invalidate and leads with status once degraded', () => {
    let current: IdleInfo | null = null;
    const showSlide = jest.fn();
    const carousel = new IdleCarousel({ getInfo: () => current, showSlide });
    carousel.start();
    expect(showSlide).toHaveBeenLastCalledWith('welcome', 'en', 8000);

    const degraded = info();
    degraded.services.scan = {
      state: 'unavailable',
      reason: 'scanner_unavailable',
    };
    current = degraded;
    carousel.invalidate();
    jest.advanceTimersByTime(8000);
    expect(showSlide).toHaveBeenLastCalledWith('status', 'en', 8000);
    carousel.stop();
  });

  it('does not repeat the slide on screen when a rebuild starts with it', () => {
    let current: IdleInfo | null = null;
    const showSlide = jest.fn();
    const carousel = new IdleCarousel({ getInfo: () => current, showSlide });
    carousel.start();
    current = info();
    carousel.invalidate();
    jest.advanceTimersByTime(8000);
    expect(showSlide).toHaveBeenLastCalledWith('status', 'en', 8000);
    carousel.stop();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec jest src/public/shared/idle/idle-status.spec.ts src/public/shared/idle/idle-carousel.spec.ts`
Expected: FAIL with `Cannot find module './idle-status'` and `'./idle-carousel'`.

- [ ] **Step 3: Write `idle-status.ts`**

Create `src/public/shared/idle/idle-status.ts`:

```ts
import type { IdleInfo } from '@/shared/idle-screen-contract';

export const IDLE_STATUS_POLL_MS = 30_000;

export async function fetchIdleInfo(): Promise<IdleInfo> {
  const response = await fetch('/api/idle/info', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Idle info failed: ${response.status}`);
  return (await response.json()) as IdleInfo;
}

export interface IdleStatusPollerDeps {
  fetchInfo: () => Promise<IdleInfo>;
  onUpdate: (info: IdleInfo) => void;
  intervalMs?: number;
}

/**
 * Polls idle info only while started. A failed fetch keeps the last good
 * response; a response that lands after stop() is dropped.
 */
export class IdleStatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private latestInfo: IdleInfo | null = null;

  constructor(private readonly deps: IdleStatusPollerDeps) {}

  get latest(): IdleInfo | null {
    return this.latestInfo;
  }

  start(): void {
    if (this.timer !== null) return;
    this.generation += 1;
    void this.refresh(this.generation);
    this.timer = setInterval(
      () => void this.refresh(this.generation),
      this.deps.intervalMs ?? IDLE_STATUS_POLL_MS,
    );
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.generation += 1;
  }

  private async refresh(generation: number): Promise<void> {
    try {
      const info = await this.deps.fetchInfo();
      if (generation !== this.generation) return;
      this.latestInfo = info;
      this.deps.onUpdate(info);
    } catch (error) {
      console.warn(
        '[IdleScreen] Idle info refresh failed; keeping last data.',
        error,
      );
    }
  }
}
```

- [ ] **Step 4: Write `idle-carousel.ts`**

Create `src/public/shared/idle/idle-carousel.ts`:

```ts
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
      info?.settings.slideDurationSeconds ??
      IDLE_SLIDE_DURATION_DEFAULT_SECONDS;
    const durationMs = seconds * 1000;
    this.deps.showSlide(id, this.playlist.lang, durationMs);
    this.timer = setTimeout(() => this.step(), durationMs);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec jest src/public/shared/idle`
Expected: PASS for all idle specs so far.

- [ ] **Step 6: Commit**

```bash
git add src/public/shared/idle/idle-status.ts src/public/shared/idle/idle-carousel.ts src/public/shared/idle/idle-status.spec.ts src/public/shared/idle/idle-carousel.spec.ts
git commit -m "feat(idle): add idle status poller and slide carousel"
```

---

### Task 9: Lottie stage with 30 Hz frame stepping

**Files:**

- Create: `src/public/shared/idle/idle-lottie.ts`
- Create: `src/public/shared/idle/idle-dotlottie.ts`
- Test: `src/public/shared/idle/idle-lottie.spec.ts`

**Interfaces:**

- Consumes: `DotLottie` from `@lottiefiles/dotlottie-web` (adapter only).
- Produces from `idle-lottie.ts`:
  - `IDLE_LOTTIE_FPS = 30`, `IDLE_LOTTIE_FRAME_MS = 33`, `IDLE_LOTTIE_MAX_FAILURES = 3`, `IDLE_LOTTIE_RENDER_CONFIG = { devicePixelRatio: 1, autoResize: true, freezeOnOffscreen: true }`
  - `interface IdleLottiePlayer { load(config: { data: ArrayBuffer; autoplay: boolean; loop: boolean; renderConfig: typeof IDLE_LOTTIE_RENDER_CONFIG }): void; setFrame(frame: number): void; addEventListener(type: 'load' | 'loadError' | 'renderError', listener: () => void): void; readonly totalFrames: number; readonly duration: number; destroy(): void }`
  - `interface IdleStageSlide { src: string; poster: string }`
  - `class IdleLottieStage { constructor(deps: { canvas: HTMLCanvasElement; poster: HTMLImageElement; createPlayer: (canvas: HTMLCanvasElement) => IdleLottiePlayer; fetchAsset: (src: string) => Promise<ArrayBuffer>; reducedMotion: boolean; now?: () => number }); prefetch(srcs: readonly string[]): Promise<void>; show(slide: IdleStageSlide): void; pause(): void; resume(): void; destroy(): void }`
- Produces from `idle-dotlottie.ts`: `createDotLottiePlayer(canvas: HTMLCanvasElement): IdleLottiePlayer`, `fetchLottieAsset(src: string): Promise<ArrayBuffer>`.

- [ ] **Step 1: Write the failing test**

Create `src/public/shared/idle/idle-lottie.spec.ts`:

```ts
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
  const fetchAsset = jest.fn(async () => new ArrayBuffer(8));
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
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

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
    expect(players[0]?.load ?? jest.fn()).not.toHaveBeenCalled();
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/public/shared/idle/idle-lottie.spec.ts`
Expected: FAIL with `Cannot find module './idle-lottie'`.

- [ ] **Step 3: Write `idle-lottie.ts`**

Create `src/public/shared/idle/idle-lottie.ts`:

```ts
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
```

Note for the "steps frames at 30 Hz" test: 990 ms at a 33 ms interval fires
30 times; the last tick sees 0.99 s of a 2.0 s, 60-frame animation, so frame
`floor(0.495 × 60) = 29`. Jest's modern fake timers also fake `Date.now`, which
the stage uses for elapsed time.

- [ ] **Step 4: Write the DotLottie adapter**

Create `src/public/shared/idle/idle-dotlottie.ts`:

```ts
import { DotLottie } from '@lottiefiles/dotlottie-web';
import {
  IDLE_LOTTIE_RENDER_CONFIG,
  type IdleLottiePlayer,
} from './idle-lottie';

const DOTLOTTIE_WASM_URL = '/vendor/dotlottie/dotlottie-player.wasm';

/** Wraps DotLottie in the small interface the idle stage needs. */
export function createDotLottiePlayer(
  canvas: HTMLCanvasElement,
): IdleLottiePlayer {
  DotLottie.setWasmUrl(DOTLOTTIE_WASM_URL);
  const player = new DotLottie({
    canvas,
    autoplay: false,
    loop: false,
    renderConfig: IDLE_LOTTIE_RENDER_CONFIG,
  });
  return {
    load: (config) => player.load(config),
    setFrame: (frame) => player.setFrame(frame),
    addEventListener: (type, listener) =>
      player.addEventListener(type, () => listener()),
    get totalFrames() {
      return player.totalFrames;
    },
    get duration() {
      return player.duration;
    },
    destroy: () => player.destroy(),
  };
}

export async function fetchLottieAsset(src: string): Promise<ArrayBuffer> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Lottie slot ${src}: ${response.status}`);
  return response.arrayBuffer();
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `pnpm exec jest src/public/shared/idle/idle-lottie.spec.ts`
Expected: PASS.

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: exit 0. If TypeScript rejects `player.addEventListener(type, ...)`
because of the library's generic event typing, change that line to
`player.addEventListener(type as 'load', () => listener())` and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/public/shared/idle/idle-lottie.ts src/public/shared/idle/idle-dotlottie.ts src/public/shared/idle/idle-lottie.spec.ts
git commit -m "feat(idle): add single-player Lottie stage with 30 Hz stepping"
```

---

### Task 10: Slot animations and posters

**Files:**

- Create: `scripts/lib/dotlottie-zip.js`
- Create: `scripts/build-idle-lottie-slots.js`
- Create (generated): `src/public/assets/lottie/idle/*.lottie` (10 files), `src/public/assets/lottie/idle/posters/*.svg` (10 files)

**Interfaces:**

- Consumes: the `.lottie` and `.json` files in `src/public/assets/lottie/`.
- Produces: one slot file per path in `IDLE_SLIDES` (Task 7): `welcome`, `status`, `how-to-print`, `how-to-copy`, `id-card-copy`, `scan-to-phone`, `prices`, `paying`, `supported-files`, `privacy-receipt`, each as `.lottie` plus `posters/<name>.svg`.

The existing `scripts/generate-confirm-lottie-assets.js` has its own zip
writer. Do not edit or run it: it would overwrite the newer
`printing.lottie`.

- [ ] **Step 1: Write the zip helper**

Create `scripts/lib/dotlottie-zip.js`:

```js
const zlib = require('node:zlib');

// Fixed timestamp keeps generated archives byte-stable across runs.
const DEFAULT_DOS_TIME = { time: 0x6000, date: 0x5d71 }; // 2026-11-17 12:00:00

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** Builds a deflate ZIP archive from [{ name, data }] entries. */
const createZip = (entries, dosTime = DEFAULT_DOS_TIME) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime.time, 10);
    localHeader.writeUInt16LE(dosTime.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime.time, 12);
    centralHeader.writeUInt16LE(dosTime.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
};

/** Packs one Lottie JSON animation into a dotLottie v2 archive. */
const packDotLottie = (id, displayName, animationJson) => {
  const manifest = {
    version: '2',
    generator: 'PrintBit idle slot builder 1.0',
    initial: { animation: id },
    animations: [{ id, name: displayName }],
  };
  return createZip([
    { name: 'manifest.json', data: `${JSON.stringify(manifest)}\n` },
    { name: `a/${id}.json`, data: animationJson },
  ]);
};

module.exports = { createZip, crc32, packDotLottie };
```

- [ ] **Step 2: Write the slot builder**

Create `scripts/build-idle-lottie-slots.js`:

```js
/**
 * Fills the idle screen's Lottie slots and posters.
 *
 *   node scripts/build-idle-lottie-slots.js          # create missing files only
 *   node scripts/build-idle-lottie-slots.js --force  # overwrite every slot
 *
 * Existing slot files are kept by default so a custom or downloaded
 * animation dropped into a slot is never overwritten.
 */
const fs = require('node:fs');
const path = require('node:path');
const { packDotLottie } = require('./lib/dotlottie-zip');

const LOTTIE_DIR = path.resolve(
  __dirname,
  '..',
  'src',
  'public',
  'assets',
  'lottie',
);
const SLOT_DIR = path.join(LOTTIE_DIR, 'idle');
const POSTER_DIR = path.join(SLOT_DIR, 'posters');
const force = process.argv.includes('--force');

// [slot name, source file in assets/lottie, display name]
const SLOTS = [
  ['welcome', 'printing.lottie', 'PrintBit — Welcome'],
  ['status', 'paper-tray.lottie', 'PrintBit — Kiosk status'],
  ['how-to-print', 'upload.lottie', 'PrintBit — How to print'],
  ['how-to-copy', 'copy-glass.lottie', 'PrintBit — How to copy'],
  ['id-card-copy', 'copy-adf.lottie', 'PrintBit — ID card copy'],
  ['scan-to-phone', 'scan-transfer.lottie', 'PrintBit — Scan to phone'],
  ['prices', 'coin-insertion.json', 'PrintBit — Prices'],
  ['paying', 'coin-insertion.json', 'PrintBit — Paying'],
  ['supported-files', 'upload.lottie', 'PrintBit — Supported files'],
  ['privacy-receipt', 'scan-transfer.lottie', 'PrintBit — Privacy'],
];

const icon = (inner) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" aria-hidden="true">' +
  '<rect width="240" height="240" rx="48" fill="#696fc7" fill-opacity="0.16"/>' +
  '<g fill="none" stroke="#a7aae1" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">' +
  inner +
  '</g></svg>\n';

const POSTERS = {
  welcome: icon(
    '<path d="M80 95V55h80v40"/><rect x="55" y="95" width="130" height="65" rx="12"/><rect x="80" y="140" width="80" height="50" rx="4"/>',
  ),
  status: icon(
    '<circle cx="120" cy="120" r="64"/><path d="M90 122l22 22 40-46"/>',
  ),
  'how-to-print': icon(
    '<rect x="85" y="45" width="70" height="150" rx="14"/><path d="M110 170h20"/>',
  ),
  'how-to-copy': icon(
    '<rect x="60" y="60" width="90" height="115" rx="8"/><rect x="90" y="85" width="90" height="115" rx="8"/>',
  ),
  'id-card-copy': icon(
    '<rect x="45" y="75" width="150" height="95" rx="12"/><circle cx="90" cy="115" r="16"/><path d="M125 105h45M125 130h35M75 150h40"/>',
  ),
  'scan-to-phone': icon(
    '<rect x="40" y="60" width="90" height="120" rx="8"/><path d="M30 120h110"/><rect x="150" y="80" width="55" height="100" rx="10"/>',
  ),
  prices: icon(
    '<path d="M95 60v120M95 60h35a30 30 0 0 1 0 60H95M80 90h80M80 105h80"/>',
  ),
  paying: icon(
    '<circle cx="120" cy="120" r="64"/><path d="M105 85v70M105 85h20a20 20 0 0 1 0 40h-20M95 100h50M95 112h50"/>',
  ),
  'supported-files': icon(
    '<path d="M75 45h65l35 35v115H75z"/><path d="M140 45v35h35M95 120h60M95 145h60"/>',
  ),
  'privacy-receipt': icon(
    '<path d="M120 45l60 22v48c0 40-26 68-60 80-34-12-60-40-60-80V67z"/><path d="M95 120l18 18 35-38"/>',
  ),
};

const shouldWrite = (target) => force || !fs.existsSync(target);

fs.mkdirSync(POSTER_DIR, { recursive: true });

for (const [slot, source, displayName] of SLOTS) {
  const target = path.join(SLOT_DIR, `${slot}.lottie`);
  if (!shouldWrite(target)) {
    console.log(`keep   idle/${slot}.lottie (exists; --force to overwrite)`);
  } else {
    const sourcePath = path.join(LOTTIE_DIR, source);
    if (source.endsWith('.json')) {
      const json = fs.readFileSync(sourcePath, 'utf8');
      JSON.parse(json); // fail fast on a broken source
      fs.writeFileSync(target, packDotLottie(slot, displayName, json));
    } else {
      fs.copyFileSync(sourcePath, target);
    }
    console.log(`write  idle/${slot}.lottie <- ${source}`);
  }

  const posterTarget = path.join(POSTER_DIR, `${slot}.svg`);
  if (shouldWrite(posterTarget)) {
    fs.writeFileSync(posterTarget, POSTERS[slot], 'utf8');
    console.log(`write  idle/posters/${slot}.svg`);
  }
}
```

- [ ] **Step 3: Run it**

Run: `node scripts/build-idle-lottie-slots.js`
Expected: ten `write  idle/<slot>.lottie` lines and ten `write  idle/posters/<slot>.svg` lines.

- [ ] **Step 4: Verify the archives and the keep rule**

Run: `for f in src/public/assets/lottie/idle/*.lottie; do unzip -tq "$f" || echo "BAD $f"; done; ls src/public/assets/lottie/idle/posters | wc -l`
Expected: ten lines ending `No errors detected in compressed data of …`, no `BAD` line, and `10`.

Run: `unzip -l src/public/assets/lottie/idle/prices.lottie`
Expected: lists `manifest.json` and `a/prices.json`.

Run: `node scripts/build-idle-lottie-slots.js`
Expected: ten `keep   idle/<slot>.lottie` lines and no `write` lines.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/dotlottie-zip.js scripts/build-idle-lottie-slots.js src/public/assets/lottie/idle
git commit -m "feat(idle): add idle Lottie slot files and posters"
```

---

### Task 11: Idle view and controller

**Files:**

- Create: `src/public/shared/idle/idle-view.ts`
- Create: `src/public/shared/idle/idle-controller.ts`
- Test: `src/public/shared/idle/idle-controller.spec.ts`

**Interfaces:**

- Consumes (Task 7): `renderSlideText`, `statusSummary`, `serviceLabel`, `chipStateLabel`, `IDLE_UI_TEXT`, `IDLE_SERVICE_ORDER`, `IdleLang`, `IdleSlideText`, `IDLE_SLIDES`, `getSlideDef`, `playlistSignature`. (Task 8): `IdleStatusPoller`, `fetchIdleInfo`, `IdleCarousel`. (Task 9): `IdleLottieStage`, `IdleLottiePlayer`, `createDotLottiePlayer`, `fetchLottieAsset`.
- Produces:
  - `idle-view.ts`: `interface IdleViewElements`, `queryIdleViewElements(root: HTMLElement): IdleViewElements | null`, `class IdleView { constructor(els, opts: { reducedMotion: boolean; fadeMs?: number }); showSlide(text, durationMs, onSwap: () => void): void; renderLanguage(lang): void; renderChips(info, lang): void; renderClock(now: Date, lang): void; stop(): void }`
  - `idle-controller.ts`: `interface IdleAttract { start(): void; stop(): void }`, `interface IdleAttractOverrides { fetchInfo?; fetchAsset?; createPlayer?; reducedMotion?: boolean }`, `createIdleAttract(root: HTMLElement, overrides?: IdleAttractOverrides): IdleAttract | null`.
- DOM hooks (used by Task 12 markup): `data-idle="chips"`, chip `li[data-service="print|copy|scan"]` containing `[data-idle="chip-name"]` and `[data-idle="chip-state"]`, `data-idle="clock-time"`, `"clock-date"`, `"slide"`, `"canvas"`, `"poster"`, `"eyebrow"`, `"title"`, `"body"`, `"steps"`, `"status-line"`, `"progress"`, `"cta"`.

- [ ] **Step 1: Write the failing test**

Create `src/public/shared/idle/idle-controller.spec.ts`:

```ts
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
  pricing: {
    printBwFrom: 3,
    printColorFrom: 18,
    copyBw: 3,
    copyColor: 5,
    scan: 5,
  },
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
    document.body.innerHTML = '<div id="x"></div>';
    expect(createIdleAttract(document.getElementById('x')!)).toBeNull();
  });

  it('renders text and Checking… chips before idle info arrives', async () => {
    const { root, attract, text } = setup(
      () => new Promise<IdleInfo>(() => {}),
    );
    attract.start();
    await flush();
    expect(text('title')).toBe('Print, copy, and scan.');
    expect(text('cta')).toBe('Tap anywhere to start');
    const printChip = root.querySelector(
      '[data-service="print"]',
    ) as HTMLElement;
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec jest src/public/shared/idle/idle-controller.spec.ts`
Expected: FAIL with `Cannot find module './idle-controller'`.

- [ ] **Step 3: Write `idle-view.ts`**

Create `src/public/shared/idle/idle-view.ts`:

```ts
import type { IdleInfo } from '@/shared/idle-screen-contract';
import {
  IDLE_SERVICE_ORDER,
  IDLE_UI_TEXT,
  chipStateLabel,
  serviceLabel,
  statusSummary,
  type IdleLang,
  type IdleSlideText,
} from './idle-copy';

export interface IdleViewElements {
  overlay: HTMLElement;
  chips: HTMLElement;
  clockTime: HTMLElement;
  clockDate: HTMLElement;
  slide: HTMLElement;
  canvas: HTMLCanvasElement;
  poster: HTMLImageElement;
  eyebrow: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
  steps: HTMLElement;
  statusLine: HTMLElement;
  progressBar: HTMLElement;
  cta: HTMLElement;
}

export function queryIdleViewElements(
  root: HTMLElement,
): IdleViewElements | null {
  const hook = <T extends Element>(name: string): T | null =>
    root.querySelector<T>(`[data-idle="${name}"]`);
  const els = {
    overlay: root,
    chips: hook<HTMLElement>('chips'),
    clockTime: hook<HTMLElement>('clock-time'),
    clockDate: hook<HTMLElement>('clock-date'),
    slide: hook<HTMLElement>('slide'),
    canvas: hook<HTMLCanvasElement>('canvas'),
    poster: hook<HTMLImageElement>('poster'),
    eyebrow: hook<HTMLElement>('eyebrow'),
    title: hook<HTMLElement>('title'),
    body: hook<HTMLElement>('body'),
    steps: hook<HTMLElement>('steps'),
    statusLine: hook<HTMLElement>('status-line'),
    progressBar: hook<HTMLElement>('progress'),
    cta: hook<HTMLElement>('cta'),
  };
  return Object.values(els).every(Boolean) ? (els as IdleViewElements) : null;
}

export interface IdleViewOptions {
  reducedMotion: boolean;
  fadeMs?: number;
}

/** Owns every DOM write and the short-lived fade and step timers. */
export class IdleView {
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private stepTimer: ReturnType<typeof setInterval> | null = null;
  private lastStateSignature = '';

  constructor(
    private readonly els: IdleViewElements,
    private readonly opts: IdleViewOptions,
  ) {}

  showSlide(text: IdleSlideText, durationMs: number, onSwap: () => void): void {
    this.clearTimers();
    const swap = (): void => {
      this.fadeTimer = null;
      this.writeText(text);
      onSwap();
      this.els.slide.classList.remove('is-fading');
      this.restartProgress(durationMs);
      this.startSteps(text, durationMs);
    };
    if (this.opts.reducedMotion) {
      swap();
      return;
    }
    this.els.slide.classList.add('is-fading');
    this.fadeTimer = setTimeout(swap, this.opts.fadeMs ?? 220);
  }

  renderLanguage(lang: IdleLang): void {
    const ui = IDLE_UI_TEXT[lang];
    this.els.cta.textContent = ui.cta;
    this.els.overlay.setAttribute('aria-label', ui.overlayLabel);
    this.els.chips.setAttribute('aria-label', ui.chipsLabel);
  }

  renderChips(info: IdleInfo | null, lang: IdleLang): void {
    for (const name of IDLE_SERVICE_ORDER) {
      const chip = this.els.chips.querySelector<HTMLElement>(
        `[data-service="${name}"]`,
      );
      if (!chip) continue;
      const state = info ? info.services[name].state : 'unknown';
      chip.dataset.state = state;
      const nameEl = chip.querySelector('[data-idle="chip-name"]');
      const stateEl = chip.querySelector('[data-idle="chip-state"]');
      if (nameEl) nameEl.textContent = serviceLabel(name, lang);
      if (stateEl) stateEl.textContent = chipStateLabel(state, lang);
    }
    // Announce only when a state changes, not on every poll or language swap.
    const signature = info
      ? IDLE_SERVICE_ORDER.map((name) => info.services[name].state).join('|') +
        `|${info.change.exactCoinsOnly}`
      : 'none';
    if (signature !== this.lastStateSignature) {
      this.lastStateSignature = signature;
      this.els.statusLine.textContent = statusSummary(info, lang);
    }
  }

  renderClock(now: Date, lang: IdleLang): void {
    const locale = lang === 'fil' ? 'fil-PH' : 'en-PH';
    this.els.clockTime.textContent = now.toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
    });
    this.els.clockDate.textContent = now.toLocaleDateString(locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }

  stop(): void {
    this.clearTimers();
    this.els.slide.classList.remove('is-fading');
  }

  private writeText(text: IdleSlideText): void {
    this.els.eyebrow.textContent = text.eyebrow;
    this.els.title.textContent = text.title;
    this.els.body.textContent = text.body;
    this.els.steps.dataset.stepped = String(text.stepped);
    this.els.steps.replaceChildren(
      ...text.lines.map((line) => {
        const item = document.createElement('li');
        item.className = 'idle-step';
        item.textContent = line;
        return item;
      }),
    );
  }

  private restartProgress(durationMs: number): void {
    const bar = this.els.progressBar;
    // Inline !important beats the kiosk-static `transition: none !important`.
    bar.style.setProperty('transition', 'none', 'important');
    bar.style.transform = 'scaleX(0)';
    void bar.offsetWidth;
    if (this.opts.reducedMotion) return;
    bar.style.setProperty(
      'transition',
      `transform ${durationMs}ms linear`,
      'important',
    );
    bar.style.transform = 'scaleX(1)';
  }

  private startSteps(text: IdleSlideText, durationMs: number): void {
    if (!text.stepped) return;
    const items = Array.from(this.els.steps.children);
    if (items.length === 0) return;
    let index = 0;
    items[0].classList.add('is-current');
    this.stepTimer = setInterval(
      () => {
        items[index].classList.remove('is-current');
        index = (index + 1) % items.length;
        items[index].classList.add('is-current');
      },
      Math.max(1000, Math.floor(durationMs / items.length)),
    );
  }

  private clearTimers(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    if (this.stepTimer !== null) {
      clearInterval(this.stepTimer);
      this.stepTimer = null;
    }
  }
}
```

- [ ] **Step 4: Write `idle-controller.ts`**

Create `src/public/shared/idle/idle-controller.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec jest src/public/shared/idle`
Expected: PASS for every idle spec.

- [ ] **Step 6: Commit**

```bash
git add src/public/shared/idle/idle-view.ts src/public/shared/idle/idle-controller.ts src/public/shared/idle/idle-controller.spec.ts
git commit -m "feat(idle): wire idle view, poller, carousel, and Lottie stage"
```

---

### Task 12: New markup, stylesheet, and wiring

**Files:**

- Modify: `src/public/index.html` (replace the idle overlay block, currently lines 1132–2265)
- Replace: `src/public/idle-screen.css` (whole file)
- Modify: `src/public/globals.css` (remove the attractor override block, currently lines 685–746)
- Modify: `src/public/app.ts` (`initIdleScreen` call near line 109)

**Interfaces:**

- Consumes (Task 11): `createIdleAttract`, the `data-idle` hooks. (Task 6): `data-i18n-skip`. Existing `initIdleScreen` from `src/public/shared/idle-screen.ts` (unchanged).
- Produces: the shipped idle screen.

- [ ] **Step 1: Replace the overlay markup**

In `src/public/index.html`, replace everything from the line
`    <!-- ── Idle / Attractor Screen Overlay ──────────────────────────────── -->`
through the line `    <!-- /idle-overlay -->` (inclusive) with:

```html
<!-- ── Idle / Attractor Screen Overlay ──────────────────────────────── -->
<!--
      Shown after the homepage idle timeout and right after boot.
      shared/idle-screen.ts toggles .is-visible / .is-leaving.
      shared/idle/idle-controller.ts fills slides, chips, and clock.
      data-i18n-skip: idle text alternates English and Filipino per cycle,
      so the kiosk-wide translator leaves this subtree alone.
    -->
<div
  class="idle-overlay"
  id="idleOverlay"
  role="dialog"
  aria-hidden="true"
  aria-modal="false"
  aria-label="PrintBit kiosk is idle. Tap anywhere to start."
  data-i18n-skip
>
  <div class="idle-frame">
    <div class="idle-header">
      <div class="idle-brand" aria-label="PrintBit">
        <span class="idle-brand__mark" aria-hidden="true"></span>
        <span class="idle-brand__name">PrintBit</span>
      </div>
      <ul class="idle-chips" data-idle="chips" aria-label="Service status">
        <li class="idle-chip" data-service="print" data-state="unknown">
          <span class="idle-chip__name" data-idle="chip-name">Print</span>
          <span class="idle-chip__state" data-idle="chip-state">Checking…</span>
        </li>
        <li class="idle-chip" data-service="copy" data-state="unknown">
          <span class="idle-chip__name" data-idle="chip-name">Copy</span>
          <span class="idle-chip__state" data-idle="chip-state">Checking…</span>
        </li>
        <li class="idle-chip" data-service="scan" data-state="unknown">
          <span class="idle-chip__name" data-idle="chip-name">Scan</span>
          <span class="idle-chip__state" data-idle="chip-state">Checking…</span>
        </li>
      </ul>
      <div class="idle-clock" aria-hidden="true">
        <span class="idle-clock__time" data-idle="clock-time"></span>
        <span class="idle-clock__date" data-idle="clock-date"></span>
      </div>
    </div>

    <div class="idle-slide" data-idle="slide">
      <div class="idle-slide__art">
        <img class="idle-slide__poster" data-idle="poster" alt="" hidden />
        <canvas
          class="idle-slide__canvas"
          data-idle="canvas"
          aria-hidden="true"
          hidden
        ></canvas>
      </div>
      <div class="idle-slide__text">
        <p class="idle-slide__eyebrow" data-idle="eyebrow"></p>
        <h2 class="idle-slide__title" data-idle="title"></h2>
        <p class="idle-slide__body" data-idle="body"></p>
        <ol class="idle-slide__steps" data-idle="steps"></ol>
      </div>
    </div>

    <p class="idle-sr-only" data-idle="status-line" aria-live="polite"></p>

    <div class="idle-footer">
      <div class="idle-progress" aria-hidden="true">
        <span class="idle-progress__bar" data-idle="progress"></span>
      </div>
      <p class="idle-cta" data-idle="cta">Tap anywhere to start</p>
    </div>
  </div>
</div>
<!-- /idle-overlay -->
```

- [ ] **Step 2: Replace the stylesheet**

Overwrite `src/public/idle-screen.css` with:

```css
/* ═══════════════════════════════════════════════════════════════════════════
   IDLE / ATTRACT SCREEN
   ───────────────────────────────────────────────────────────────────────────
   No @keyframes. Motion comes from one Lottie canvas (stepped at 30 Hz by
   shared/idle/idle-lottie.ts) and opacity/transform transitions only.

   globals.css turns every transition off under html[data-kiosk-static='true']
   with `transition: none !important` (specificity 0,1,1). The idle rules that
   must animate repeat their transition with !important at specificity 0,2,1
   or higher in the "Kiosk static mode" section below.
   ═══════════════════════════════════════════════════════════════════════════ */

.idle-overlay {
  --idle-primary: #696fc7;
  --idle-lavender: #a7aae1;
  --idle-pink: #f2aebb;
  --idle-peach: #f5d3c4;
  --idle-mint: #8de5bc;
  --idle-text: #ffffff;
  --idle-muted: #c9c9dc;
  --idle-soft: #a6a5b9;
  --idle-fade-ms: 220ms;

  position: fixed;
  inset: 0;
  z-index: 9000;
  background:
    radial-gradient(
      ellipse at 20% 5%,
      rgba(105, 111, 199, 0.3),
      transparent 58%
    ),
    radial-gradient(
      ellipse at 82% 92%,
      rgba(242, 174, 187, 0.16),
      transparent 52%
    ),
    linear-gradient(165deg, #0e0d1f 0%, #100f22 45%, #0a0918 100%);
  color: var(--idle-text);
  font-family:
    'Plus Jakarta Sans',
    system-ui,
    -apple-system,
    'Segoe UI',
    sans-serif;
  font-synthesis: none;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition:
    opacity 600ms cubic-bezier(0.16, 1, 0.3, 1),
    visibility 0s linear 600ms;
}

.idle-overlay.is-visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transition:
    opacity 600ms cubic-bezier(0.16, 1, 0.3, 1),
    visibility 0s;
}

.idle-overlay.is-leaving {
  opacity: 0;
  visibility: visible;
  pointer-events: none;
  transition: opacity 260ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* Boot flow (/?idle=boot): cover the homepage before the first paint. */
html.kiosk-boot-idle .idle-overlay {
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: auto !important;
  transition: none !important;
}

html.kiosk-boot-idle .kiosk-shell {
  pointer-events: none !important;
}

/* ── Frame ─────────────────────────────────────────────────────────────── */
.idle-frame {
  box-sizing: border-box;
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: clamp(16px, 3vh, 36px);
  padding: clamp(24px, 4vh, 48px) clamp(24px, 5vw, 72px);
}

.idle-header {
  display: flex;
  align-items: center;
  gap: 24px;
}

.idle-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  font-weight: 800;
  font-size: clamp(22px, 2.2vw, 32px);
}

.idle-brand__mark {
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: linear-gradient(145deg, var(--idle-primary), var(--idle-pink));
}

/* ── Service chips ─────────────────────────────────────────────────────── */
.idle-chips {
  display: flex;
  gap: 12px;
  margin: 0 0 0 auto;
  padding: 0;
  list-style: none;
}

.idle-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border: 1px solid rgba(167, 170, 225, 0.3);
  border-radius: 999px;
  background: rgba(105, 111, 199, 0.12);
  font-size: clamp(14px, 1.2vw, 18px);
}

.idle-chip__name {
  font-weight: 700;
}

.idle-chip__state {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--idle-muted);
}

.idle-chip__state::before {
  content: '';
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--idle-chip-dot, var(--idle-soft));
}

.idle-chip[data-state='ready'] {
  --idle-chip-dot: var(--idle-mint);
}

.idle-chip[data-state='limited'] {
  --idle-chip-dot: var(--idle-peach);
  border-color: rgba(245, 211, 196, 0.6);
}

.idle-chip[data-state='unavailable'] {
  --idle-chip-dot: var(--idle-pink);
  border-color: rgba(242, 174, 187, 0.7);
  background: rgba(242, 174, 187, 0.14);
}

/* ── Clock ─────────────────────────────────────────────────────────────── */
.idle-clock {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  margin-left: 12px;
}

.idle-clock__time {
  font-size: clamp(22px, 2vw, 30px);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.idle-clock__date {
  font-size: clamp(13px, 1vw, 16px);
  color: var(--idle-soft);
}

/* ── Slide ─────────────────────────────────────────────────────────────── */
.idle-slide {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  align-items: center;
  gap: clamp(24px, 4vw, 72px);
  min-height: 0;
}

.idle-slide__art {
  position: relative;
  justify-self: center;
  width: 100%;
  max-width: 560px;
  max-height: 100%;
  aspect-ratio: 1;
}

.idle-slide__canvas,
.idle-slide__poster {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.idle-slide__art,
.idle-slide__text {
  transition: opacity var(--idle-fade-ms) ease;
}

.idle-slide.is-fading .idle-slide__art,
.idle-slide.is-fading .idle-slide__text {
  opacity: 0;
}

.idle-slide__text {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.idle-slide__eyebrow {
  margin: 0;
  color: var(--idle-lavender);
  font-size: clamp(14px, 1.2vw, 18px);
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.idle-slide__title {
  margin: 0;
  font-size: clamp(36px, 4.6vw, 72px);
  font-weight: 800;
  line-height: 1.05;
}

.idle-slide__body {
  margin: 0;
  max-width: 34ch;
  color: var(--idle-muted);
  font-size: clamp(18px, 1.7vw, 26px);
  line-height: 1.45;
}

.idle-slide__body:empty,
.idle-slide__steps:empty {
  display: none;
}

.idle-slide__steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: idle-step;
}

.idle-step {
  display: flex;
  align-items: baseline;
  gap: 14px;
  color: var(--idle-muted);
  font-size: clamp(18px, 1.7vw, 26px);
  line-height: 1.35;
}

.idle-slide__steps[data-stepped='true'] .idle-step {
  opacity: 0.55;
  transition:
    color 300ms ease,
    opacity 300ms ease;
}

.idle-slide__steps[data-stepped='true'] .idle-step::before {
  counter-increment: idle-step;
  content: counter(idle-step);
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 1.6em;
  height: 1.6em;
  border-radius: 50%;
  background: rgba(105, 111, 199, 0.25);
  color: var(--idle-text);
  font-size: 0.85em;
  font-weight: 800;
}

.idle-slide__steps[data-stepped='true'] .idle-step.is-current {
  opacity: 1;
  color: var(--idle-text);
}

.idle-slide__steps[data-stepped='true'] .idle-step.is-current::before {
  background: var(--idle-primary);
}

/* ── Footer ────────────────────────────────────────────────────────────── */
.idle-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.idle-progress {
  width: min(560px, 60vw);
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(167, 170, 225, 0.2);
}

.idle-progress__bar {
  display: block;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, var(--idle-primary), var(--idle-pink));
  transform: scaleX(0);
  transform-origin: left center;
}

.idle-cta {
  margin: 0;
  padding: 14px 32px;
  border: 1px solid rgba(167, 170, 225, 0.45);
  border-radius: 999px;
  background: rgba(105, 111, 199, 0.18);
  font-size: clamp(18px, 1.6vw, 24px);
  font-weight: 700;
}

.idle-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ── Kiosk static mode: re-enable only the idle transitions ───────────── */
html[data-kiosk-static='true'] .idle-overlay {
  transition:
    opacity 600ms cubic-bezier(0.16, 1, 0.3, 1),
    visibility 0s linear 600ms !important;
}

html[data-kiosk-static='true'] .idle-overlay.is-visible {
  transition:
    opacity 600ms cubic-bezier(0.16, 1, 0.3, 1),
    visibility 0s !important;
}

html[data-kiosk-static='true'] .idle-overlay.is-leaving {
  transition: opacity 260ms cubic-bezier(0.4, 0, 0.2, 1) !important;
}

html[data-kiosk-static='true'] .idle-overlay .idle-slide__art,
html[data-kiosk-static='true'] .idle-overlay .idle-slide__text {
  transition: opacity var(--idle-fade-ms) ease !important;
}

html[data-kiosk-static='true']
  .idle-overlay
  .idle-slide__steps[data-stepped='true']
  .idle-step {
  transition:
    color 300ms ease,
    opacity 300ms ease !important;
}

/* ── High contrast ─────────────────────────────────────────────────────── */
html[data-high-contrast='true'] .idle-overlay {
  background: #000000;
}

html[data-high-contrast='true'] .idle-slide__body,
html[data-high-contrast='true'] .idle-step,
html[data-high-contrast='true'] .idle-chip__state {
  color: #ffffff;
  opacity: 1;
}

html[data-high-contrast='true'] .idle-chip,
html[data-high-contrast='true'] .idle-cta {
  border-color: #ffffff;
  background: transparent;
}

/* ── Reduced motion (after the static-mode rules so it wins on ties) ───── */
@media (prefers-reduced-motion: reduce) {
  html .idle-overlay,
  html .idle-overlay.is-visible,
  html .idle-overlay.is-leaving,
  html .idle-overlay .idle-slide__art,
  html .idle-overlay .idle-slide__text,
  html[data-kiosk-static='true'] .idle-overlay,
  html[data-kiosk-static='true'] .idle-overlay.is-visible,
  html[data-kiosk-static='true'] .idle-overlay.is-leaving,
  html[data-kiosk-static='true'] .idle-overlay .idle-slide__art,
  html[data-kiosk-static='true'] .idle-overlay .idle-slide__text,
  html[data-kiosk-static='true']
    .idle-overlay
    .idle-slide__steps[data-stepped='true']
    .idle-step {
    transition: none !important;
  }

  .idle-progress {
    visibility: hidden;
  }
}
```

- [ ] **Step 3: Remove the old attractor overrides from `globals.css`**

In `src/public/globals.css`, delete everything from the line
`/* Attractor / idle-screen overlay — re-enable its animations in kiosk mode */`
up to, but not including, the line
`/* Idle timeout overlay — re-enable its fade & blur animations in kiosk mode */`.
The deleted rules target `.idle-overlay`, `.idle-content`, `.idle-backdrop`,
`.idle-rings`, `.idle-blob--*`, `.idle-ring*`, `.idle-cta`, and
`.idle-cta__pulse`. Keep every `.idle-warning-*` rule.

Run: `grep -n "idle-blob\|idle-ring\|idle-content\|idle-cta" src/public/globals.css`
Expected: no output.

- [ ] **Step 4: Wire the controller in `app.ts`**

In `src/public/app.ts`, add to the imports:

```ts
import {
  createIdleAttract,
  type IdleAttract,
} from './shared/idle/idle-controller';
```

Replace:

```ts
initIdleScreen({
  overlayId: 'idleOverlay',
  activateImmediately: idleBootFlag,
  onShow: () => syncFabVisibility(),
  onHide: () => syncFabVisibility(),
});
```

with:

```ts
// The attract controller is created on first show, after DOMContentLoaded,
// so the overlay markup is guaranteed to exist.
let idleAttract: IdleAttract | null = null;

initIdleScreen({
  overlayId: 'idleOverlay',
  activateImmediately: idleBootFlag,
  onShow: () => {
    syncFabVisibility();
    if (!idleAttract) {
      const overlay = document.getElementById('idleOverlay');
      idleAttract = overlay ? createIdleAttract(overlay) : null;
    }
    idleAttract?.start();
  },
  onHide: () => {
    idleAttract?.stop();
    syncFabVisibility();
  },
});
```

- [ ] **Step 5: Check, test, and build**

Run: `grep -c "@keyframes" src/public/idle-screen.css`
Expected: `0`.

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: exit 0.

Run: `pnpm exec jest src/public src/shared src/modules/page`
Expected: PASS.

Run: `pnpm build`
Expected: ends with `Build completed successfully.`

- [ ] **Step 6: Commit**

```bash
git add src/public/index.html src/public/idle-screen.css src/public/globals.css src/public/app.ts
git commit -m "feat(idle): ship the Lottie idle carousel on the homepage"
```

Then check `git status`. If `pnpm build` changed tracked bundles
(`git ls-files src/public/bundle.js` prints the path), stage and commit those
bundles in a separate commit: `git commit -m "build: rebuild client bundles for idle screen"`.
Never stage the unrelated files listed in Global Constraints.

---

### Task 13: Verify on the kiosk and refresh the graph

**Files:**

- No source changes expected. If a check fails, fix it in the task that owns the code, then re-run this task.

- [ ] **Step 1: Full automated gate**

Run: `pnpm exec jest`
Expected: all suites pass.

Run: `pnpm lint`
Expected: no errors.

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 2: Manual run (Review Focus items 1, 2, 4)**

Run `pnpm dev`. On the kiosk browser:

1. Open `/?idle=boot`. Expected: the idle screen covers the homepage at once.
   The welcome slide shows, with chips reading "Checking…" until data arrives
   and then real states.
2. Watch one full cycle (10 slides × 8 s). Expected: each slide fades out and
   in, the progress bar fills over the slide, how-to steps highlight in turn,
   and the second cycle is in Filipino.
3. Tap anywhere. Expected: the overlay fades out in about 0.26 s and the tap
   does not press any homepage button.
4. Wait for the idle timeout. Expected: the overlay fades back in and starts
   again at the welcome slide.

- [ ] **Step 3: Degraded states (manual)**

From the admin pages, simulate a printer paper-out (the existing printer
simulation, `/api/printer/simulation-status` feature) and wait up to 30 s with
the idle screen showing. Expected: Print and Copy chips read "Unavailable",
the status slide leads and repeats, and the how-to-print, supported-files,
how-to-copy, and ID-copy slides are skipped. Clear the simulation. Expected:
within 30 s the chips return to "Ready".

Set `consumablesForecasting.enabled` on and `paperCurrentSheets` to 0 in admin.
Expected: Print and Copy read "Limited" (never "Unavailable") and the status
slide says "paper is running low". Restore the real sheet count afterwards.

- [ ] **Step 4: Performance budget**

In Chrome DevTools on the kiosk PC, record 60 s of Performance with the idle
screen showing, once on the base commit (`git stash` is not needed: use a
second checkout or the previous build) and once on this branch. Expected on
this branch: in the Animations panel, no running CSS animations; in the
Performance recording, one 30 Hz timer driving canvas draws and no
`requestAnimationFrame` playback loop from the player. Write down main-thread
CPU % for both builds for the PR description.

- [ ] **Step 5: Refresh the knowledge graph**

Run: `graphify update .`
Expected: the command finishes without errors. Do not commit `graphify-out/`
unless it was already tracked (`git ls-files graphify-out | head -1` prints a path).

- [ ] **Step 6: Report**

Summarize for the human partner: test, lint, and typecheck results; the manual
checks done and any that could not be done; the two CPU numbers. Note that
`welcome` and `privacyReceipt` still use placeholder animations until free
LottieFiles assets are dropped into `src/public/assets/lottie/idle/`.
