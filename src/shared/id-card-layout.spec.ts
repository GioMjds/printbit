import {
  MM_TO_PT,
  idCardSheetLayout,
  slotFractions,
  type IdCardSheetLayout,
  type IdRect,
  type IdRotation,
} from './id-card-layout';
import type { PaperSize } from './print-configuration';

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

  it.each(PAPERS)('fills the slot with a slot-sized scan on %s', (paper) => {
    const layout = idCardSheetLayout(paper, both());
    for (const side of ['front', 'back'] as const) {
      const region = layout[side]!.region;
      const slot = layout[side]!.slot;
      expect(region.x).toBeCloseTo(slot.x, 3);
      expect(region.y).toBeCloseTo(slot.y, 3);
      expect(region.width).toBeCloseTo(slot.width, 3);
      expect(region.height).toBeCloseTo(slot.height, 3);
    }
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

  it('keeps the scan centred in its slot for every rotation', () => {
    const wide = { width: 90 * MM_TO_PT, height: 60 * MM_TO_PT };
    for (const rotation of [0, 90, 180, 270] as IdRotation[]) {
      const layout = idCardSheetLayout('A4', {
        front: { region: wide, rotationDeg: rotation },
        back: { region: wide, rotationDeg: rotation },
      });
      for (const side of ['front', 'back'] as const) {
        const { region, slot } = layout[side]!;
        expect(region.x + region.width / 2).toBeCloseTo(
          slot.x + slot.width / 2,
          3,
        );
        expect(region.y + region.height / 2).toBeCloseTo(
          slot.y + slot.height / 2,
          3,
        );
        expect(layout[side]!.rotationDeg).toBe(rotation);
      }
    }
  });

  it('does not move the slot when a side is rotated', () => {
    const a = idCardSheetLayout('A4', both(0));
    const b = idCardSheetLayout('A4', both(180));
    expect(b.front!.slot).toEqual(a.front!.slot);
    expect(b.back!.slot).toEqual(a.back!.slot);
  });

  it('shrinks a full-glass scan into the slot and keeps the slot', () => {
    const fullGlass = { width: 216 * MM_TO_PT, height: 297 * MM_TO_PT };
    const normal = idCardSheetLayout('A4', both());
    const layout = idCardSheetLayout('A4', {
      front: { region: fullGlass, rotationDeg: 0 },
      back: null,
    });
    const { region, slot } = layout.front!;
    expect(region.height).toBeCloseTo(slot.height, 3);
    expect(region.width / region.height).toBeCloseTo(216 / 297, 3);
    expect(region.x + region.width / 2).toBeCloseTo(slot.x + slot.width / 2, 3);
    expect(region.y).toBeCloseTo(slot.y, 3);
    expect(slot).toEqual(normal.front!.slot);
  });

  it('keeps a cropped card at real size', () => {
    const card = { width: 92 * MM_TO_PT, height: 60 * MM_TO_PT };
    const layout = idCardSheetLayout('A4', {
      front: { region: card, rotationDeg: 90 },
      back: null,
    });
    const printed = printedMm(layout, layout.front!.region);
    expect(printed.width).toBeCloseTo(60, 3);
    expect(printed.height).toBeCloseTo(92, 3);
  });

  it('swaps the footprint of a non-square region on a quarter turn', () => {
    const wide = { width: 90 * MM_TO_PT, height: 60 * MM_TO_PT };
    const layout = idCardSheetLayout('A4', {
      front: { region: wide, rotationDeg: 90 },
      back: null,
    });
    const region = printedMm(layout, layout.front!.region);
    expect(region.width).toBeCloseTo(60, 3);
    expect(region.height).toBeCloseTo(90, 3);
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
