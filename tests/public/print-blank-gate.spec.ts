describe('Blank Document Gating', () => {
  function isFileEntirelyBlank(file: {
    analysis?: {
      isEntirelyBlank?: boolean;
      pages?: Array<{ isBlank?: boolean; classification?: string; coverage?: number }>;
    };
  } | null | undefined): boolean {
    if (!file) return false;
    if (file.analysis?.isEntirelyBlank === true) return true;
    const pages = file.analysis?.pages;
    if (Array.isArray(pages) && pages.length > 0) {
      return pages.every(
        (p) =>
          p.isBlank === true ||
          p.classification === 'blank' ||
          (typeof p.coverage === 'number' && p.coverage < 0.001),
      );
    }
    return false;
  }

  it('detects entirely blank document via isEntirelyBlank flag', () => {
    const file = {
      analysis: {
        isEntirelyBlank: true,
        pages: [{ isBlank: true, coverage: 0 }],
      },
    };
    expect(isFileEntirelyBlank(file)).toBe(true);
  });

  it('detects entirely blank document via page breakdown', () => {
    const file = {
      analysis: {
        pages: [
          { isBlank: true, coverage: 0 },
          { classification: 'blank', coverage: 0 },
        ],
      },
    };
    expect(isFileEntirelyBlank(file)).toBe(true);
  });

  it('returns false when document has content pages', () => {
    const mixed = {
      analysis: {
        pages: [
          { isBlank: true, coverage: 0 },
          { isBlank: false, coverage: 0.15 },
        ],
      },
    };
    expect(isFileEntirelyBlank(mixed)).toBe(false);

    const normal = {
      analysis: {
        pages: [{ isBlank: false, coverage: 0.08 }],
      },
    };
    expect(isFileEntirelyBlank(normal)).toBe(false);
  });

  it('returns false when analysis is missing or empty', () => {
    expect(isFileEntirelyBlank(null)).toBe(false);
    expect(isFileEntirelyBlank({})).toBe(false);
    expect(isFileEntirelyBlank({ analysis: {} })).toBe(false);
  });
});
