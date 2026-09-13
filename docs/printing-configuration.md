# Preview and physical print configuration

## Contract

The kiosk always selects **Fit**. A4, Letter and Legal remain selectable physical
targets; the source PDF's size does not select the output paper. Staff must load
paper matching the selected target. This change does not add tray sensing or an
administrator loaded-paper gate.

The browser and Node use `src/shared/print-configuration.ts`. The C# worker mirrors
the geometry in `DocumentProcessing/PrintLayout.cs` and deserializes the existing
version-2 JSON sidecar into `PrintJobSettings`. This is one documented protocol,
not a binary/library shared across the two languages.

| Setting | Kiosk/Node | Worker sidecar |
| --- | --- | --- |
| Physical target | `paperSize`: `A4`, `Letter`, `Legal` | Same; default A4 |
| Scaling | `scaling`: `fit` | Same; missing values default Fit |
| Orientation | `portrait`, `landscape` | Same |
| Rotation | `rotationDeg`: 0, 90, 180, 270 clockwise | Same |
| Color | `colorMode`: `colored`, `grayscale` | `color`: true, false |
| Quality | `quality`: `standard`, `high` | Same; existing logical queue selection |
| Copies | Positive integer | Same; orchestrator submits one copy at a time |
| Selected pages | Existing page selection | Existing `pageRange`; baked into prepared PDF |

`actual` is supported by the layout/worker for internal use (not a new kiosk
option or a promised financial-API option). It centers content at 1:1 and permits
clipping. The orchestrator uses it when dispatching an already prepared PDF.
Old sidecars remain valid. Deploy browser/Node and worker together for matching
preview and output; a new browser with an old worker can still shrink twice.

## Geometry and ownership

One PDF point is 1/72 inch. Portrait target sizes are exact contract constants:

| Paper | Width (pt) | Height (pt) |
| --- | ---: | ---: |
| A4 | 595.28 | 841.89 |
| Letter | 612 | 792 |
| Legal | 612 | 1008 |

Landscape swaps target width and height. Native PDF rotation and the user's
rotation are applied once, before calculating Fit. The visible PDF page is the
intersection of CropBox and MediaBox (MediaBox fallback for an empty intersection).
Raster images preserve their pixel aspect ratio, independent of DPI metadata.
Internal image Actual uses one pixel per point, not the image's metadata DPI.

Fit centers the source inside a 14.4 pt (5.08 mm) inset on each side, retaining
aspect ratio. Given rotated source dimensions `sw`, `sh` and target `tw`, `th`:

```text
scale = min((tw - 28.8) / sw, (th - 28.8) / sh)
x = (tw - sw * scale) / 2
y = (th - sh * scale) / 2
```

This is the worker's existing application safety inset, NOT a measurement of the
installed driver's printable area. Fit can enlarge small sources. The Letter
612 × 792 fixture gives scale 0.9529411765, x 14.4, y 18.6352941; the rotated
landscape fixture gives the same scale. Both language test suites assert these.

```text
/config target-sized preview -> confirmation -> Node printer -> v2 JSON sidecar
  -> C# page selection/layout -> target-sized prepared PDF -> Sumatra -> Epson queue
```

The browser renders PDF content into a target-sized canvas. The worker prepares
the same target geometry once. Sumatra then receives explicit `paper=<target>`,
orientation, `noscale`, and `ignore-pdf-print-settings`; direct unprepared dispatch
still defaults to `fit`. Keep driver Reduce/Enlarge off to avoid another resize.

`ignore-pdf-print-settings` prevents embedded PDF preferences from overriding
scaling, copies and related dispatch choices. See the
[official Sumatra command-line reference](https://www.sumatrapdfreader.org/docs/Command-line-arguments).
Color and quality remain driver/profile responsibilities; preview is not a
color-managed proof. Four existing Standard/High portrait/landscape logical
queues, spooler verification, print serialization, timeouts and payment handling
are unchanged.

## Acceptance

Automated tests cover sidecar defaults/settings preservation, geometry, prepared
dispatch, image zoom and PDF import geometry. They do not prove that a physical
sheet exited or that Epson defaults match the contract. Use the
[Epson L5290 physical test matrix](epson-l5290-physical-test-matrix.md) before deployment.
