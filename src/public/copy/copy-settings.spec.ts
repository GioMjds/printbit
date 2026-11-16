import {
  DEFAULT_COPY_SETTINGS,
  copiesLimits,
  parseCopySettings,
  parsePaperSize,
  serializeCopySettings,
  stepCopies,
} from './copy-settings';

describe('parsePaperSize', () => {
  it.each([
    ['A4', 'A4'],
    ['Short', 'Short'],
    ['Long', 'Long'],
    ['Letter', 'Short'],
    ['Legal', 'Long'],
    ['B5', null],
    [42, null],
  ])('reads %p as %p', (value, expected) => {
    expect(parsePaperSize(value)).toBe(expected);
  });
});

describe('parseCopySettings', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(DEFAULT_COPY_SETTINGS).toEqual({
      paperSize: 'A4',
      colorMode: 'colored',
      quality: 'standard',
      copies: 1,
    });
    expect(parseCopySettings(null)).toEqual(DEFAULT_COPY_SETTINGS);
  });

  it('returns the defaults for text that is not JSON', () => {
    expect(parseCopySettings('not json')).toEqual(DEFAULT_COPY_SETTINGS);
  });

  it('reads stored settings', () => {
    const stored = {
      paperSize: 'Long',
      colorMode: 'grayscale',
      quality: 'high',
      copies: 4,
    };
    expect(parseCopySettings(JSON.stringify(stored))).toEqual(stored);
  });

  it('falls back field by field', () => {
    const raw = JSON.stringify({
      paperSize: 'B5',
      colorMode: 'grayscale',
      quality: 'ultra',
      copies: 'many',
    });
    expect(parseCopySettings(raw)).toEqual({
      paperSize: 'A4',
      colorMode: 'grayscale',
      quality: 'standard',
      copies: 1,
    });
  });

  it('clamps stored copies', () => {
    expect(parseCopySettings(JSON.stringify({ copies: 99 })).copies).toBe(30);
  });

  it('round-trips through serializeCopySettings', () => {
    const settings = {
      paperSize: 'Short' as const,
      colorMode: 'grayscale' as const,
      quality: 'high' as const,
      copies: 7,
    };
    expect(parseCopySettings(serializeCopySettings(settings))).toEqual(
      settings,
    );
  });
});

describe('stepCopies', () => {
  it.each([
    [1, -1, 1],
    [1, 1, 2],
    [30, 1, 30],
  ])('steps %p by %p to %p', (copies, delta, expected) => {
    expect(stepCopies(copies, delta as 1 | -1)).toBe(expected);
  });
});

describe('copiesLimits', () => {
  it.each([
    [1, false, true],
    [5, true, true],
    [30, true, false],
  ])('for %p copies: decrease %p, increase %p', (copies, down, up) => {
    expect(copiesLimits(copies)).toEqual({
      canDecrease: down,
      canIncrease: up,
    });
  });
});
