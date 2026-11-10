import {
  PAPER_POINTS,
  PRINT_MARGIN_POINTS,
  type PrintLayoutConfiguration,
} from '../../shared/print-configuration';
import {
  computeSheetRender,
  defaultCopyLayout,
  fitSheetInBox,
  paintPageOnSheet,
} from './print-preview-sheet';

const LONG: PrintLayoutConfiguration = {
  paperSize: 'Long',
  scaling: 'fit',
  orientation: 'portrait',
  rotationDeg: 0,
};

describe('computeSheetRender', () => {
  it('sizes the canvas to the sheet, not to the source page', () => {
    const render = computeSheetRender(612, 936, LONG, 306, 468, 2);

    expect(render.canvasWidth).toBe(612);
    expect(render.canvasHeight).toBe(936);
  });

  it('insets a full-bleed scan by the print margin, like the printed page', () => {
    // A Long scan (612x936 pt) on Long paper, sheet drawn at 1 px per point.
    const render = computeSheetRender(612, 936, LONG, 612, 936, 1);

    const drawnWidth = 612 * render.renderScale;
    const drawnHeight = 936 * render.renderScale;
    expect(drawnWidth).toBeCloseTo(612 - 2 * PRINT_MARGIN_POINTS, 5);
    expect(drawnHeight).toBeLessThanOrEqual(936 - 2 * PRINT_MARGIN_POINTS + 1e-6);
    expect(render.renderScale).toBeLessThan(1);
  });

  it('scales with the device pixel ratio and the sheet width', () => {
    const base = computeSheetRender(612, 936, LONG, 612, 936, 1);
    const doubled = computeSheetRender(612, 936, LONG, 306, 468, 4);

    expect(doubled.renderScale).toBeCloseTo(base.renderScale * 2, 6);
  });

  it('reports the rotation in radians', () => {
    const render = computeSheetRender(
      612,
      936,
      { ...LONG, rotationDeg: 90 },
      612,
      936,
      1,
    );

    expect(render.rotationRad).toBeCloseTo(Math.PI / 2, 10);
  });
});

describe('fitSheetInBox', () => {
  it('keeps the paper aspect ratio inside a wide box', () => {
    const [w, h] = PAPER_POINTS.A4;
    const sheet = fitSheetInBox(w, h, 2000, 800);

    expect(sheet.height).toBeCloseTo(800, 6);
    expect(sheet.width / sheet.height).toBeCloseTo(w / h, 6);
  });

  it('keeps the paper aspect ratio inside a tall box', () => {
    const [w, h] = PAPER_POINTS.Long;
    const sheet = fitSheetInBox(w, h, 300, 4000);

    expect(sheet.width).toBeCloseTo(300, 6);
    expect(sheet.width / sheet.height).toBeCloseTo(w / h, 6);
  });
});

describe('defaultCopyLayout', () => {
  it('uses the selected paper, fit scaling and no rotation', () => {
    expect(defaultCopyLayout('Short', 612, 792)).toEqual({
      paperSize: 'Short',
      scaling: 'fit',
      orientation: 'portrait',
      rotationDeg: 0,
    });
  });

  it('turns the sheet for a landscape scan', () => {
    expect(defaultCopyLayout('A4', 842, 595).orientation).toBe('landscape');
  });
});

describe('paintPageOnSheet', () => {
  it('fills the sheet white and draws the page centered and rotated', () => {
    const calls: unknown[][] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push([name, ...args]);
    const ctx = {
      fillStyle: '',
      fillRect: record('fillRect'),
      save: record('save'),
      translate: record('translate'),
      rotate: record('rotate'),
      drawImage: record('drawImage'),
      restore: record('restore'),
    };
    const source = { id: 'source' };

    paintPageOnSheet(
      ctx as unknown as CanvasRenderingContext2D,
      { width: 600, height: 900 },
      source as unknown as CanvasImageSource,
      400,
      500,
      Math.PI / 2,
    );

    expect(ctx.fillStyle).toBe('#fff');
    expect(calls).toEqual([
      ['fillRect', 0, 0, 600, 900],
      ['save'],
      ['translate', 300, 450],
      ['rotate', Math.PI / 2],
      ['drawImage', source, -200, -250, 400, 500],
      ['restore'],
    ]);
  });
});
