# Printing Output Contract Implementation Plan

**Goal:** Make preview and physical output use the same explicit target paper and default Fit layout.

**Architecture:** Keep the existing Node JSON sidecar and C# preprocessing pipeline. Share a documented configuration and geometry fixtures between the browser and worker. Fit is applied once during preparation; prepared target-sized PDFs use Sumatra `noscale`.

**Tech Stack:** TypeScript, PDF.js, .NET 10, PDFsharp, SumatraPDF.

**Spec:** `PRINTING_OUTPUT_MISMATCH_FIX.md`, scoped by the user's fourteen tasks (retain A4, Letter, Legal).

## Contract and constraints

- `paperSize`: A4 (595.28 × 841.89 pt), Letter (612 × 792 pt), Legal (612 × 1008 pt).
- `scaling`: `fit` by default; `actual` supported by layout/worker; kiosk automatically selects Fit.
- Preserve `colored`/`grayscale` in Node and boolean `color` on the existing worker wire format.
- Preserve standard/high quality, portrait/landscape, copies, explicit rotation and page selection.
- Fit maintains aspect ratio, centers the rotated source within a 14.4 pt inset (the existing worker safety margin). This is an application inset, not a measurement of the installed driver's printable area.
- Actual size centers source at 1:1; larger content can clip. Never silently stretch.
- Keep worker profiles, serialization, timeout, queue verification and payment behavior.
- No deployment or physical printing is part of automated verification.

## Tasks

- [x] Trace Node, worker sidecar, C# preprocessor, Sumatra builder, preview.
- [x] Add regression tests for emitted default Fit and retained target/settings; run and observe failures.
- [x] Add shared TypeScript contract and layout helper, use in preview and handoff. Preview renders to target-sized canvas with rotation before fitting.
- [x] Add C# tests for serialized scaling, layout geometry and prepared dispatch without second fit; run and observe failures.
- [x] Add C# layout mapping, explicit scaling and prepared dispatch settings; preserve raw Fit command and PDF preference suppression.
- [x] Build Node, build/test C#, review diff and fix findings.
- [x] Refresh graphify and write Epson physical acceptance matrix and implementation notes.

## Verification record (2026-09-13)

- Node build and `pnpm exec tsc --noEmit`: passed.
- `pnpm test --runInBand --forceExit`: 57 tests passed. An earlier full run passed
  assertions but did not exit because of an open async handle; forced exit does
  not establish clean test teardown.
- C# Release solution build: passed; existing NU1510 redundant System.Text.Json
  package-reference warning remains. Release avoids the running Debug worker's
  locked binaries; the worker was not stopped.
- C# full Release test run after geometry fixes: 535 passed, none failed/skipped.
- Review identified native PDF rotation, CropBox and unequal image DPI parity
  issues. Fixed with visible-box normalization, one outer rotation/scale, and pixel
  image geometry. Added nonblank PDF import and image regressions.
- Scoped printing diff whitespace checks passed. Unrelated admin stylesheet has
  an existing end-of-file whitespace finding and was not edited for this task.
- Knowledge graphs refreshed with AST-only updates. No deployment or physical
  printing performed. Browser DevTools MCP is unavailable in this session;
  runtime browser/physical acceptance remains in the supplied matrix.

Deliverables: `docs/printing-configuration.md` and
`docs/epson-l5290-physical-test-matrix.md`.

## Verification examples

```ts
expect(sidecar.scaling).toBe('fit');
// 612 × 792 pt source on Letter: available width 583.2, so Fit scale = 0.9529411765.
expect(layout.scale).toBeCloseTo(0.9529411765);
```

```csharp
Assert.Contains("noscale", preparedDispatch.StartInfo.ArgumentList[3]);
Assert.Contains("fit", rawDispatch.StartInfo.ArgumentList[3].Split(','));
```

Run `pnpm test --runInBand`, `pnpm build`, `dotnet build printbit-worker.slnx`, and `dotnet test tests/PrintBit.Tests/PrintBit.Tests.csproj`. Test processes must use fake print executables, never enqueue physical jobs.
