# Epson L5290 physical acceptance matrix

Status: **not physically executed**. Complete on the deployment tablet and printer.

## Setup and evidence

Record date, tester, Node/worker revisions, Windows version, Epson driver version,
Sumatra version and the four configured queue names. Save screenshots of each
queue's system-wide Printing Defaults: Plain Paper, correct quality/orientation,
and Reduce/Enlarge disabled. Do not enable borderless or driver Fit to Page.

Load only the selected target size for each run. Measure the stock: A4 210 × 297 mm,
Letter 215.9 × 279.4 mm, Legal 215.9 × 355.6 mm. Do not substitute 8.5 × 13 inch
stock for Legal. Do not intentionally feed a different size to a queued job.

Use nonblank PDF fixtures of each source size, with corner labels, unequal top/
bottom markers, a circle, color and gray patches, a 100 mm ruler, and an edge frame.
Capture `/config`, selected settings, job ID, JSON sidecar, selected logical queue,
Sumatra arguments and a photo/measurements of each sheet. Use the normal approved
operator test/payment procedure; do not bypass payment or enqueue customer files.

## Baseline: every source-to-target mapping

Run these at Fit, portrait, rotation 0, Standard, colored, one copy. The scale is
the contract prediction for full-page source dimensions, not a driver measurement.

| ID  | Source PDF | Target / loaded stock | Required check                                        |
| --- | ---------- | --------------------- | ----------------------------------------------------- |
| P01 | A4         | A4                    | Full visible source, centered; no second shrink       |
| P02 | Letter     | A4                    | Aspect ratio retained; expected unequal blank borders |
| P03 | Legal      | A4                    | Long page reduced, bottom marker visible              |
| P04 | A4         | Letter                | Full source inside Letter target                      |
| P05 | Letter     | Letter                | 100 mm ruler becomes about 95.29 mm                   |
| P06 | Legal      | Letter                | 100 mm ruler becomes about 75.71 mm                   |
| P07 | A4         | Legal                 | Full source; possible enlargement under Fit           |
| P08 | Letter     | Legal                 | Width-limited Fit; larger top/bottom borders          |
| P09 | Legal      | Legal                 | Full source including bottom marker                   |

For every row confirm paper selection in the sidecar AND command. Prepared jobs
must contain `noscale`, not `fit`, plus `ignore-pdf-print-settings`. The queued
request still says `scaling: fit`. Do not mistake the prepared-dispatch setting
for the customer's requested scaling.

## Settings and edge cases

| ID  | Run                                                                | Expected                                                                                       |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| S01 | Each target, Standard + landscape, user rotation 90                | Correct landscape queue and target; upright markers match preview                              |
| S02 | Each target, High + portrait                                       | Correct High queue; size/position unchanged versus Standard                                    |
| S03 | Each target, High + landscape, rotation 270                        | Correct HighLandscape queue; preview and output match                                          |
| S04 | Letter target, colored then grayscale                              | Color choice preserved; geometry unchanged                                                     |
| S05 | Three numbered pages, two copies                                   | Six sheets, ordered 1-2-3 then 1-2-3, no extra copies                                          |
| S06 | Pages 2-3 only, two copies                                         | Four sheets, 2-3 then 2-3; progress/copy count correct                                         |
| S07 | Native PDF /Rotate 0/90/180/270, plus user rotation 0/90           | No doubled rotation; corner labels and visible extent match preview                            |
| S08 | Offset CropBox smaller than MediaBox; also nonzero MediaBox origin | Hidden content stays hidden; crop is centered and fitted correctly                             |
| S09 | Mixed A4/Letter/Legal pages in one PDF, target A4                  | Each page independently fits; target never changes mid-job                                     |
| S10 | Landscape source without /Rotate; rotations 0/180                  | No unexpected auto-rotation or missing bottom/right edge                                       |
| S11 | Portrait and landscape PNG/JPEG; unequal X/Y DPI metadata          | Pixel aspect ratio preserved; circle not stretched; zoom does not change paper-relative layout |
| S12 | PDF embedding PrintScaling=None, NumCopies>1, PickTrayByPDFSize    | Selected target, Fit and requested copies win                                                  |
| S13 | PDF after rapid paper/rotation changes and preview zoom            | Final preview corresponds to final settings; no stale render                                   |
| S14 | Very small source page                                             | Enlarged according to Fit, centered without stretching                                         |

## Pass criteria and failure triage

- Target stock matches selected size; no unexpected pages or copy multiplication.
- Visible content, rotation and relative margins agree with preview. No edge marks
  disappear. Ruler length agrees with `100 mm × calculated scale`; use ±1 mm as
  an initial acceptance tolerance, record actual results, and investigate outside it.
- The limiting source boundary should be about 5.08 mm from the target edge. Larger
  margins in the other axis are expected. Uniform extra shrink suggests driver
  resizing or a second application of Fit; asymmetry suggests origin/driver offset.
- Record High/Standard and grayscale results separately; slower High output alone
  is not a failure. Spooler success is not proof of physical completion.
- If the installed printer's unprintable margin exceeds the application inset,
  stop rollout and adjust the shared inset with matching preview/worker tests.
  Do not compensate by independently scaling only one layer.

Record each ID as PASS/FAIL/NOT RUN with job ID, measurements, screenshots, photo
and notes. Release acceptance requires all baseline rows and applicable settings
rows to pass; this document is a test plan, not a claim of hardware validation.
