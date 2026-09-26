import {
  normalizePageSelection,
  formatPageRangeString,
  parsePageRangeString,
  type PageRange,
  type PageSelection,
} from '../../src/public/shared/page-selection';

describe('Page Selection & Range Normalization', () => {
  it('normalizes disjoint sorted ranges correctly', () => {
    const raw: PageSelection = {
      mode: 'custom',
      ranges: [
        { start: 1, end: 5 },
        { start: 7, end: 9 },
        { start: 15, end: 15 },
        { start: 22, end: 25 },
      ],
    };
    const result = normalizePageSelection(raw, 30);
    expect(result.ranges).toEqual([
      { start: 1, end: 5 },
      { start: 7, end: 9 },
      { start: 15, end: 15 },
      { start: 22, end: 25 },
    ]);
    expect(result.totalSelectedPages).toBe(13);
    expect(result.canonicalString).toBe('1-5, 7-9, 15, 22-25');
  });

  it('automatically merges overlapping ranges', () => {
    const raw: PageSelection = {
      mode: 'custom',
      ranges: [
        { start: 1, end: 5 },
        { start: 4, end: 9 },
      ],
    };
    const result = normalizePageSelection(raw, 30);
    expect(result.ranges).toEqual([{ start: 1, end: 9 }]);
    expect(result.totalSelectedPages).toBe(9);
    expect(result.hasOverlapsMerged).toBe(true);
    expect(result.canonicalString).toBe('1-9');
  });

  it('automatically merges adjacent contiguous ranges', () => {
    const raw: PageSelection = {
      mode: 'custom',
      ranges: [
        { start: 1, end: 5 },
        { start: 6, end: 9 },
      ],
    };
    const result = normalizePageSelection(raw, 30);
    expect(result.ranges).toEqual([{ start: 1, end: 9 }]);
    expect(result.totalSelectedPages).toBe(9);
  });

  it('handles inverted ranges (e.g. 8-4 -> 4-8)', () => {
    const raw: PageSelection = {
      mode: 'custom',
      ranges: [{ start: 8, end: 4 }],
    };
    const result = normalizePageSelection(raw, 30);
    expect(result.ranges).toEqual([{ start: 4, end: 8 }]);
    expect(result.totalSelectedPages).toBe(5);
  });

  it('clamps out-of-bounds endpoints to document length', () => {
    const raw: PageSelection = {
      mode: 'custom',
      ranges: [{ start: 0, end: 35 }],
    };
    const result = normalizePageSelection(raw, 30);
    expect(result.ranges).toEqual([{ start: 1, end: 30 }]);
    expect(result.totalSelectedPages).toBe(30);
  });

  it('parses legacy string format correctly', () => {
    const parsed = parsePageRangeString('1-5, 7-9, 15, 22-25', 30);
    expect(parsed).toEqual([
      { start: 1, end: 5 },
      { start: 7, end: 9 },
      { start: 15, end: 15 },
      { start: 22, end: 25 },
    ]);
  });
});
