import { idCardSheetLayout, type IdRotation } from './id-card-layout';
import { PAPER_POINTS, type PaperSize } from './print-configuration';

const PAPERS: PaperSize[] = ['A4', 'Short', 'Long'];
/** Full EPSON L5290 glass, 216 x 297 mm, in points. */
const GLASS = { width: 612, height: 842 };

describe('idCardSheetLayout', () => {
  it.each(PAPERS)('fits a full-glass scan inside %s, centred', (paper) => {
    const [pageWidth, pageHeight] = PAPER_POINTS[paper];
    const layout = idCardSheetLayout(paper, {
      front: { region: GLASS, rotationDeg: 0 },
      back: null,
    });
    const { region } = layout.front!;
    expect(region.x).toBeGreaterThanOrEqual(-0.001);
    expect(region.y).toBeGreaterThanOrEqual(-0.001);
    expect(region.x + region.width).toBeLessThanOrEqual(pageWidth + 0.001);
    expect(region.y + region.height).toBeLessThanOrEqual(pageHeight + 0.001);
    expect(region.x + region.width / 2).toBeCloseTo(pageWidth / 2, 3);
    expect(region.y + region.height / 2).toBeCloseTo(pageHeight / 2, 3);
    expect(region.width / region.height).toBeCloseTo(612 / 842, 3);
  });

  it('puts both sides at the same place, so they stack like a double copy', () => {
    const layout = idCardSheetLayout('A4', {
      front: { region: GLASS, rotationDeg: 0 },
      back: { region: GLASS, rotationDeg: 0 },
    });
    expect(layout.back!.region).toEqual(layout.front!.region);
  });

  it('swaps the footprint on a quarter turn', () => {
    for (const rotation of [90, 270] as IdRotation[]) {
      const layout = idCardSheetLayout('A4', {
        front: { region: GLASS, rotationDeg: rotation },
        back: null,
      });
      const { region } = layout.front!;
      expect(region.width / region.height).toBeCloseTo(842 / 612, 3);
      expect(layout.front!.rotationDeg).toBe(rotation);
    }
  });

  it('returns null for a side that is not scanned', () => {
    const layout = idCardSheetLayout('A4', {
      front: { region: GLASS, rotationDeg: 0 },
      back: null,
    });
    expect(layout.front).not.toBeNull();
    expect(layout.back).toBeNull();
  });
});
