# Contributing to PrintBit

Thanks for contributing to PrintBit.
This guide focuses on safe, small, production-minded changes for kiosk reliability.

## Development setup

```bash
pnpm install
pnpm run dev
```

Useful commands:

```bash
pnpm run build
pnpm exec tsc --noEmit
```

## Workflow

1. Create a focused branch for one change.
2. Keep edits minimal and scoped to the task.
3. Verify behavior locally.
4. Open a PR with:
   - what changed,
   - why it changed,
   - how to test it,
   - any risks or follow-ups.

## Codebase conventions

- Keep backend runtime code in `src/`.
- Keep browser logic in `src/public/`.
- Do not import browser-only modules into server modules.
- If you edit `src/public/*.ts` that is shipped directly, rebuild with `pnpm build`.
- Keep TypeScript strict and avoid `any`-style shortcuts.
- Follow existing naming and file placement patterns.

## Hardware and runtime safety

- Avoid destructive changes to runtime artifacts:
  - `uploads/`
  - `db.json`
- Printing depends on `bin/SumatraPDF.exe`; do not change printer integration casually.
- Serial/hotspot/scanner behavior should degrade gracefully when hardware is unavailable.

## API and validation expectations

- Validate all request inputs explicitly.
- Use consistent HTTP status codes and actionable error messages.
- Log significant operational events through the admin logging flow where applicable.

## Testing expectations

There is currently no formal test suite configured.
For every change, at minimum:

1. Run `pnpm exec tsc --noEmit`.
2. Manually verify the affected UI/API flow.
3. Confirm no regressions in print, upload, or admin behavior related to your change.
