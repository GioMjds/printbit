# Long-Bond Scan Acquisition Design

## Status

Accepted on 2026-09-10.

## Context

An Epson L5290 flatbed physically captures at most 216 x 297 mm. It cannot
acquire a Philippine Long Bond / US Legal original (216 x 356 mm) placed on
the glass.
The ADF supports the required longer originals, but PrintBit currently does
not send an acquisition page size for interactive scans. In addition, NAPS2
can inherit a GUI profile unless invoked with `--noprofile`.

The product has three paper sizes. `Short Bond` and `Long Bond` are customer
labels for the existing Letter and Legal values, not additional paper sizes:

| Canonical value | Dimensions   | User-facing name |
| --------------- | ------------ | ---------------- |
| `A4`            | 210 x 297 mm | A4               |
| `Letter`        | 8.5 x 11 in  | Short Bond       |
| `Legal`         | 8.5 x 14 in  | Long Bond        |

## Decision

Keep the existing three canonical values, `A4`, `Letter`, and `Legal`, end to
end. The kiosk displays their customer-facing labels—A4, Short Bond, and Long
Bond—without changing persisted records or the worker contract.

For source acquisition, the browser selects a document size before scanning.
Copy uses the glass only for A4 and Letter, and uses the ADF for Legal. Scan
always uses the ADF. The source-selection choice is persisted
separately from the copy output-paper choice so that a later output scaling
choice cannot falsely change how the original was acquired.

Every scan request carries its canonical `paperSize`. Node validates and
forwards it through the named-pipe `StartScan` request. The Worker starts
NAPS2 with `--noprofile` and maps the canonical value to a supported NAPS2
page-size argument. Flatbed scans always request the full physical bed,
`216x297mm`; they are deliberately unavailable for Long Bond / Legal sources.

## Browser Flow

### Copy

1. The `/copy` page presents a required document-size control before the
   initial check scan; its safe default is A4.
2. A4 and Short Bond instruct the customer to place the original face-down on
   the glass. Long Bond instructs the customer to insert it face-up, short
   edge first, in the ADF.
3. `POST /api/scan/preview` receives `{ paperSize }`. The service resolves
   `A4`/`Letter` to `flatbed` and `Legal` to `adf`, then creates the preview
   scan with that source and size.
4. The selected source-document size is retained in session storage as
   `copySourcePaperSize`. The config page initializes its copy output-paper
   control from that value, but a later output-paper change does not alter
   acquisition metadata.

### Scan

1. The `/scan` page presents the same source-document-size choices, defaulting
   to A4. Its ordinary scan default is 300 DPI, not 600 DPI.
2. `POST /api/scanner/scan` sends `source: "feeder"`, color, dpi, and
   `paperSize`.
3. The saved scan session retains the selected `paperSize`; it does not write
   a hardcoded A4 value.

## Node Contract

Keep the shared `PaperSize` union as `A4`, `Letter`, and `Legal`. Apply the
customer-facing labels consistently in scan and copy controls, configuration,
pricing, receipts, and status text while preserving the existing data and
worker values.

`InteractiveScanBody`, `InteractiveScanInput`, `ScanJobBody`, and
`ScanJobInput` accept `paperSize`. The scanner controller returns HTTP 400 for
an absent or invalid scan paper size. `ScannerService.interactiveScan`,
`validateScanJobInput`, and `previewScan` carry the validated value into
`getAdapter().scan()`.

Copy preview input is intentionally a different request shape from the
interactive scan request: its source is server-derived from the declared
document size, so a browser cannot request a Legal source on the flatbed.

Printing, quoting, and receipt storage retain their present `Legal` value.
The customer interface calls that option Long Bond, and the existing
`longBond` pricing profile remains its price source.

## Worker Contract

The existing `StartScan` IPC field remains `paperSize` with its three canonical
values. `Naps2ScannerService.BuildNaps2Args()` must use the exact
mapping below, rather than passing raw strings through:

| Source | Paper size          | NAPS2 argument         |
| ------ | ------------------- | ---------------------- |
| glass  | any permitted value | `--pagesize 216x297mm` |
| feeder | A4                  | `--pagesize a4`        |
| feeder | Letter              | `--pagesize letter`    |
| feeder | Legal (Long Bond)   | `--pagesize legal`     |

Each invocation includes `--noprofile`, explicit driver/device/source/DPI/bit
depth, `--force`, and `--verbose`. The Worker print-size normalizer preserves
`Legal` as `legal`.

## Failure Handling

- Invalid, missing, or unknown source-document sizes fail at the Node boundary
  with a 400 response; they never fall through to a previously used NAPS2
  profile.
- If the worker rejects the chosen ADF size or reports an unavailable scanner,
  existing scanner error handling displays the failure and retains no success
  metadata.
- A raw acquisition file is the source of truth for crop diagnosis. Acceptance
  testing checks it directly from `uploads/scans` before evaluating browser
  preview rendering.

## Testing and Acceptance

Automated coverage must prove:

1. Node rejects an invalid scan paper size and forwards a valid `Legal` value
   through the interactive scan adapter request.
2. A Long Bond / Legal copy preview selects `adf`; an A4 or Letter preview selects
   `flatbed`.
3. The scan browser request contains the selected size, saves it to session
   state, and uses 300 DPI by default.
4. Geometry detection recognizes 8.5 x 14 inch documents as `Legal`.
5. Worker argument tests verify `--noprofile` and each exact NAPS2 page-size
   mapping, including the full-bed flatbed argument.

Hardware acceptance uses one physical Long Bond / Legal original. Inspect the
resulting raw scan file directly from `uploads/scans`; it must contain the
entire page before reviewing the kiosk preview. Exercise copy A4/Short Bond on
glass and copy Long Bond through the ADF.

## Alternatives Rejected

- **Preview CSS changes:** current previews use containment, and CSS cannot
  restore source pixels outside the physical flatbed area.
- **Adding a new Long data value:** would incorrectly split the existing Legal
  contract even though Long Bond is only its kiosk label.
- **Relying on the latest NAPS2 GUI profile:** makes kiosk behavior depend on
  mutable workstation state rather than the PrintBit request.
- **Using the flatbed for Long Bond / Legal:** conflicts with the L5290's 297 mm
  physical scan-bed limit.

## Non-goals

- Altering visual preview sizing or adding client-side crop recovery.
- Changing unrelated existing clear/rescan UI work in either current worktree.
- Guessing a paper size from a cropped image before acquisition.
