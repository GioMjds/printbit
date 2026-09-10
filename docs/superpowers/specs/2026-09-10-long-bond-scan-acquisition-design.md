# Long-Bond Scan Acquisition Design

## Status

Approved for review on 2026-09-10.

## Context

An Epson L5290 flatbed physically captures at most 216 x 297 mm. It cannot
acquire a Philippine Long Bond original (216 x 330 mm) placed on the glass.
The ADF supports the required longer originals, but PrintBit currently does
not send an acquisition page size for interactive scans. In addition, NAPS2
can inherit a GUI profile unless invoked with `--noprofile`.

The present product model also calls the 8.5 x 14 inch US Legal option "Long
Bond". That conflates two distinct source and output sizes:

| Canonical value | Dimensions | User-facing name |
| --- | --- | --- |
| `A4` | 210 x 297 mm | A4 |
| `Letter` | 8.5 x 11 in | Short Bond |
| `Long` | 8.5 x 13 in | Long Bond |
| `Legal` | 8.5 x 14 in | Legal |

## Decision

Use the four canonical values above end to end. `Long` is never an alias for
`Legal`, and existing persisted `Legal` records retain their 8.5 x 14 inch
meaning.

For source acquisition, the browser selects a document size before scanning.
Copy uses the glass only for A4 and Letter, and uses the ADF for Long and
Legal. Scan always uses the ADF. The source-selection choice is persisted
separately from the copy output-paper choice so that a later output scaling
choice cannot falsely change how the original was acquired.

Every scan request carries its canonical `paperSize`. Node validates and
forwards it through the named-pipe `StartScan` request. The Worker starts
NAPS2 with `--noprofile` and maps the canonical value to a supported NAPS2
page-size argument. Flatbed scans always request the full physical bed,
`216x297mm`; they are deliberately unavailable for Long and Legal sources.

## Browser Flow

### Copy

1. The `/copy` page presents a required document-size control before the
   initial check scan; its safe default is A4.
2. A4 and Short Bond instruct the customer to place the original face-down on
   the glass. Long Bond and Legal instruct the customer to insert it face-up,
   short edge first, in the ADF.
3. `POST /api/scan/preview` receives `{ paperSize }`. The service resolves
   `A4`/`Letter` to `flatbed`, and `Long`/`Legal` to `adf`, then creates the
   preview scan with that source and size.
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

Introduce a shared `PaperSize` union containing `A4`, `Letter`, `Long`, and
`Legal`. Apply it to scan job settings, copy settings, print settings,
financial/receipt snapshots, config geometry, and worker handoff payloads.

`InteractiveScanBody`, `InteractiveScanInput`, `ScanJobBody`, and
`ScanJobInput` accept `paperSize`. The scanner controller returns HTTP 400 for
an absent or invalid scan paper size. `ScannerService.interactiveScan`,
`validateScanJobInput`, and `previewScan` carry the validated value into
`getAdapter().scan()`.

Copy preview input is intentionally a different request shape from the
interactive scan request: its source is server-derived from the declared
document size, so a browser cannot request a Long source on the flatbed.

Printing, quoting, receipts, and UI labels distinguish Long from Legal. A new
Legal price profile is added where configuration supports per-paper profiles;
when no Legal profile exists, it falls back to the existing `longBond` price
to preserve current deployments until an administrator sets a Legal price.

## Worker Contract

The existing `StartScan` IPC field remains `paperSize`, now with all four
canonical values. `Naps2ScannerService.BuildNaps2Args()` must use the exact
mapping below, rather than passing raw strings through:

| Source | Paper size | NAPS2 argument |
| --- | --- | --- |
| glass | any permitted value | `--pagesize 216x297mm` |
| feeder | A4 | `--pagesize a4` |
| feeder | Letter | `--pagesize letter` |
| feeder | Long | `--pagesize 8.5x13in` |
| feeder | Legal | `--pagesize legal` |

Each invocation includes `--noprofile`, explicit driver/device/source/DPI/bit
depth, `--force`, and `--verbose`. The Worker print-size normalizer likewise
maps `Long` to `8.5x13in`, while preserving `Legal` as `legal`.

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

1. Node rejects an invalid scan paper size and forwards a valid `Long` value
   through the interactive scan adapter request.
2. A Long or Legal copy preview selects `adf`; an A4 or Letter preview selects
   `flatbed`.
3. The scan browser request contains the selected size, saves it to session
   state, and uses 300 DPI by default.
4. Geometry detection recognizes 8.5 x 13 inch documents as `Long` and keeps
   8.5 x 14 inch documents as `Legal`.
5. Worker argument tests verify `--noprofile` and each exact NAPS2 page-size
   mapping, including the full-bed flatbed argument.

Hardware acceptance uses one physical Long Bond original and one Legal
original. For each, inspect the resulting raw scan file directly from
`uploads/scans`; it must contain the entire page before reviewing the kiosk
preview. Exercise copy A4/Letter on glass and copy Long/Legal through the ADF.

## Alternatives Rejected

- **Preview CSS changes:** current previews use containment, and CSS cannot
  restore source pixels outside the physical flatbed area.
- **Treating Long as Legal:** changes a 13-inch original into a 14-inch scan
  contract and remains vulnerable to mismatch in NAPS2 and printing.
- **Relying on the latest NAPS2 GUI profile:** makes kiosk behavior depend on
  mutable workstation state rather than the PrintBit request.
- **Using the flatbed for Long/Legal:** conflicts with the L5290's 297 mm
  physical scan-bed limit.

## Non-goals

- Altering visual preview sizing or adding client-side crop recovery.
- Changing unrelated existing clear/rescan UI work in either current worktree.
- Guessing a paper size from a cropped image before acquisition.
