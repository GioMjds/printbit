import {
  ID_BLANK_STDDEV_THRESHOLD,
  ID_OVERLAP_MIN_CELLS,
  checkIdScan,
  grayStandardDeviation,
  sharedCardCells,
} from './id-copy-scan-checks';

const SIZE = 32;
const LID = 235;
const CARD = 135;
const INK = 40;

function thumb(paint: (x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) out[y * SIZE + x] = paint(x, y);
  }
  return out;
}

// A full-glass scan is about 9 mm per cell: an 85.6 x 54 mm card is about
// 9 x 6 cells, placed at (left, top) in cells.
const inCard = (x: number, y: number, left: number, top: number) =>
  x >= left && x < left + 9 && y >= top && y < top + 6;

/** Card with a photo block on the left. */
const front = (left = 2, top = 2) =>
  thumb((x, y) => {
    if (!inCard(x, y, left, top)) return LID;
    return x - left < 3 && y - top >= 1 && y - top < 5 ? INK : CARD;
  });

/** Card with a stripe near the bottom. */
const back = (left = 2, top = 18) =>
  thumb((x, y) => {
    if (!inCard(x, y, left, top)) return LID;
    return y - top === 4 && x - left >= 1 && x - left < 8 ? INK : CARD;
  });

/** Empty glass: light gray with gentle lid shading, not pure white. */
const emptyGlass = () => thumb((x) => 236 + Math.round((x / 31) * 8));

function depsFor(files: Record<string, Uint8Array>) {
  return {
    thumbnail: async (filePath: string) => {
      const found = files[filePath];
      if (!found) throw new Error('no thumbnail');
      return found;
    },
  };
}

describe('grayStandardDeviation', () => {
  it('is low for empty glass and high for a card', () => {
    expect(grayStandardDeviation(emptyGlass())).toBeLessThan(
      ID_BLANK_STDDEV_THRESHOLD,
    );
    expect(grayStandardDeviation(front())).toBeGreaterThan(
      ID_BLANK_STDDEV_THRESHOLD,
    );
  });

  it('is 0 for an empty array', () => {
    expect(grayStandardDeviation(new Uint8Array(0))).toBe(0);
  });
});

describe('sharedCardCells', () => {
  it('is 0 when the sides sit apart on the glass', () => {
    expect(sharedCardCells(front(), back())).toBe(0);
  });

  it('counts the cells where both sides sit', () => {
    expect(sharedCardCells(front(2, 2), back(2, 2))).toBe(54);
    expect(sharedCardCells(front(2, 2), back(8, 5))).toBe(9);
  });

  it('ignores a corner touch under the threshold', () => {
    expect(sharedCardCells(front(2, 2), back(10, 7))).toBeLessThan(
      ID_OVERLAP_MIN_CELLS,
    );
  });
});

describe('checkIdScan', () => {
  it('flags an empty scan as side_blank', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'front', frontPath: 'f', backPath: null },
      depsFor({ f: emptyGlass() }),
    );
    expect(warnings).toEqual([{ code: 'side_blank', side: 'front' }]);
  });

  it('reports only side_blank when both scans are empty', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'back', frontPath: 'f', backPath: 'b' },
      depsFor({ f: emptyGlass(), b: emptyGlass() }),
    );
    expect(warnings).toEqual([{ code: 'side_blank', side: 'back' }]);
  });

  it('flags sides placed on the same spot', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'back', frontPath: 'f', backPath: 'b' },
      depsFor({ f: front(2, 2), b: back(4, 3) }),
    );
    expect(warnings).toEqual([{ code: 'sides_overlap', side: 'back' }]);
  });

  it('flags the same side scanned twice on the same spot', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'back', frontPath: 'f', backPath: 'b' },
      depsFor({ f: front(), b: front(3) }),
    );
    expect(warnings).toEqual([{ code: 'sides_overlap', side: 'back' }]);
  });

  it('is quiet for a front and back placed apart', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'back', frontPath: 'f', backPath: 'b' },
      depsFor({ f: front(), b: back() }),
    );
    expect(warnings).toEqual([]);
  });

  it('is quiet for a single good side', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'front', frontPath: 'f', backPath: null },
      depsFor({ f: front() }),
    );
    expect(warnings).toEqual([]);
  });

  it('returns no warning when the thumbnail fails', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'front', frontPath: 'f', backPath: null },
      depsFor({}),
    );
    expect(warnings).toEqual([]);
  });

  it('returns no warning when the thumbnail hangs', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'front', frontPath: 'f', backPath: null },
      { thumbnail: () => new Promise<Uint8Array>(() => {}), timeoutMs: 20 },
    );
    expect(warnings).toEqual([]);
  });
});
