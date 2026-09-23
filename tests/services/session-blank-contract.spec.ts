import { DocumentAnalysis } from '../../src/services/session';

describe('Session DocumentAnalysis Contract', () => {
  it('supports blank and low content summary properties', () => {
    const analysis: DocumentAnalysis = {
      analysisVersion: 5,
      fileType: 'pdf',
      pageCount: 3,
      pages: [
        { index: 1, isColor: false, isBlank: false, coverage: 0.1 },
        { index: 2, isColor: false, isBlank: true, coverage: 0 },
        { index: 3, isColor: false, isBlank: false, coverage: 0.01 },
      ],
      colorPages: 0,
      bwPages: 3,
      totalPages: 3,
      confidence: 'high',
      analyzedAt: new Date(),
      blankPages: [2],
      blankPageCount: 1,
      isEntirelyBlank: false,
      lowContentPages: [3],
      lowContentPageCount: 1,
      hasLowContent: true,
    };

    expect(analysis.blankPages).toEqual([2]);
    expect(analysis.blankPageCount).toBe(1);
    expect(analysis.isEntirelyBlank).toBe(false);
    expect(analysis.lowContentPages).toEqual([3]);
    expect(analysis.lowContentPageCount).toBe(1);
    expect(analysis.hasLowContent).toBe(true);
  });

  it('safely types 100% blank document analysis', () => {
    const blankAnalysis: DocumentAnalysis = {
      analysisVersion: 5,
      fileType: 'pdf',
      pageCount: 1,
      pages: [{ index: 1, isColor: false, isBlank: true, coverage: 0 }],
      colorPages: 0,
      bwPages: 1,
      totalPages: 1,
      confidence: 'high',
      analyzedAt: new Date(),
      blankPages: [1],
      blankPageCount: 1,
      isEntirelyBlank: true,
      lowContentPages: [],
      lowContentPageCount: 0,
      hasLowContent: false,
    };

    expect(blankAnalysis.isEntirelyBlank).toBe(true);
    expect(blankAnalysis.blankPageCount).toBe(1);
    expect(blankAnalysis.hasLowContent).toBe(false);
  });
});
