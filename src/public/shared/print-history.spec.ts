import {
  countPages,
  formatPagesLabel,
  selectionToRanges,
  takePages,
  unprintedRanges,
} from './print-history';

describe('print-history', () => {
  it('resolves page selections to merged ranges', () => {
    expect(selectionToRanges({ type: 'all' }, 50)).toEqual([{ start: 1, end: 50 }]);
    expect(selectionToRanges({ type: 'single', page: 7 }, 50)).toEqual([
      { start: 7, end: 7 },
    ]);
    expect(
      selectionToRanges({ type: 'custom', range: '5-8, 1-3, 4' }, 50),
    ).toEqual([{ start: 1, end: 8 }]);
    expect(selectionToRanges({ type: 'custom', range: '' }, 50)).toEqual([]);
  });

  it('finds pages the per-print limit left out', () => {
    expect(unprintedRanges(50, [{ start: 1, end: 30 }])).toEqual([
      { start: 31, end: 50 },
    ]);
    expect(
      unprintedRanges(10, [
        { start: 3, end: 4 },
        { start: 8, end: 10 },
      ]),
    ).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 7 },
    ]);
    expect(unprintedRanges(10, [{ start: 1, end: 10 }])).toEqual([]);
    expect(unprintedRanges(3, [])).toEqual([{ start: 1, end: 3 }]);
  });

  it('caps the next batch at the page limit', () => {
    const left = [
      { start: 31, end: 90 },
      { start: 95, end: 99 },
    ];
    expect(takePages(left, 30)).toEqual([{ start: 31, end: 60 }]);
    expect(takePages([{ start: 1, end: 2 }, { start: 5, end: 9 }], 4)).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
    expect(countPages(left)).toBe(65);
    expect(formatPagesLabel(left)).toBe('31–90, 95–99');
  });
});
