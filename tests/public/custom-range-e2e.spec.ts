import { buildPhysicalPrintSettings } from '../../src/public/confirm/print-settings';

describe('Confirm Print Settings with Custom Ranges', () => {
  it('formats custom range selection with structured ranges', () => {
    const settings = buildPhysicalPrintSettings(
      {
        copies: 1,
        orientation: 'portrait',
        paperSize: 'A4',
        pageRange: {
          type: 'custom',
          range: '1-5, 7-9',
          ranges: [
            { start: 1, end: 5 },
            { start: 7, end: 9 },
          ],
        },
      },
      'grayscale',
    );

    expect(settings.pageRange.type).toBe('custom');
    expect((settings.pageRange as any).range).toBe('1-5, 7-9');
    expect((settings.pageRange as any).ranges).toHaveLength(2);
  });
});
