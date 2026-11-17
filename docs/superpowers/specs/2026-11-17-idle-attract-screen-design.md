# Homepage idle screen: informative carousel on Lottie

Date: 2026-11-17
Branch: new branch from `main` (not `feat/id-card-copy`)
Scope: `src/public/index.html`, `src/public/idle-screen.css`,
`src/public/shared/idle-screen.ts`, new `src/public/shared/idle/`,
`src/public/assets/lottie/idle/`, `src/modules/page/`,
`src/core/database/` (settings), `src/modules/admin/` (settings validation),
`src/public/admin/` (settings UI), `src/locales/en`, `src/locales/fil`

## Goal

When nobody uses the kiosk, the homepage idle screen should tell a passer-by
three things: what the kiosk does, how to use it, and whether it works right
now and at what price. Today the screen only cycles three marketing lines over
a hand-built SVG machine.

At the same time the idle screen must cost less to run. Today it runs about 30
infinite CSS animations at once (41 `@keyframes`, `box-shadow` keyframes,
drifting blobs, SVG part animations) from a 47 KB stylesheet and a ~1,100-line
inline SVG.

Success:

- A passer-by can tell from a distance which services are ready and what they
  cost, and how to start each one.
- While the idle screen shows, at most one animation render loop runs.
- Operators can turn slides on or off and set slide duration from the admin
  page.

## Decisions

| Topic               | Decision                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Content             | A rotating carousel that mixes how-to slides with live status and price slides.                             |
| Animation runtime   | `@lottiefiles/dotlottie-web` (already a dependency). One shared player for the whole screen.               |
| Lottie assets       | Mixed. First version reuses `src/public/assets/lottie/` files and free LottieFiles assets recolored to the palette. Each slide has a fixed slot path, so a custom file replaces it with no code change. |
| Content control     | Admin toggles per slide and one slide duration. Slide text lives in code and locale files.                 |
| Degraded hardware   | Honest. A status slide says each service is Ready, Limited, or Unavailable, in plain words. How-to slides for an Unavailable service are skipped. |
| Ambient background  | Static gradient. No animation.                                                                             |
| Slide transitions   | CSS `opacity` transitions only (compositor). No CSS `@keyframes` anywhere in the idle screen.               |
| Language            | Each full cycle alternates English and Filipino. The idle screen does not change the kiosk's selected language. |

## Non-goals

- Admin-written announcement slides. A later spec can add them.
- Commissioning custom Lottie files. The slot paths make that a later file drop.
- Any change on mobile viewports. `initIdleScreen` stays disabled there.
- Changes to the idle timeout or the tap-to-dismiss behavior.

## Screen

The overlay keeps its id `idleOverlay` and its show/hide contract. Inside it:

- **Header (persistent):** PrintBit brand, clock and date (text updated once a
  minute), and three service chips: Print, Copy, Scan. Each chip shows its
  state with color and a word, never color alone. The words are Ready,
  Limited, Unavailable, and Checking… (for `unknown` or no data yet).
- **Slide area:** one Lottie canvas on the left, slide text on the right.
  Only the text and the canvas content change between slides.
- **Footer (persistent):** "Tap anywhere to start" and a slide progress bar.
  The bar is one element animated with a `transform: scaleX()` CSS transition
  over the slide duration. It resets without transition on each slide change.

The background is the current deep-space gradient, static.

### Slide catalog

| Slide id         | Content                                                                                       | Depends on service | Can disable | Slot file                     | First-version source      |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------ | ----------- | ----------------------------- | ------------------------- |
| `welcome`        | "Print, Copy, Scan — coins and your phone."                                                  | none               | no          | `idle/welcome.lottie`         | free LottieFiles asset    |
| `status`         | Each service with state and reason. Paper level. "Exact coins only" when change is unavailable. | none               | no          | `idle/status.lottie`          | `paper-tray.lottie`       |
| `howToPrint`     | 4 steps: scan the QR, upload from phone, choose settings, insert coins.                      | print              | yes         | `idle/how-to-print.lottie`    | `upload.lottie`           |
| `howToCopy`      | Place on the glass or in the feeder, set copies, pay.                                        | copy               | yes         | `idle/how-to-copy.lottie`     | `copy-glass.lottie`       |
| `idCardCopy`     | Front and back of an ID on one sheet.                                                        | copy               | yes         | `idle/id-card-copy.lottie`    | `copy-adf.lottie`         |
| `scanToPhone`    | Scan, scan the QR, the file goes to your phone.                                              | scan               | yes         | `idle/scan-to-phone.lottie`   | `scan-transfer.lottie`    |
| `prices`         | Live prices: B/W per page, color surcharge, copy per page, scan per document.                | none               | yes         | `idle/prices.lottie`          | `coin-insertion.lottie`   |
| `paying`         | Accepted coins ₱1, ₱5, ₱10, ₱20. Whole pesos. Change is returned.                            | none               | yes         | `idle/paying.lottie`          | `coin-insertion.lottie`   |
| `supportedFiles` | PDF, Word, PowerPoint, Excel, images, and the upload size limit.                             | print              | yes         | `idle/supported-files.lottie` | `upload.lottie`           |
| `privacyReceipt` | Files are deleted after the job. You get an e-receipt on your phone.                         | none               | yes         | `idle/privacy-receipt.lottie` | free LottieFiles asset    |

Slot files live in `src/public/assets/lottie/idle/`. The first version copies
the listed source file into each slot. Each slide also has a static poster in
`src/public/assets/lottie/idle/posters/<slot-name>.svg`, used when the Lottie
cannot render.

Step lists are static text. The current step is shown by moving an `is-current`
class from step to step on a timer inside the slide. The class changes `color`
and `opacity` with a CSS transition.

The `paying` slide reads the accepted coin values and the `supportedFiles` slide
reads the size limit from the same sources the kiosk uses today. The plan names
the exact constants.

### Playlist rules

`buildPlaylist(info, enabledSlides, cycleIndex)` returns the ordered slides for
one cycle and the language for that cycle.

1. Start from the catalog order.
2. Remove slides the admin disabled. `welcome` and `status` cannot be disabled.
3. Remove a slide when its service is `unavailable`.
4. Remove `prices` when no pricing data has been received yet.
5. When any service is `limited` or `unavailable`, or `exactCoinsOnly` is true,
   the screen is degraded:
   - `status` moves to the first position.
   - `status` is inserted again after every two other slides.
6. Language: `en` when `cycleIndex` is even, `fil` when odd.
7. The result is never empty: `welcome` and `status` always remain.

## Architecture

```
GET /api/idle/info ──► idle-status.ts ──► buildPlaylist() ──► idle-carousel.ts
                                                                  │
                                         idle-lottie.ts ◄─────────┘
                                         (one DotLottie, canvas)
```

### Server units

- **Route `GET /api/idle/info`** in `src/modules/page/page.controller.ts`, next
  to `/api/settings/idle-timeout`. Public and read-only. It returns no secrets,
  error text, device names, or telemetry beyond the fields below.
- **`deriveIdleServices(sources)`**, a pure function in `src/modules/page/`.
  It maps raw sources to service states. Each source is read inside its own
  `try`. A source that throws yields `unknown` for the services that need it;
  the route never returns 500 because of one source.
- **Settings:** `idleScreen` on the admin settings model.

Response shape:

```json
{
  "settings": {
    "slideDurationSeconds": 8,
    "slides": {
      "howToPrint": true,
      "howToCopy": true,
      "idCardCopy": true,
      "scanToPhone": true,
      "prices": true,
      "paying": true,
      "supportedFiles": true,
      "privacyReceipt": true
    }
  },
  "pricing": {
    "printPerPage": 2,
    "colorSurcharge": 3,
    "copyPerPage": 2,
    "scanDocument": 5
  },
  "services": {
    "print": { "state": "ready", "reason": null },
    "copy": { "state": "limited", "reason": "paper_low" },
    "scan": { "state": "ready", "reason": null }
  },
  "paper": { "level": "low" },
  "change": { "exactCoinsOnly": false }
}
```

`state` is one of `ready`, `limited`, `unavailable`, `unknown`.
`reason` is one of `null`, `printer_offline`, `printer_error`, `paper_out`,
`paper_low`, `scanner_unavailable`.
`paper.level` is one of `ok`, `low`, `out`, `unknown`.

### Derivation rules

Sources: the printer state projection snapshot
(`src/services/printer-state-projection.ts`), `ScannerService.getStatus()`,
the hopper's last error code (`src/services/hopper.ts`), settings
`consumablesForecasting`, and settings pricing.

| Condition                                                              | Effect                                  |
| ---------------------------------------------------------------------- | --------------------------------------- |
| Printer offline                                                        | print, copy: `unavailable`, `printer_offline` |
| Printer has an active error other than paper                           | print, copy: `unavailable`, `printer_error`   |
| Printer reports paper out, or `paperCurrentSheets` is 0                | print, copy: `unavailable`, `paper_out`; paper `out` |
| `paperCurrentSheets` ≤ max(10, 10% of `paperTrayCapacitySheets`)       | print, copy: `limited`, `paper_low`; paper `low` |
| Forecasting disabled and printer reports no paper state               | paper `unknown`                         |
| Scanner not ready                                                      | scan, copy: `unavailable`, `scanner_unavailable` |
| Hopper last error is `EMPTY`                                           | `exactCoinsOnly: true`                  |

When several rules hit one service, the worst state wins
(`unavailable` > `limited` > `unknown` > `ready`). For equal states, the first
matching row in the table gives the reason.

### Settings

New field on the admin settings model and in `db.ts` defaults:

```ts
idleScreen: {
  slideDurationSeconds: number; // default 8
  slides: Record<DisableableSlideId, boolean>; // default all true
}
```

`PUT /api/admin/settings` accepts a partial `idleScreen`. Validation:

- `slideDurationSeconds` is an integer from 5 to 20.
- `slides` keys must be disableable slide ids. Unknown keys return 400.
- Values must be booleans.

The admin settings page gets an "Idle screen" section next to the idle timeout
field: one switch per disableable slide and a number input for duration.

### Client units (`src/public/shared/idle/`)

- **`idle-screen.ts`** (moves from `shared/`): keeps the timer, server timeout,
  boot flag, and tap-to-dismiss logic. Its `onShow` starts the status poller and
  the carousel. Its `onHide` stops both and pauses the player.
- **`idle-slides.ts`**: the slide catalog (id, i18n keys, slot path, poster
  path, service dependency, disableable flag) and the pure `buildPlaylist`.
- **`idle-carousel.ts`**: runs the playlist with a single `setTimeout` chain.
  On each step it fades the slide area out, swaps text and animation, fades in,
  and restarts the progress bar. `start()` and `stop()`; `stop()` clears every
  timer it owns.
- **`idle-lottie.ts`**: owns one `DotLottie` instance on one canvas.
  - Calls `DotLottie.setWasmUrl('/vendor/dotlottie/dotlottie-player.wasm')`.
  - On first show, fetches every slot file in the playlist once and keeps the
    `ArrayBuffer`s for the page's lifetime.
  - Swaps with `load({ data, loop: true, autoplay: true, useFrameInterpolation: false, renderConfig: { devicePixelRatio: 1, freezeOnOffscreen: true, autoResize: true } })`.
    `useFrameInterpolation: false` limits rendering to the file's own frame
    rate. Slot files must be authored at 30 fps or less.
  - Pauses on `document.visibilitychange` to hidden and on overlay hide.
  - Shows the slide's poster on `loadError` or `renderError`.
- **`idle-status.ts`**: fetches `/api/idle/info` when the overlay shows, then
  every 30 s while it stays visible. No requests while the overlay is hidden.
  Exposes the last good response.
- **`idle-i18n.ts`**: looks up `idle.*` keys in the `en` or `fil` dictionary
  for the cycle's language. Prices use the existing peso formatter.

### Removed

- The inline SVG machine, rings, blobs, and sparks in `src/public/index.html`
  (the `idleOverlay` block, currently lines 1132–2265), replaced by the new
  markup.
- Every `@keyframes` rule and animation declaration in
  `src/public/idle-screen.css`, and the reduced-motion and `globals.css`
  override blocks that existed only to fight them.

## Failure handling

| Failure                                       | Behavior                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| WASM fails to load                            | Every slide shows its poster. The carousel keeps running.                                       |
| One slot file is missing or invalid           | That slide shows its poster.                                                                    |
| 3 Lottie load failures in a row               | The player is destroyed for this page load. Posters only.                                       |
| Poster also missing                           | The animation area stays empty. Slide text still shows.                                          |
| `/api/idle/info` fails after an earlier success | Keep the last good response.                                                                 |
| `/api/idle/info` has never succeeded          | Chips read "Checking…". `prices` is skipped. The how-to slides still show.                      |
| A server source throws                        | That source's services are `unknown`. The route still returns 200.                              |
| Tap during a crossfade                        | Existing dismiss wins. Carousel stops, player pauses, polling stops.                            |

## Performance budget

Acceptance criteria, checked on the kiosk PC:

- While idle shows: at most one `requestAnimationFrame` loop (the player),
  zero running CSS `@keyframes` animations, zero `box-shadow` or `filter`
  transitions.
- After idle hides: zero timers left by the carousel or poller, and the player
  is paused.
- A Chrome DevTools Performance recording of 60 s idle on the current build and
  on the new build. The PR states main-thread CPU for both.

## Accessibility

- The canvas has `aria-hidden="true"`. All slide text is real DOM text.
- The status line uses `aria-live="polite"` and updates only when a service
  state changes, not on every poll.
- Service chips show a word with the color.
- `prefers-reduced-motion: reduce`: the player loads each slide paused on a
  fixed frame, and slide changes swap instantly with no fade.

## Testing

Jest, following the repo's `*.spec.ts` pattern.

- `deriveIdleServices`: all ready; printer offline; printer error; paper out by
  printer; paper out by count; paper low; forecasting disabled; scanner not
  ready; hopper empty; one source throws; several rules on one service.
- `buildPlaylist`: all on; slides disabled; `welcome` and `status` cannot be
  disabled; unavailable service skips its slides; degraded moves and repeats
  `status`; no pricing skips `prices`; language alternates by cycle; everything
  disabled still yields `welcome` and `status`.
- Settings validation: duration below 5, above 20, non-integer; unknown slide
  id; non-boolean value; defaults applied when `idleScreen` is absent.
- Route: response shape; no extra fields; 200 when a source throws.
- `idle-carousel` and `idle-status` with fake timers: start on show, stop on
  hide, no timers left after stop, no requests while hidden.
- `idle-lottie` with `DotLottie` mocked: one instance only; poster on
  `loadError`; destroyed after 3 failures in a row; pause on hidden.
- Manual: real rendering of each slot file on kiosk hardware, both languages,
  and a degraded state forced from the admin page.
