import { buildPrintQuote } from '../../src/services/print-quote';
import { db } from '../../src/core/database/db';
import type { DocumentAnalysis } from '../../src/services/session';

describe('buildPrintQuote - Image Color vs Image B/W Pricing', () => {
  beforeAll(() => {
    db.data = {
      settings: {
        pricing: { scanDocument: 5 },
        pricingEngine: {
          paperProfiles: {
            a4: {
              paperCost: 1,
              bwPrint: { low: 2, medium: 3, high: 6, very_high: 9 },
              colorPrint: { low: 17, medium: 19, high: 24, very_high: 29 },
            },
            shortBond: {
              paperCost: 1,
              bwPrint: { low: 2, medium: 3, high: 6, very_high: 9 },
              colorPrint: { low: 17, medium: 19, high: 24, very_high: 29 },
            },
            longBond: {
              paperCost: 1,
              bwPrint: { low: 3, medium: 4, high: 8, very_high: 11 },
              colorPrint: { low: 19, medium: 22, high: 29, very_high: 34 },
            },
          },
          highQualitySurcharge: 2,
        },
        pipelineSettings: { colorDetectionEnabled: true },
      },
    } as any;
  });

  const coloredImageAnalysis: DocumentAnalysis = {
    fileType: 'image',
    pageCount: 1,
    totalPages: 1,
    colorPages: 1,
    bwPages: 0,
    confidence: 'high',
    analysisVersion: 9,
    analyzedAt: new Date(),
    pages: [{
      index: 1,
      isColor: true,
      coverage: 0.85,
      coverageTier: 'very_high',
      classification: 'image',
    }],
  };

  const bwImageAnalysis: DocumentAnalysis = {
    fileType: 'image',
    pageCount: 1,
    totalPages: 1,
    colorPages: 0,
    bwPages: 1,
    confidence: 'high',
    analysisVersion: 9,
    analyzedAt: new Date(),
    pages: [{
      index: 1,
      isColor: false,
      coverage: 0.85,
      coverageTier: 'very_high',
      classification: 'bw',
    }],
  };

  it('bills colored photo image at very_high color tier (30 = 1 paper + 29 print) in Color mode', () => {
    const result = buildPrintQuote({
      analysis: coloredImageAnalysis,
      copies: 1,
      colorMode: 'colored',
      paperSize: 'A4',
      quality: 'standard',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.physicalSheets).toBe(1);
    expect(result.quote.paperSubtotal).toBe(1);
    expect(result.quote.printSubtotal).toBe(29);
    expect(result.quote.requiredAmount).toBe(30);
    expect(result.quote.effectiveColorMode).toBe('colored');
    expect(result.quote.pageBreakdown[0].coverageTier).toBe('very_high');
  });

  it('bills colored photo image at very_high B/W tier (10 = 1 paper + 9 print) when printed in Grayscale mode', () => {
    const result = buildPrintQuote({
      analysis: coloredImageAnalysis,
      copies: 1,
      colorMode: 'grayscale',
      paperSize: 'A4',
      quality: 'standard',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.physicalSheets).toBe(1);
    expect(result.quote.paperSubtotal).toBe(1);
    expect(result.quote.printSubtotal).toBe(9);
    expect(result.quote.requiredAmount).toBe(10);
    expect(result.quote.effectiveColorMode).toBe('grayscale');
    expect(result.quote.pageBreakdown[0].coverageTier).toBe('very_high');
  });

  it('bills black and white photo image at very_high B/W tier (10 = 1 paper + 9 print) even if Color mode is selected', () => {
    const result = buildPrintQuote({
      analysis: bwImageAnalysis,
      copies: 1,
      colorMode: 'colored',
      paperSize: 'A4',
      quality: 'standard',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.physicalSheets).toBe(1);
    expect(result.quote.paperSubtotal).toBe(1);
    expect(result.quote.printSubtotal).toBe(9);
    expect(result.quote.requiredAmount).toBe(10);
    expect(result.quote.effectiveColorMode).toBe('grayscale');
    expect(result.quote.pageBreakdown[0].coverageTier).toBe('very_high');
  });
});
