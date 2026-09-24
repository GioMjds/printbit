import { hasVisibleGlyphs } from '../../src/services/document-analysis';

describe('hasVisibleGlyphs', () => {
  it('returns false for space glyphs with colored style', () => {
    const spaceGlyph = [
      [
        {
          originalCharCode: 32,
          fontChar: ' ',
          unicode: ' ',
          accent: null,
          width: 320,
          isSpace: true,
          isInFont: false,
        },
      ],
    ];
    expect(hasVisibleGlyphs(spaceGlyph)).toBe(false);
  });

  it('returns false for whitespace strings and empty arrays', () => {
    expect(hasVisibleGlyphs([['   ']])).toBe(false);
    expect(hasVisibleGlyphs([[]])).toBe(false);
    expect(hasVisibleGlyphs(null)).toBe(false);
  });

  it('returns true for visible characters', () => {
    const textGlyph = [
      [
        {
          originalCharCode: 49,
          fontChar: '1',
          unicode: '1',
          accent: null,
          width: 620,
          isSpace: false,
          isInFont: true,
        },
      ],
    ];
    expect(hasVisibleGlyphs(textGlyph)).toBe(true);
    expect(hasVisibleGlyphs([['Hello World']])).toBe(true);
  });
});
