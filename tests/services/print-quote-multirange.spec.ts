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
              bwPrint: { low: 1, medium: 1.5, high: 2, very_high: 2.5 },
              colorPrint: { low: 2, medium: 3, high: 4, very_high: 5 },
            },
          },
        },
      },
    },
  },
}));

import { buildPrintQuote } from '../../src/services/print-quote';
import type { DocumentAnalysis } from '../../src/services/session';

describe('Multi-range Print Quote Calculation', () => {
  const sampleAnalysis: DocumentAnalysis = {
    fileType: 'pdf',
    pageCount: 30,
    totalPages: 30,
    colorPages: 0,
    bwPages: 30,
    confidence: 'high',
    analyzedAt: new Date(),
    pages: Array.from({ length: 30 }, (_, i) => ({
      index: i + 1,
      pageNumber: i + 1,
      isColor: false,
      colorPixelCount: 0,
      totalPixelCount: 1000,
      coverage: 0.05,
      coverageTier: 'low',
      hasGraphics: false,
      isBlank: false,
      classification: 'bw',
    })),
  };

  it('calculates billable pages and sheets for multi-range selection', () => {
    const quoteComputation = buildPrintQuote({
      analysis: sampleAnalysis,
      copies: 1,
      colorMode: 'grayscale',
      quality: 'standard',
      paperSize: 'A4',
      duplex: false,
      pageRange: {
        mode: 'custom',
        ranges: [
          { start: 1, end: 5 },
          { start: 7, end: 9 },
        ],
      },
    });

    expect(quoteComputation.ok).toBe(true);
    if (!quoteComputation.ok) return;
    expect(quoteComputation.quote.selectedPages).toBe(8);
    expect(quoteComputation.quote.totalPages).toBe(30);
    expect(quoteComputation.quote.physicalSheets).toBe(8);
  });

  it('calculates duplex sheets for multi-range selection correctly', () => {
    const quoteComputation = buildPrintQuote({
      analysis: sampleAnalysis,
      copies: 2,
      colorMode: 'grayscale',
      quality: 'standard',
      paperSize: 'A4',
      duplex: true,
      pageRange: {
        mode: 'custom',
        ranges: [
          { start: 1, end: 5 }, // 5 pages
          { start: 7, end: 9 }, // 3 pages = 8 pages total
        ],
      },
    });

    expect(quoteComputation.ok).toBe(true);
    if (!quoteComputation.ok) return;
    expect(quoteComputation.quote.selectedPages).toBe(8);
    // 8 pages duplex = 4 sheets * 2 copies = 8 sheets
    expect(quoteComputation.quote.physicalSheets).toBe(8);
  });
});
