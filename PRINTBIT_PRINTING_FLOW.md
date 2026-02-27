# Plan: Silent Printing with Config Settings & Confirmation Dialog

## Problem

- `src/services/printer.ts` uses `exec('print "filePath"')` which may open an OS print dialog and does NOT apply any print settings (color, copies, orientation, paper size).
- `node-thermal-printer` is imported but unused — it only works with ESC/POS thermal printers, not regular document printers. **It should be removed.**
- The "Confirm & Print" button on `/confirm` sends the print request immediately with no user confirmation dialog.
- Print settings from `/config` (colorMode, copies, orientation, paperSize) are only partially passed to the backend — **orientation and paperSize are missing** from the `POST /api/confirm-payment` payload.

## Approach

Replace the current `exec('print')` approach with **SumatraPDF CLI** for silent, dialog-free document printing with full settings control. Add a **confirmation modal overlay** on the confirm page before dispatching the print job.

### Why SumatraPDF?

- Free, lightweight, portable (no installer needed — just a single `.exe`)
- Supports silent printing: `-print-to-default` flag
- Supports copies, orientation, paper size, color/mono via print settings flags
- Works with PDF, images, EPUB, MOBI, XPS, DjVu, CBZ, CBR
- No print dialog shown to the user

### Key Decisions

- **Printer target**: OS default printer (no admin config for printer name)
- **Confirmation UX**: Modal overlay on `/confirm` page with file/settings summary
- **node-thermal-printer**: Will be removed from `printer.ts` imports (unused, wrong printer type)
- **SumatraPDF binary**: Bundled in project (e.g. `bin/SumatraPDF.exe`) or expected to be on PATH

---

## Todos

### 1. `install-sumatra` — Set up SumatraPDF binary

- Download SumatraPDF portable `.exe` and place in `bin/` folder at project root
- Add `bin/` to `.gitignore` (or check in the small portable exe)
- Document the setup step in README or PRINTBIT_NOTES.txt

### 2. `rewrite-printer-service` — Rewrite `src/services/printer.ts`

- Remove `node-thermal-printer` import (it's for thermal printers, not document printers)
- Remove the bare `exec('print "..."')` call
- Create a new `PrintJobOptions` interface with: `copies`, `colorMode`, `orientation`, `paperSize`
- Implement `printFile(filename: string, options: PrintJobOptions)` that:
  - Resolves the file path from `uploads/`
  - Builds a SumatraPDF CLI command:

    ```text
    SumatraPDF.exe -print-to-default -print-settings "<settings>" "<filePath>"
    ```

  - Maps settings: copies → `<N>x`, color → `color` or `monochrome`, orientation → `landscape` or `portrait`, paper size → `paper=A4`/`Letter`/`Legal`
  - Executes silently via `child_process.execFile` (no shell, no dialog)
  - Returns a Promise that resolves on success or rejects on failure
- Depends on: `install-sumatra`

### 3. `pass-all-settings-backend` — Send orientation & paperSize to backend

- In `src/public/confirm/app.ts`, update the `POST /api/confirm-payment` body to include `orientation` and `paperSize` from the stored config
- In `src/routes/financial-routes.ts`, parse `orientation` and `paperSize` from the request body
- Pass the full settings object to `printFile()`
- Depends on: `rewrite-printer-service`

### 4. `add-confirmation-modal` — Add confirmation modal overlay on `/confirm`

- In `src/public/confirm/index.html`, add a modal overlay element (hidden by default) with:
  - Title: "Confirm your print job"
  - Summary of: file name, mode, color, copies, orientation, paper size, total price
  - Two buttons: "Cancel" (closes modal) and "Yes, Print" (dispatches the print request)
- In `src/public/confirm/app.ts`:
  - When "Confirm & Print" button is clicked, show the modal instead of immediately sending the request
  - "Yes, Print" button handler sends the existing `POST /api/confirm-payment` request
  - "Cancel" button hides the modal and re-enables the confirm button
- In `src/public/confirm/styles.css`, add modal overlay styles (backdrop, centered card, buttons)
- Depends on: nothing (can be done independently)

### 5. `remove-thermal-printer-dep` — Clean up node-thermal-printer

- Remove `node-thermal-printer` from `package.json` dependencies
- Run `pnpm install` to update lockfile
- Depends on: `rewrite-printer-service`

### 6. `build-and-verify` — Build client bundle and type-check

- Run `pnpm build:client` to regenerate confirm/app.js and config/app.js
- Run `pnpm exec tsc --noEmit` to verify no type errors
- Manual test: start dev server, navigate to `/config` → `/confirm`, verify modal appears and print job dispatches silently
- Depends on: all above todos

---

## Files Changed

| File | Change |
| `src/services/printer.ts` | Complete rewrite — SumatraPDF CLI, remove thermal printer |
| `src/routes/financial-routes.ts` | Parse orientation/paperSize, pass full options to printFile |
| `src/public/confirm/index.html` | Add confirmation modal HTML |
| `src/public/confirm/app.ts` | Show modal on click, dispatch print from modal |
| `src/public/confirm/styles.css` | Modal overlay styles |
| `package.json` | Remove `node-thermal-printer` dependency |
| `bin/SumatraPDF.exe` | New — portable SumatraPDF binary |

## Notes

- SumatraPDF only prints files it can open (PDF, images, XPS, etc.). Word/Excel documents need to be converted to PDF first — the existing `convertToPdfPreview` in `src/services/preview.ts` may help here, or we ensure uploaded files are PDF/image before reaching the print stage.
- The `exec('print')` Windows command was unreliable and could open dialogs. SumatraPDF's `-print-to-default` is the standard kiosk-safe approach.
- Color mode support depends on the printer driver — SumatraPDF passes `color`/`monochrome` to the driver, but the printer must support it.
