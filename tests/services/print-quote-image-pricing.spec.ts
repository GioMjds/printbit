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
            a4: { baseBwPrice: 3, baseColorPrice: 18, baseImagePrice: 25, baseImageBwPrice: 10 },
            shortBond: { baseBwPrice: 3, baseColorPrice: 18, baseImagePrice: 25, baseImageBwPrice: 10 },
            longBond: { baseBwPrice: 4, baseColorPrice: 20, baseImagePrice: 30, baseImageBwPrice: 12 },
          },
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
    analysisVersion: 8,
    analyzedAt: new Date(),
    pages: [{ index: 1, isColor: true, isImagePage: true, classification: 'image' }],
  };

  const bwImageAnalysis: DocumentAnalysis = {
    fileType: 'image',
    pageCount: 1,
    totalPages: 1,
    colorPages: 0,
    bwPages: 1,
    confidence: 'high',
    analysisVersion: 8,
    analyzedAt: new Date(),
    pages: [{ index: 1, isColor: false, isImagePage: true, classification: 'bw' }],
  };

  it('bills colored image at baseImagePrice (25) in Color mode', () => {
    const result = buildPrintQuote({
      analysis: coloredImageAnalysis,
      copies: 1,
      colorMode: 'colored',
      paperSize: 'A4',
      quality: 'standard',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.billableImagePages).toBe(1);
    expect(result.quote.billableImageBwPages).toBe(0);
    expect(result.quote.requiredAmount).toBe(25);
    expect(result.quote.effectiveColorMode).toBe('colored');
  });

  it('bills colored image at baseImageBwPrice (10) when printed in Grayscale mode', () => {
    const result = buildPrintQuote({
      analysis: coloredImageAnalysis,
      copies: 1,
      colorMode: 'grayscale',
      paperSize: 'A4',
      quality: 'standard',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.billableImagePages).toBe(0);
    expect(result.quote.billableImageBwPages).toBe(1);
    expect(result.quote.requiredAmount).toBe(10);
    expect(result.quote.effectiveColorMode).toBe('grayscale');
  });

  it('bills black and white image at baseImageBwPrice (10) even if Color mode is selected', () => {
    const result = buildPrintQuote({
      analysis: bwImageAnalysis,
      copies: 1,
      colorMode: 'colored',
      paperSize: 'A4',
      quality: 'standard',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.billableImagePages).toBe(0);
    expect(result.quote.billableImageBwPages).toBe(1);
    expect(result.quote.requiredAmount).toBe(10);
    expect(result.quote.effectiveColorMode).toBe('grayscale');
  });
});
