import {
  ID_CARD_HEIGHT_MM,
  ID_CARD_WIDTH_MM,
  MM_TO_PT,
  idCardSheetLayout,
  slotFractions,
  type IdCardSheetLayout,
  type IdRect,
  type IdRotation,
} from './id-card-layout';
import { PAPER_POINTS, type PaperSize } from './print-configuration';

const PAPERS: PaperSize[] = ['A4', 'Short', 'Long'];
const SQUARE = { width: 100 * MM_TO_PT, height: 100 * MM_TO_PT };

/** Where a sheet rectangle lands on paper after fit scaling, in mm from the top-left. */
function printedMm(layout: IdCardSheetLayout, rect: IdRect) {
  const cx = layout.pageWidth / 2;
  const cy = layout.pageHeight / 2;
  const leftPt = cx + (rect.x - cx) * layout.fitScale;
  const topDownPt = layout.pageHeight - (rect.y + rect.height);
  const topPt = cy + (topDownPt - cy) * layout.fitScale;
  return {
    x: leftPt / MM_TO_PT,
    y: topPt / MM_TO_PT,
    width: (rect.width * layout.fitScale) / MM_TO_PT,
    height: (rect.height * layout.fitScale) / MM_TO_PT,
  };
}

function both(rotationDeg: IdRotation = 0) {
  return {
    front: { region: SQUARE, rotationDeg },
    back: { region: SQUARE, rotationDeg },
  };
}

describe('idCardSheetLayout', () => {
  it.each(PAPERS)('prints the scan region at real size on %s', (paper) => {
    const layout = idCardSheetLayout(paper, both());
    const front = printedMm(layout, layout.front!.region);
    expect(front.width).toBeCloseTo(100, 3);
    expect(front.height).toBeCloseTo(100, 3);
  });

  it.each(PAPERS)('centres the card horizontally on %s', (paper) => {
    const layout = idCardSheetLayout(paper, both());
    const paperWidthMm = PAPER_POINTS[paper][0] / MM_TO_PT;
    const front = printedMm(layout, layout.front!.region);
    expect(front.x).toBeCloseTo((paperWidthMm - ID_CARD_WIDTH_MM) / 2, 3);
  });

  it.each(PAPERS)('keeps both slots on the page and apart on %s', (paper) => {
    const layout = idCardSheetLayout(paper, both());
    const front = layout.front!.slot;
    const back = layout.back!.slot;
    for (const slot of [front, back]) {
      expect(slot.x).toBeGreaterThanOrEqual(0);
      expect(slot.y).toBeGreaterThanOrEqual(0);
      expect(slot.x + slot.width).toBeLessThanOrEqual(layout.pageWidth);
      expect(slot.y + slot.height).toBeLessThanOrEqual(layout.pageHeight);
    }
    // PDF y grows upward: the front slot sits above the back slot.
    expect(front.y).toBeGreaterThanOrEqual(back.y + back.height);
  });

  it('puts the card at the same printed place for every rotation', () => {
    const base = idCardSheetLayout('A4', both(0));
    const baseRegion = printedMm(base, base.front!.region);
    const slack = { x: 100 - ID_CARD_WIDTH_MM, y: 100 - ID_CARD_HEIGHT_MM };
    const expected: Record<IdRotation, { dx: number; dy: number }> = {
      0: { dx: 0, dy: 0 },
      90: { dx: -slack.x, dy: 0 },
      180: { dx: -slack.x, dy: -slack.y },
      270: { dx: 0, dy: -slack.y },
    };
    for (const rotation of [0, 90, 180, 270] as IdRotation[]) {
      const layout = idCardSheetLayout('A4', both(rotation));
      const region = printedMm(layout, layout.front!.region);
      expect(region.x - baseRegion.x).toBeCloseTo(expected[rotation].dx, 3);
      expect(region.y - baseRegion.y).toBeCloseTo(expected[rotation].dy, 3);
      expect(layout.front!.rotationDeg).toBe(rotation);
    }
  });

  it('does not move the slot when a side is rotated', () => {
    const a = idCardSheetLayout('A4', both(0));
    const b = idCardSheetLayout('A4', both(180));
    expect(b.front!.slot).toEqual(a.front!.slot);
    expect(b.back!.slot).toEqual(a.back!.slot);
  });

  it('anchors a full-glass scan at the card corner and keeps the slot', () => {
    const fullGlass = { width: 216 * MM_TO_PT, height: 297 * MM_TO_PT };
    const normal = idCardSheetLayout('A4', both());
    const layout = idCardSheetLayout('A4', {
      front: { region: fullGlass, rotationDeg: 0 },
      back: null,
    });
    const region = printedMm(layout, layout.front!.region);
    const normalRegion = printedMm(normal, normal.front!.region);
    expect(region.x).toBeCloseTo(normalRegion.x, 3);
    expect(region.y).toBeCloseTo(normalRegion.y, 3);
    expect(region.width).toBeCloseTo(216, 3);
    expect(layout.front!.slot).toEqual(normal.front!.slot);
  });

  it('swaps the footprint of a non-square region on a quarter turn', () => {
    const wide = { width: 120 * MM_TO_PT, height: 80 * MM_TO_PT };
    const layout = idCardSheetLayout('A4', {
      front: { region: wide, rotationDeg: 90 },
      back: null,
    });
    const region = printedMm(layout, layout.front!.region);
    expect(region.width).toBeCloseTo(80, 3);
    expect(region.height).toBeCloseTo(120, 3);
  });

  it('returns null for a side that is not scanned', () => {
    const layout = idCardSheetLayout('A4', {
      front: { region: SQUARE, rotationDeg: 0 },
      back: null,
    });
    expect(layout.front).not.toBeNull();
    expect(layout.back).toBeNull();
  });
});

describe('slotFractions', () => {
  it.each(PAPERS)(
    'stays inside the sheet with back below front on %s',
    (paper) => {
      const front = slotFractions(paper, 'front');
      const back = slotFractions(paper, 'back');
      for (const slot of [front, back]) {
        expect(slot.left).toBeGreaterThan(0);
        expect(slot.top).toBeGreaterThan(0);
        expect(slot.left + slot.width).toBeLessThan(1);
        expect(slot.top + slot.height).toBeLessThan(1);
      }
      expect(back.top).toBeGreaterThan(front.top + front.height);
    },
  );
});
