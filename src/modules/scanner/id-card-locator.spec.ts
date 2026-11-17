import { MM_TO_PT } from '@/shared/id-card-layout';
import {
  ID_LOCATE_PADDING_MM,
  findCardBox,
  locateIdCard,
  pixelBoxToPagePoints,
  type GrayImage,
  type RenderedScan,
} from './id-card-locator';

const PX_PER_MM = 2;
const GLASS = { widthMm: 216, heightMm: 297 };

/** A light-gray glass with dark rectangles drawn on it, all in mm. */
function glassWith(
  rects: Array<{ x: number; y: number; w: number; h: number; gray?: number }>,
): GrayImage {
  const width = GLASS.widthMm * PX_PER_MM;
  const height = GLASS.heightMm * PX_PER_MM;
  const data = new Uint8Array(width * height).fill(235);
  for (const rect of rects) {
    for (let y = rect.y * PX_PER_MM; y < (rect.y + rect.h) * PX_PER_MM; y += 1) {
      for (let x = rect.x * PX_PER_MM; x < (rect.x + rect.w) * PX_PER_MM; x += 1) {
        data[y * width + x] = rect.gray ?? 60;
      }
    }
  }
  return { data, width, height };
}

function inMm(box: { x: number; y: number; width: number; height: number }) {
  return {
    x: box.x / PX_PER_MM,
    y: box.y / PX_PER_MM,
    width: box.width / PX_PER_MM,
    height: box.height / PX_PER_MM,
  };
}

describe('findCardBox', () => {
  it.each([
    { x: 0, y: 0 },
    { x: 100, y: 40 },
    { x: 20, y: 210 },
    { x: 120, y: 230 },
  ])('finds a card placed at ($x, $y) mm', ({ x, y }) => {
    const box = findCardBox(glassWith([{ x, y, w: 86, h: 54 }]), PX_PER_MM);
    expect(box).not.toBeNull();
    const mm = inMm(box!);
    // The box holds the whole card, padded but never past the glass.
    expect(mm.x).toBeLessThanOrEqual(x);
    expect(mm.y).toBeLessThanOrEqual(y);
    expect(mm.x + mm.width).toBeGreaterThanOrEqual(x + 86);
    expect(mm.y + mm.height).toBeGreaterThanOrEqual(y + 54);
    expect(mm.width).toBeLessThanOrEqual(86 + 2 * ID_LOCATE_PADDING_MM + 4);
    expect(mm.height).toBeLessThanOrEqual(54 + 2 * ID_LOCATE_PADDING_MM + 4);
  });

  it('finds a card turned on its side', () => {
    const box = findCardBox(
      glassWith([{ x: 60, y: 100, w: 54, h: 86 }]),
      PX_PER_MM,
    );
    const mm = inMm(box!);
    expect(mm.height).toBeGreaterThan(mm.width);
  });

  it('does not find a white card on a white lid', () => {
    const box = findCardBox(
      glassWith([{ x: 50, y: 50, w: 86, h: 54, gray: 255 }]),
      PX_PER_MM,
    );
    // 255 vs 235 is within the gray delta: a white card on a white lid is not
    // found, and the merge falls back to the whole scan.
    expect(box).toBeNull();
  });

  it('ignores dust and keeps the card', () => {
    const box = findCardBox(
      glassWith([
        { x: 10, y: 10, w: 3, h: 3 },
        { x: 200, y: 280, w: 4, h: 2 },
        { x: 90, y: 150, w: 86, h: 54 },
      ]),
      PX_PER_MM,
    );
    const mm = inMm(box!);
    expect(mm.x).toBeGreaterThan(80);
    expect(mm.y).toBeGreaterThan(140);
  });

  it('returns null for empty glass', () => {
    expect(findCardBox(glassWith([]), PX_PER_MM)).toBeNull();
  });

  it('returns null when only small marks are present', () => {
    expect(
      findCardBox(glassWith([{ x: 40, y: 40, w: 20, h: 20 }]), PX_PER_MM),
    ).toBeNull();
  });
});

describe('pixelBoxToPagePoints', () => {
  it('flips to a bottom-left origin', () => {
    const scan: RenderedScan = {
      data: new Uint8Array(0),
      width: 432,
      height: 594,
      pageWidthPt: 216 * MM_TO_PT,
      pageHeightPt: 297 * MM_TO_PT,
    };
    const rect = pixelBoxToPagePoints(
      { x: 0, y: 0, width: 172, height: 108 },
      scan,
    );
    expect(rect.x).toBeCloseTo(0, 3);
    expect(rect.width).toBeCloseTo(86 * MM_TO_PT, 3);
    expect(rect.height).toBeCloseTo(54 * MM_TO_PT, 3);
    expect(rect.y + rect.height).toBeCloseTo(297 * MM_TO_PT, 3);
  });
});

describe('locateIdCard', () => {
  it('returns the card box in page points', async () => {
    const image = glassWith([{ x: 100, y: 200, w: 86, h: 54 }]);
    const rect = await locateIdCard('scan.pdf', async () => ({
      ...image,
      pageWidthPt: GLASS.widthMm * MM_TO_PT,
      pageHeightPt: GLASS.heightMm * MM_TO_PT,
    }));
    expect(rect).not.toBeNull();
    const leftMm = rect!.x / MM_TO_PT;
    const topMm = GLASS.heightMm - (rect!.y + rect!.height) / MM_TO_PT;
    expect(leftMm).toBeLessThanOrEqual(100);
    expect(leftMm).toBeGreaterThan(90);
    expect(topMm).toBeLessThanOrEqual(200);
    expect(topMm).toBeGreaterThan(190);
  });

  it('returns null when no card stands out', async () => {
    const image = glassWith([]);
    await expect(
      locateIdCard('scan.pdf', async () => ({
        ...image,
        pageWidthPt: GLASS.widthMm * MM_TO_PT,
        pageHeightPt: GLASS.heightMm * MM_TO_PT,
      })),
    ).resolves.toBeNull();
  });
});
