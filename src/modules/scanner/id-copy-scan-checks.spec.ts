import {
  ID_BLANK_STDDEV_THRESHOLD,
  ID_IDENTICAL_MEAN_DIFF_THRESHOLD,
  checkIdScan,
  grayStandardDeviation,
  meanAbsoluteDifference,
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

// An 85.6 x 54 mm card is about 27 x 17 cells of a 100 mm, 32-cell thumbnail.
const inCard = (x: number, y: number, shift = 0) =>
  x >= shift && x < 27 + shift && y < 17;

/** Card with a photo block on the left. */
const front = (shift = 0) =>
  thumb((x, y) => {
    if (!inCard(x, y, shift)) return LID;
    return x - shift < 8 && y >= 3 && y < 15 ? INK : CARD;
  });

/** Card with a stripe near the bottom. */
const back = () =>
  thumb((x, y) => {
    if (!inCard(x, y)) return LID;
    return y >= 12 && y < 15 && x >= 5 && x < 21 ? INK : CARD;
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

describe('meanAbsoluteDifference', () => {
  it('is 0 for equal thumbnails', () => {
    expect(meanAbsoluteDifference(front(), front())).toBe(0);
  });

  it('stays under the threshold when the same side moved one cell', () => {
    expect(meanAbsoluteDifference(front(), front(1))).toBeLessThan(
      ID_IDENTICAL_MEAN_DIFF_THRESHOLD,
    );
  });

  it('is over the threshold for two different sides', () => {
    expect(meanAbsoluteDifference(front(), back())).toBeGreaterThan(
      ID_IDENTICAL_MEAN_DIFF_THRESHOLD,
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

  it('flags the same side scanned twice', async () => {
    const warnings = await checkIdScan(
      { scannedSide: 'back', frontPath: 'f', backPath: 'b' },
      depsFor({ f: front(), b: front(1) }),
    );
    expect(warnings).toEqual([{ code: 'sides_identical', side: 'back' }]);
  });

  it('is quiet for a real front and back', async () => {
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
