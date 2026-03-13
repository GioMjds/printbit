# PrintBit Web Copilot Instructions

## Build, test, and lint commands
- Install dependencies: `pnpm install`
- Run kiosk server in dev mode (TypeScript via ts-node-dev): `pnpm run dev`
- Build browser bundle from `src/public/app.ts`: `pnpm run build`
- Type-check server/client TypeScript (no emit): `pnpm exec tsc --noEmit`
- Tests: no test runner or test scripts are currently configured.
- Single-test command: not available yet (no test framework is configured in this repository).
- Lint: no lint script/config is currently configured.

## High-level architecture
- **Backend entrypoint:** `src/server.ts` initializes Express + HTTP + Socket.IO, serves static files from `src/public` (and `dist/public`), and starts listening on `0.0.0.0:3000`.
- **Money state:** `src/services/db.ts` uses LowDB (`db.json`) with `{ balance, earnings }`; this state is shared across routes and serial events.
- **Coin hardware flow:** `src/services/serial.ts` auto-selects the first available serial port (9600 baud), parses incoming data as integer coin values, increments `db.data.balance`, persists to `db.json`, then emits live balance updates over Socket.IO (`balance` event).
- **Print flow:** `POST /print` checks minimum balance, sends the file to OS print via `src/services/printer.ts`, moves current balance to earnings, resets balance to 0, persists state, and emits `balance=0`.
- **Uploads:** `POST /upload` stores files in `uploads/` via multer. `src/services/session.ts` contains a richer session-based upload domain (tokens, allowed MIME types, 25MB limit), but that flow is not fully wired into routes yet.
- **Frontend:** static HTML pages in `src/public/**`; `src/public/app.ts` handles kiosk navigation and Socket.IO balance rendering, then is bundled to `src/public/bundle.js`.

## Key repository conventions
- Global styling is on `src/globals.css` and component-specific styles are co-located as `*.css` files next to their respective `*.ts` modules in `src/public/`.
- Keep backend runtime code in `src/` and browser logic in `src/public/`; do not import browser-only code into server modules.
- If `src/public/app.ts` changes, regenerate `src/public/bundle.js` with `pnpm run build` (bundle is checked into the repo and loaded directly by HTML).
- UI event wiring depends on specific element IDs (`openPrintBtn`, `openCopyBtn`, `openScanBtn`, `openSettingsBtn`, `powerOffBtn`, `balance`) referenced in `app.ts`.
- The current print pricing logic is fixed in route code (`/print` uses a balance threshold of `5`), and money reset/earnings transfer happens immediately after print dispatch.
- `uploads/` and `db.json` are runtime state artifacts used by kiosk workflows; avoid destructive changes to these paths during feature work.
- TypeScript settings are strict with CommonJS modules (`tsconfig.json`), so new modules should follow existing import/export style and strict typing.

## Documentation references
- Installation/software baseline: `INSTALLATION_AND_DEPENDENCIES.md`.
- Documentation improvement backlog: `DOCUMENTATION_SUGGESTIONS.md`.
