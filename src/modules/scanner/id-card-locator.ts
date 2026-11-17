/**
 * Finds the ID card on a full-glass scan so the customer can place the card
 * anywhere on the glass. The scan is reduced to a gray image, split into
 * small cells, and the largest connected group of cells that differ from the
 * empty glass is taken as the card.
 */
import type { IdRect } from '@/shared/id-card-layout';
import { MM_TO_PT } from '@/shared/id-card-layout';

/** Gray image, row-major, 0 black and 255 white. */
export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** A rendered scan page with the size of the page it came from, in points. */
export interface RenderedScan extends GrayImage {
  pageWidthPt: number;
  pageHeightPt: number;
}

/** Pixels, origin top-left. */
export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Render resolution for locating the card. Coarse is enough for a crop. */
export const ID_LOCATE_PX_PER_MM = 2;
/** Side of one detection cell. */
export const ID_LOCATE_CELL_MM = 2;
/** A pixel this far from the glass gray counts as card. Tune on the scanner. */
export const ID_LOCATE_GRAY_DELTA = 40;
/** Share of card pixels that marks a cell as card. */
export const ID_LOCATE_CELL_FILL = 0.2;
/** A group smaller than this on either side is dust or a smudge, not a card. */
export const ID_LOCATE_MIN_SIDE_MM = 30;
/** Margin kept around the found card so its edge is never cut. */
export const ID_LOCATE_PADDING_MM = 3;

/** Gray level of the empty glass: the median, since the card is small. */
function backgroundGray(data: Uint8Array): number {
  const histogram = new Uint32Array(256);
  for (const value of data) histogram[value] += 1;
  const half = data.length / 2;
  let seen = 0;
  for (let gray = 0; gray < 256; gray += 1) {
    seen += histogram[gray];
    if (seen >= half) return gray;
  }
  return 255;
}

/**
 * Bounding box of the card in pixels, padded, or null when nothing card-sized
 * stands out from the glass.
 */
export function findCardBox(
  image: GrayImage,
  pxPerMm: number,
): PixelBox | null {
  const { data, width, height } = image;
  if (width === 0 || height === 0 || data.length < width * height) return null;

  const background = backgroundGray(data);
  const cellPx = Math.max(1, Math.round(ID_LOCATE_CELL_MM * pxPerMm));
  const cols = Math.ceil(width / cellPx);
  const rows = Math.ceil(height / cellPx);
  const marked = new Uint8Array(cols * rows);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x0 = col * cellPx;
      const y0 = row * cellPx;
      const x1 = Math.min(width, x0 + cellPx);
      const y1 = Math.min(height, y0 + cellPx);
      let hits = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (Math.abs(data[y * width + x] - background) > ID_LOCATE_GRAY_DELTA) {
            hits += 1;
          }
        }
      }
      if (hits >= (x1 - x0) * (y1 - y0) * ID_LOCATE_CELL_FILL) {
        marked[row * cols + col] = 1;
      }
    }
  }

  // Largest 8-connected group of marked cells.
  const seen = new Uint8Array(cols * rows);
  let best: { count: number; c0: number; r0: number; c1: number; r1: number } | null =
    null;
  const stack: number[] = [];
  for (let start = 0; start < marked.length; start += 1) {
    if (!marked[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let count = 0;
    let c0 = cols;
    let r0 = rows;
    let c1 = -1;
    let r1 = -1;
    while (stack.length > 0) {
      const cell = stack.pop()!;
      const col = cell % cols;
      const row = (cell - col) / cols;
      count += 1;
      if (col < c0) c0 = col;
      if (col > c1) c1 = col;
      if (row < r0) r0 = row;
      if (row > r1) r1 = row;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nc = col + dx;
          const nr = row + dy;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const next = nr * cols + nc;
          if (marked[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    if (!best || count > best.count) best = { count, c0, r0, c1, r1 };
  }
  if (!best) return null;

  const minCells = ID_LOCATE_MIN_SIDE_MM / ID_LOCATE_CELL_MM;
  if (best.c1 - best.c0 + 1 < minCells || best.r1 - best.r0 + 1 < minCells) {
    return null;
  }

  const pad = Math.round(ID_LOCATE_PADDING_MM * pxPerMm);
  const x = Math.max(0, best.c0 * cellPx - pad);
  const y = Math.max(0, best.r0 * cellPx - pad);
  const right = Math.min(width, (best.c1 + 1) * cellPx + pad);
  const bottom = Math.min(height, (best.r1 + 1) * cellPx + pad);
  return { x, y, width: right - x, height: bottom - y };
}

/** Converts a pixel box to PDF points on the scanned page, origin bottom-left. */
export function pixelBoxToPagePoints(
  box: PixelBox,
  scan: RenderedScan,
): IdRect {
  const sx = scan.pageWidthPt / scan.width;
  const sy = scan.pageHeightPt / scan.height;
  return {
    x: box.x * sx,
    y: scan.pageHeightPt - (box.y + box.height) * sy,
    width: box.width * sx,
    height: box.height * sy,
  };
}

/**
 * The card's box on the scanned page in points, or null when no card stands
 * out (the merge then uses the whole scan).
 */
export async function locateIdCard(
  pdfPath: string,
  render: (pdfPath: string, pxPerMm: number) => Promise<RenderedScan>,
): Promise<IdRect | null> {
  const scan = await render(pdfPath, ID_LOCATE_PX_PER_MM);
  const pxPerMm = scan.width / (scan.pageWidthPt / MM_TO_PT);
  const box = findCardBox(scan, pxPerMm);
  return box ? pixelBoxToPagePoints(box, scan) : null;
}
