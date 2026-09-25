import { createHash } from 'node:crypto';
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

describe('buildPrintQuote - Duplex Math, Dynamic Tiers & Quote Integrity', () => {
  const tenPageBwAnalysis: DocumentAnalysis = {
    fileType: 'pdf',
    pageCount: 10,
    totalPages: 10,
    colorPages: 0,
    bwPages: 10,
    confidence: 'high',
    analysisVersion: 9,
    analyzedAt: new Date(),
    pages: Array.from({ length: 10 }, (_, i) => ({
      index: i + 1,
      isColor: false,
      coverage: 0.05,
      coverageTier: 'low' as const,
      classification: 'bw' as const,
    })),
  };

  it('quotes 10-page B&W Low document in Simplex: 10 physical sheets @ ₱1 + 10 pages @ ₱2 = ₱30', () => {
    const result = buildPrintQuote({
      analysis: tenPageBwAnalysis,
      copies: 1,
      duplex: false,
      colorMode: 'grayscale',
      paperSize: 'A4',
      quality: 'standard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.selectedPages).toBe(10);
    expect(result.quote.physicalSheets).toBe(10);
    expect(result.quote.paperCostPerSheet).toBe(1);
    expect(result.quote.paperSubtotal).toBe(10);
    expect(result.quote.printSubtotal).toBe(20);
    expect(result.quote.duplexSavings).toBe(0);
    expect(result.quote.requiredAmount).toBe(30);
    expect(result.quote.pageBreakdown).toHaveLength(10);
    expect(result.quote.pageBreakdown[0]).toEqual({
      pageNumber: 1,
      isColor: false,
      coverage: 0.05,
      coverageTier: 'low',
      printCost: 2,
    });
  });

  it('quotes 10-page B&W Low document in Duplex: 5 physical sheets @ ₱1 + 10 pages @ ₱2 = ₱25 (saving ₱5)', () => {
    const result = buildPrintQuote({
      analysis: tenPageBwAnalysis,
      copies: 1,
      duplex: true,
      colorMode: 'grayscale',
      paperSize: 'A4',
      quality: 'standard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.selectedPages).toBe(10);
    expect(result.quote.physicalSheets).toBe(5);
    expect(result.quote.paperCostPerSheet).toBe(1);
    expect(result.quote.paperSubtotal).toBe(5);
    expect(result.quote.printSubtotal).toBe(20);
    expect(result.quote.duplexSavings).toBe(5);
    expect(result.quote.requiredAmount).toBe(25);
  });

  it('bills image file containing B&W text at low B&W tier (₱3 simplex), not photo tier (₱10)', () => {
    const bwTextImageAnalysis: DocumentAnalysis = {
      fileType: 'image',
      pageCount: 1,
      totalPages: 1,
      colorPages: 0,
      bwPages: 1,
      confidence: 'high',
      analysisVersion: 9,
      analyzedAt: new Date(),
      pages: [
        {
          index: 1,
          isColor: false,
          coverage: 0.05,
          coverageTier: 'low',
          classification: 'bw',
        },
      ],
    };

    const result = buildPrintQuote({
      analysis: bwTextImageAnalysis,
      copies: 1,
      duplex: false,
      colorMode: 'colored',
      paperSize: 'A4',
      quality: 'standard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.physicalSheets).toBe(1);
    expect(result.quote.paperSubtotal).toBe(1);
    expect(result.quote.printSubtotal).toBe(2);
    expect(result.quote.requiredAmount).toBe(3); // 1 paper + 2 print
    expect(result.quote.effectiveColorMode).toBe('grayscale');
    expect(result.quote.pageBreakdown[0].coverageTier).toBe('low');
  });

  it('bills PDF containing full-page photo at very_high color tier (₱30 simplex), not standard document tier (₱18)', () => {
    const photoPdfAnalysis: DocumentAnalysis = {
      fileType: 'pdf',
      pageCount: 1,
      totalPages: 1,
      colorPages: 1,
      bwPages: 0,
      confidence: 'high',
      analysisVersion: 9,
      analyzedAt: new Date(),
      pages: [
        {
          index: 1,
          isColor: true,
          coverage: 0.85,
          coverageTier: 'very_high',
          classification: 'full_color',
        },
      ],
    };

    const result = buildPrintQuote({
      analysis: photoPdfAnalysis,
      copies: 1,
      duplex: false,
      colorMode: 'colored',
      paperSize: 'A4',
      quality: 'standard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.physicalSheets).toBe(1);
    expect(result.quote.paperSubtotal).toBe(1);
    expect(result.quote.printSubtotal).toBe(29);
    expect(result.quote.requiredAmount).toBe(30); // 1 paper + 29 print
    expect(result.quote.effectiveColorMode).toBe('colored');
    expect(result.quote.pageBreakdown[0].coverageTier).toBe('very_high');
  });

  it('generates unique quoteId, expiresAt (15m window), and tamper-proof quoteHash', () => {
    const result = buildPrintQuote({
      analysis: tenPageBwAnalysis,
      copies: 2,
      duplex: true,
      colorMode: 'grayscale',
      paperSize: 'A4',
      quality: 'standard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quote.quoteId).toBeDefined();
    expect(typeof result.quote.quoteId).toBe('string');
    expect(result.quote.quoteId.length).toBeGreaterThan(10);

    expect(result.quote.expiresAt).toBeDefined();
    const expiryDate = new Date(result.quote.expiresAt);
    expect(expiryDate.getTime()).toBeGreaterThan(Date.now());

    expect(result.quote.quoteHash).toBeDefined();
    expect(result.quote.quoteHash).toMatch(/^[a-f0-9]{64}$/);

    // Verify quoteHash matches SHA256 of expected payload
    const expectedPayload = {
      fileHash: (tenPageBwAnalysis as any).fileHash ?? tenPageBwAnalysis.fileType,
      paperSize: 'A4',
      colorMode: 'grayscale',
      copies: 2,
      duplex: true,
      pageRange: null,
      quality: 'standard',
      requiredAmount: result.quote.requiredAmount,
      pricingVersion: 9,
    };
    const expectedHash = createHash('sha256')
      .update(JSON.stringify(expectedPayload))
      .digest('hex');
    expect(result.quote.quoteHash).toBe(expectedHash);

    // Verify tampering with amount fails verification
    const tamperedPayload = { ...expectedPayload, requiredAmount: 1 };
    const tamperedHash = createHash('sha256')
      .update(JSON.stringify(tamperedPayload))
      .digest('hex');
    expect(tamperedHash).not.toBe(result.quote.quoteHash);
  });
});
