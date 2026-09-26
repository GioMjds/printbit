jest.mock('@/services/admin', () => ({
  adminService: {
    getPricingSettings: jest.fn(() => ({
      printPerPage: 1,
      colorSurcharge: 2,
      highQualitySurcharge: 2,
    })),
    getPipelineSettings: jest.fn(() => ({
      colorDetectionEnabled: true,
    })),
  },
}));

jest.mock('@/services/db', () => ({
  ...jest.requireActual('@/services/db'),
  db: {
    data: {
      settings: {
        printLimits: { maxPagesPerSession: 30 },
        pricingEngine: {
          duplexEnabled: true,
          highQualitySurcharge: 2,
          paperProfiles: {
            a4: {
              paperCost: 0.5,
              bwPrint: { low: 1, medium: 1.5, high: 2 },
              colorPrint: { low: 2, medium: 3, high: 4 },
            },
          },
        },
      },
    },
  },
}));

import { buildPrintQuote } from '@/services/print-quote';
import type { DocumentAnalysis } from '@/services/session';

describe('Print Quote Page Range & Selection Integration', () => {
  const mockAnalysis: DocumentAnalysis = {
    fileType: 'pdf',
    analyzedAt: new Date(),
    confidence: 'high',
    totalPages: 5,
    pageCount: 5,
    colorPages: 2,
    bwPages: 3,
    pages: [
      { index: 1, isColor: false, coverage: 0.05 },
      { index: 2, isColor: true, coverage: 0.15 },
      { index: 3, isColor: false, coverage: 0.02 },
      { index: 4, isColor: true, coverage: 0.2 },
      { index: 5, isColor: false, coverage: 0.01 },
    ],
  };

  describe('Canonical PageSelection ({ mode, ranges })', () => {
    it('handles mode: all', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: { mode: 'all', ranges: [{ start: 1, end: 5 }] },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.selectedPages).toBe(5);
      expect(result.quote.pageRange).toBeNull();
    });

    it('handles mode: custom with multiple ranges', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: {
          mode: 'custom',
          ranges: [
            { start: 1, end: 2 },
            { start: 4, end: 5 },
          ],
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.selectedPages).toBe(4);
      expect(result.quote.pageRange).toBe('1-2,4-5');
      expect(result.quote.pageBreakdown.map((p) => p.pageNumber)).toEqual([
        1, 2, 4, 5,
      ]);
    });

    it('merges overlapping ranges in custom mode', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: {
          mode: 'custom',
          ranges: [
            { start: 1, end: 3 },
            { start: 2, end: 4 },
          ],
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.selectedPages).toBe(4);
      expect(result.quote.pageRange).toBe('1-4');
    });

    it('handles mode: single', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: {
          mode: 'single',
          ranges: [{ start: 2, end: 2 }],
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.selectedPages).toBe(1);
      expect(result.quote.pageRange).toBe('2');
      expect(result.quote.pageBreakdown[0].pageNumber).toBe(2);
      expect(result.quote.pageBreakdown[0].isColor).toBe(true);
    });

    it('rejects empty ranges in custom mode', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: {
          mode: 'custom',
          ranges: [],
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('Invalid custom page range');
    });
  });

  describe('Hybrid / Alternate PageSelection ({ type: custom, ranges })', () => {
    it('handles { type: custom, ranges: [...] }', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: {
          type: 'custom',
          ranges: [{ start: 2, end: 3 }],
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.selectedPages).toBe(2);
      expect(result.quote.pageRange).toBe('2-3');
    });

    it('rejects { type: custom, ranges: [] }', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: {
          type: 'custom',
          ranges: [],
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('Invalid custom page range');
    });
  });

  describe('Legacy PageSelection format', () => {
    it('handles { type: all }', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: { type: 'all' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.selectedPages).toBe(5);
      expect(result.quote.pageRange).toBeNull();
    });

    it('handles { type: single, page: 3 }', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: { type: 'single', page: 3 },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.selectedPages).toBe(1);
      expect(result.quote.pageRange).toBe('3');
    });

    it('handles { type: custom, range: "1-3" }', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: { type: 'custom', range: '1-3' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.selectedPages).toBe(3);
      expect(result.quote.pageRange).toBe('1-3');
    });

    it('handles raw string "2, 4-5"', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: '2, 4-5',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.selectedPages).toBe(3);
      expect(result.quote.pageRange).toBe('2,4-5');
    });

    it('handles null / undefined as all pages', () => {
      const result = buildPrintQuote({
        analysis: mockAnalysis,
        colorMode: 'colored',
        copies: 1,
        pageRange: undefined,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.selectedPages).toBe(5);
      expect(result.quote.pageRange).toBeNull();
    });
  });
});
