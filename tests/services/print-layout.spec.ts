import { calculatePrintLayout } from '../../src/shared/print-configuration';

describe('physical page layout', () => {
  it('fits Letter into its safe inset and centers it without stretching', () => {
    const layout = calculatePrintLayout(612, 792, { paperSize: 'Letter', orientation: 'portrait', scaling: 'fit', rotationDeg: 0 });
    expect(layout.width).toBe(612);
    expect(layout.height).toBe(792);
    expect(layout.scale).toBeCloseTo(0.9529411765);
    expect(layout.x).toBeCloseTo(14.4);
    expect(layout.y).toBeCloseTo(18.6352941);
  });
  it('fits after a quarter turn rather than shrinking an already fitted page', () => {
    const layout = calculatePrintLayout(612, 792, { paperSize: 'Letter', orientation: 'landscape', scaling: 'fit', rotationDeg: 90 });
    expect(layout.scale).toBeCloseTo(0.9529411765);
    expect(layout.width).toBe(792);
    expect(layout.height).toBe(612);
  });
  it('does not resize actual-size content larger than the target', () => {
    const layout = calculatePrintLayout(612, 1008, { paperSize: 'Letter', orientation: 'portrait', scaling: 'actual', rotationDeg: 0 });
    expect(layout.scale).toBe(1);
    expect(layout.y).toBe(-108);
  });
});
