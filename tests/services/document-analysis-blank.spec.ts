import {
  ANALYSIS_ALGORITHM_VERSION,
  computeDocumentContentMetrics,
  PageAnalysis,
} from '../../src/services/document-analysis';
import { LOW_CONTENT_COVERAGE_THRESHOLD } from '../../src/config/document-analysis.config';

describe('Document Analysis Blank & Low Content Metrics', () => {
  it('exposes ANALYSIS_ALGORITHM_VERSION as 6', () => {
    expect(ANALYSIS_ALGORITHM_VERSION).toBe(6);
  });

  it('exposes LOW_CONTENT_COVERAGE_THRESHOLD as 0.02', () => {
    expect(LOW_CONTENT_COVERAGE_THRESHOLD).toBe(0.02);
  });

  it('identifies 100% blank document correctly from page metrics', () => {
    const pages: PageAnalysis[] = [
      {
        index: 1,
        isColor: false,
        isBlank: true,
        coverage: 0,
        contentCoverage: 0,
        classification: 'blank',
      },
      {
        index: 2,
        isColor: false,
        isBlank: true,
        coverage: 0,
        contentCoverage: 0,
        classification: 'blank',
      },
    ];

    const result = computeDocumentContentMetrics(pages, 2);

    expect(result.blankPages).toEqual([1, 2]);
    expect(result.blankPageCount).toBe(2);
    expect(result.isEntirelyBlank).toBe(true);
    expect(result.lowContentPages).toEqual([]);
    expect(result.lowContentPageCount).toBe(0);
    expect(result.hasLowContent).toBe(false);
  });

  it('identifies mixed document with blank and low content pages', () => {
    const pages: PageAnalysis[] = [
      {
        index: 1,
        isColor: false,
        isBlank: false,
        coverage: 0.15,
        contentCoverage: 0.15,
        classification: 'bw',
      },
      {
        index: 2,
        isColor: false,
        isBlank: true,
        coverage: 0,
        contentCoverage: 0,
        classification: 'blank',
      },
      {
        index: 3,
        isColor: false,
        isBlank: false,
        coverage: 0.008,
        contentCoverage: 0.008,
        classification: 'bw',
      },
    ];

    const result = computeDocumentContentMetrics(pages, 3);

    expect(result.blankPages).toEqual([2]);
    expect(result.blankPageCount).toBe(1);
    expect(result.isEntirelyBlank).toBe(false);
    expect(result.lowContentPages).toEqual([3]);
    expect(result.lowContentPageCount).toBe(1);
    expect(result.hasLowContent).toBe(true);
  });
});
