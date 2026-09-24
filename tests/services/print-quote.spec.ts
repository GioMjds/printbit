import { buildPrintQuote } from '../../src/services/print-quote';
import { db } from '../../src/core/database/db';
import type { DocumentAnalysis } from '../../src/services/session';

describe('buildPrintQuote - Custom Range', () => {
  beforeAll(() => {
    db.data = {
      settings: {
        pricing: {
          printPerPage: 3,
          colorSurcharge: 15,
          highQualitySurcharge: 0,
          scanDocument: 5,
        },
        pricingEngine: {
          paperProfiles: {
            a4: { baseBwPrice: 3, baseColorPrice: 18, baseImagePrice: 25 },
            shortBond: { baseBwPrice: 3, baseColorPrice: 18, baseImagePrice: 25 },
            longBond: { baseBwPrice: 4, baseColorPrice: 20, baseImagePrice: 30 },
          },
        },
        pipelineSettings: {
          colorDetectionEnabled: true,
          documentConversionEnabled: true,
          malwareScanningEnabled: true,
        },
      },
    } as any;
  });
  const sampleAnalysis: DocumentAnalysis = {
    fileType: 'pdf',
    pageCount: 3,
    totalPages: 3,
    colorPages: 1,
    bwPages: 2,
    confidence: 'high',
    analysisVersion: 5,
    analyzedAt: new Date(),
    pages: [
      {
        index: 1,
        isColor: true,
        classification: 'full_color',
      },
      {
        index: 2,
        isColor: false,
        classification: 'bw',
      },
      {
        index: 3,
        isColor: false,
        classification: 'bw',
      },
    ],
  };

  it('downgrades effectiveColorMode to grayscale when Custom Range 2-3 contains only B&W pages', () => {
    const result = buildPrintQuote({
      analysis: sampleAnalysis,
      copies: 5,
      colorMode: 'colored',
      pageRange: { type: 'custom', range: '2-3' },
      paperSize: 'A4',
      quality: 'standard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.selectedPages).toBe(2);
    expect(result.quote.billableColorPages).toBe(0);
    expect(result.quote.billableBwPages).toBe(2);
    expect(result.quote.requiredAmount).toBe(30); // 2 pages * 3 pesos * 5 copies
    expect(result.quote.requestedColorMode).toBe('colored');
    expect(result.quote.effectiveColorMode).toBe('grayscale');
  });

  it('keeps effectiveColorMode as colored when All Pages is selected and Page 1 has color', () => {
    const result = buildPrintQuote({
      analysis: sampleAnalysis,
      copies: 5,
      colorMode: 'colored',
      pageRange: { type: 'all' },
      paperSize: 'A4',
      quality: 'standard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.selectedPages).toBe(3);
    expect(result.quote.billableColorPages).toBe(1);
    expect(result.quote.billableBwPages).toBe(2);
    // (1 * 18 + 2 * 3) * 5 = 24 * 5 = 120
    expect(result.quote.requiredAmount).toBe(120);
    expect(result.quote.requestedColorMode).toBe('colored');
    expect(result.quote.effectiveColorMode).toBe('colored');
  });

  it('keeps effectiveColorMode as colored when Custom Range includes a color page (e.g. Pages 1-2)', () => {
    const result = buildPrintQuote({
      analysis: sampleAnalysis,
      copies: 5,
      colorMode: 'colored',
      pageRange: { type: 'custom', range: '1-2' },
      paperSize: 'A4',
      quality: 'standard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.selectedPages).toBe(2);
    expect(result.quote.billableColorPages).toBe(1);
    expect(result.quote.billableBwPages).toBe(1);
    // (1 * 18 + 1 * 3) * 5 = 21 * 5 = 105
    expect(result.quote.requiredAmount).toBe(105);
    expect(result.quote.effectiveColorMode).toBe('colored');
  });

  it('forces effectiveColorMode to grayscale when user explicitly selects grayscale mode', () => {
    const result = buildPrintQuote({
      analysis: sampleAnalysis,
      copies: 5,
      colorMode: 'grayscale',
      pageRange: { type: 'all' },
      paperSize: 'A4',
      quality: 'standard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.selectedPages).toBe(3);
    expect(result.quote.billableColorPages).toBe(0);
    expect(result.quote.billableBwPages).toBe(3);
    // (3 * 3) * 5 = 45
    expect(result.quote.requiredAmount).toBe(45);
    expect(result.quote.effectiveColorMode).toBe('grayscale');
  });

  it('preserves effectiveColorMode as colored when selected custom range pages actually contain color', () => {
    const allColorAnalysis: DocumentAnalysis = {
      ...sampleAnalysis,
      pages: [
        { index: 1, isColor: true, classification: 'full_color' },
        { index: 2, isColor: true, classification: 'full_color' },
        { index: 3, isColor: true, classification: 'full_color' },
      ],
      colorPages: 3,
      bwPages: 0,
    };

    const result = buildPrintQuote({
      analysis: allColorAnalysis,
      copies: 5,
      colorMode: 'colored',
      pageRange: { type: 'custom', range: '2-3' },
      paperSize: 'A4',
      quality: 'standard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.selectedPages).toBe(2);
    expect(result.quote.billableColorPages).toBe(2);
    expect(result.quote.billableBwPages).toBe(0);
    // (2 * 18) * 5 = 180
    expect(result.quote.requiredAmount).toBe(180);
    expect(result.quote.effectiveColorMode).toBe('colored');
  });
});
