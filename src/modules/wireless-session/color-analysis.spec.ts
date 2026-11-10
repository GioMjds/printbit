import { colorAnalysisFromDocumentAnalysis } from './color-analysis';

describe('colorAnalysisFromDocumentAnalysis', () => {
  it('reports grayscale when pricing found no color page', () => {
    expect(
      colorAnalysisFromDocumentAnalysis({ colorPages: 0, pageCount: 3 }),
    ).toEqual({ hasColor: false, isGrayscale: true, sampledPages: 3 });
  });

  it('reports color as soon as pricing bills one color page', () => {
    expect(
      colorAnalysisFromDocumentAnalysis({ colorPages: 1, pageCount: 12 }),
    ).toEqual({ hasColor: true, isGrayscale: false, sampledPages: 12 });
  });

  it('defaults to color when there is no usable analysis', () => {
    const fallback = { hasColor: true, isGrayscale: false, sampledPages: 0 };
    expect(colorAnalysisFromDocumentAnalysis(null)).toEqual(fallback);
    expect(colorAnalysisFromDocumentAnalysis(undefined)).toEqual(fallback);
    expect(
      colorAnalysisFromDocumentAnalysis({
        colorPages: Number.NaN,
        pageCount: 2,
      }),
    ).toEqual(fallback);
  });
});
