# PrintBit: Native Print Engine Migration Spec

Status: Draft v1 | Owner: Gio | Scope: PrintBit.HardwareService (C# worker)

## 1. Summary

PrintBit currently prints by spawning `SumatraPDF.exe`. This spec defines a safe, reversible migration to native print engines built on Windows APIs, so that PrintBit improves print fidelity and speed and no longer depends on an external executable. The migration is gated by per-file-type flags, an admin-only test lane, automatic fallback, and tiered alerting.

## 2. Goals and Non-Goals

### **Goals**

- Improve print fidelity and time to first page versus the current Sumatra path.
- Remove the `SumatraPDF.exe` call and its external-process timeout.
- Control per-job settings (copies, color or grayscale, paper size, duplex, page range) in-process.
- Roll out with zero added risk to paid customer jobs.

### **Non-Goals**

- Replacing LibreOffice for Office-file conversion.
- Fixing the intermittent DOCX failures (they originate upstream in conversion and caching).
- Raw ESC/P-R printing, PDF to XPS pipelines, or third-party PDF libraries.
- Parallel printing (the global one-job-at-a-time semaphore stays).

## 3. Constraints and Assumptions

- A customer has already paid by the time a job reaches the engine, so a failed print has a real cost.
- One printer (Epson L5290) with two logical queues: "EPSON L5290 Series" and "PrintBit - High". Quality is largely set by driver queue defaults, so engine comparisons must hold the queue constant.
- The kiosk is unattended and runs under Assigned Access.
- Windows has no native "print this PDF file" API. Native printing means rendering the PDF yourself and drawing it to the printer device context.
- Sumatra also rasterizes through GDI, so expect comparable quality. Gains are more likely in speed, settings control, and dependency removal than in raw fidelity.

## 4. Architecture

### 4.1 Engine abstraction

```csharp
public interface IPrintEngine
{
    Task<PrintResult> PrintAsync(PrintJob job, CancellationToken ct);
}
```

`PrintResult` includes: success flag, error code and message, pages sent to spooler, duration, and engine name.

### 4.2 Implementations

| Engine            | Input               | Mechanism                                                                                           |
| ----------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| SumatraEngine     | PDF, images         | Existing code wrapped unchanged (fallback)                                                          |
| NativePdfEngine   | PDF                 | `Windows.Data.Pdf` renders each page to a bitmap, drawn via `System.Drawing.Printing.PrintDocument` |
| NativeImageEngine | JPG, PNG, BMP, TIFF | WIC or `System.Drawing` decode, drawn directly via `PrintDocument` (no PDF conversion)              |

Target framework: `net10.0-windows10.0.19041.0` so the WinRT PDF APIs are available.

### 4.3 File-type router

- PDF -> NativePdfEngine
- Image -> NativeImageEngine
- Office (DOCX, XLS, PPT) -> LibreOffice -> PDF -> NativePdfEngine (the conversion step is unchanged)
- Unsupported or unreliable codecs (HEIC, WebP) -> convert or reject at upload time

### 4.4 Configuration

- `HardwareSettings:PdfPrintEngine` = `sumatra` (default) | `native`

> [!NOTE]
> `PdfPrintEngine` is implemented in `HardwareSettings` and defaults to `sumatra` until Phase 2 pass criteria on real hardware are met. Per-file-type image flags, automatic `FallbackEnabled`, and `CircuitBreakerThreshold` are specification proposals that are not yet implemented in `DocumentPrinter`.

## 5. Native Engine Requirements

### 5.1 NativePdfEngine

- Render page by page at about 300 DPI (tied to the selected quality tier) and dispose each bitmap after drawing. Never hold the whole document in memory.
- Fit to the printer's printable area using hard margins from `PageSettings`. No clipped edges.
- Apply copies, color or grayscale, paper size, duplex, and page range through `PrinterSettings`.
- Respect the selected queue. Quality tier selection continues to map to the appropriate queue rather than the generic DEVMODE quality field, because the Epson driver's quality setting lives in its private DEVMODE.

### 5.2 NativeImageEngine

- Apply EXIF orientation.
- Choose portrait or landscape by aspect ratio.
- Fit to printable area, preserving aspect ratio.
- Flatten transparency onto white.
- Treat multi-frame TIFFs as multiple pages.
- Render at the printer DPI for the chosen tier.

### 5.3 Shared

- Margin and fit math lives in one pure function with unit tests that need no printer.
- Engines must report the exact number of pages sent to the spooler.
- The global one-job-at-a-time semaphore remains in force.

## 6. Rollout Plan

### Phase 0: Seam (no behavior change)

- Introduce `IPrintEngine`, `SumatraEngine`, the router, and flags (all defaulting to `sumatra`).
- Add per-job logging to SQLite: engine, queue, file type, duration, page count, result, and a snapshot of queue settings.
- Exit criteria: all existing flows work identically with logging in place.

### Phase 1: Native engines (disabled by default)

- Implement NativePdfEngine and NativeImageEngine behind flags.
- Unit-test margin and fit logic.
- Exit criteria: engines print a one-page sample on a dev machine.

### Phase 2: Admin-only test lane

- Add a hidden admin action that prints a fixed corpus through both engines on the real L5290 and both queues.
- Corpus: text-heavy PDF, scanned PDF, PDF with transparency, 20-page PDF, JPG with EXIF rotation, transparent PNG, multi-frame TIFF, grayscale document, duplex and multi-copy job.
- Record: time to first page, total time, peak memory, and a visual comparison of output.
- **Pass criteria (defined before testing):** native is no slower than Sumatra, no visual regression, zero clipped margins, and correct page counts and settings.
- Also verify that `Windows.Data.Pdf` and `PrintDocument` work from the Worker Service under Assigned Access on the kiosk itself.

### Phase 3: Canary on real jobs

- Enable native for images first, then PDFs, with fallback enabled.
- Observe for 1 to 2 weeks: failure rate, fallback rate, latency.
- Exit criteria: fallback rate stays within the rate-alert threshold with no unexplained error signatures.

### Phase 4: Cutover and removal

- Native becomes the default; Sumatra remains as fallback for one more release cycle.
- **Removal criterion:** zero fallbacks over a fixed window (2 weeks or N jobs, whichever is larger) with a representative file-type mix.
- Then delete `SumatraEngine`, the bundled exe, and the 120s external timeout.

## 7. Fallback Behavior *(Specification / Not Yet Implemented)*

> [!WARNING]
> Automatic fallback and circuit-breaker behavior are currently **not yet implemented** in `DocumentPrinter`. When `PdfPrintEngine` is set to `native`, failures in `NativePdfPrinter` return immediately with `PrintFailureStage.ProcessStart` without automatic retry in Sumatra or circuit-breaker counters. Fallback to Sumatra is currently done manually by setting `HardwareSettings:PdfPrintEngine` to `sumatra`.

The proposed design for automated fallback once implemented:

The native engine is attempted first; on failure the same job may be retried with Sumatra.

**Double-print guard:** fall back only if zero pages reached the spooler. If pages were already spooled, cancel the spool job first. If cancellation cannot be confirmed, mark the job failed and trigger the existing refund or dispute flow rather than reprinting.

**Circuit breaker:** after N consecutive native failures for a file type, automatically switch that type back to Sumatra for the rest of the day and send a single alert.

## 8. Observability and Alerting

1. **Always log.** Every fallback writes a structured row: job ID, file type, engine tried, error, pages spooled (yes/no), and duration.
2. **Phases 2 and 3:** alert on every fallback with job ID, file type, error, and pages-spooled status.
3. **After stabilization:** alert on rate (for example, more than 2% of jobs in a day) or on a new error signature. Individual fallbacks go log-only.
4. **Throttle and dedupe:** group by error signature, at most one alert per signature per hour, with a count.
5. **Critical alert, always immediate:** a fallback after pages were spooled (the double-print or refund case).
6. **Channel:** reuse the existing admin surface (dashboard badge), with push or email only for circuit-breaker trips and critical alerts.

## 9. Risks and Mitigations

| Risk                                                      | Mitigation                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Double printing on fallback                               | Spooler-state guard, cancel before retry, otherwise fail and refund                                              |
| Page-count mismatch with Issue #48 pre-calculation        | Share page and color classification rules between server and engines; add tests for images and multi-frame TIFFs |
| Memory spikes on large PDFs                               | Page-by-page rendering with immediate disposal                                                                   |
| Behavior differs under Assigned Access or service session | Test on the kiosk in Phase 2, before any customer exposure                                                       |
| Driver-queue drift invalidates comparisons                | Snapshot queue settings in every log row                                                                         |
| Misattributing DOCX failures to the new engine            | Keep LibreOffice conversion investigation separate; tag results by pipeline stage                                |
| Clipped margins or wrong scaling                          | Single tested fit function; corpus includes edge-case page sizes                                                 |

## 10. Open Questions

- Final values for the circuit-breaker threshold and the rate-alert percentage.
- Which admin channel (badge only, or push and email) is used for critical alerts.
- How the "visual comparison" in Phase 2 is recorded (side-by-side physical prints versus scanned captures).
- Whether HEIC and WebP are rejected at upload or converted.

## 11. Definition of Done

- Native engines handle PDF and images with settings parity versus Sumatra.
- Phase 2 pass criteria met on the real kiosk.
- Zero fallbacks over the removal window.
- `SumatraEngine`, the exe, and its timeout are removed, and the documentation is updated.
