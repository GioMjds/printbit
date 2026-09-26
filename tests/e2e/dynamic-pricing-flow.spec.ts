import { buildPrintQuote, verifyQuoteHash } from '../../src/services/print-quote';
import { db } from '../../src/core/database/db';
import type { DocumentAnalysis } from '../../src/services/session';

describe('Dynamic Pricing Engine - End-to-End Flow', () => {
  beforeAll(async () => {
    await db.read();
    db.data = {
      settings: {
        pricing: {
          printPerPage: 3,
          colorSurcharge: 15,
          highQualitySurcharge: 0,
          scanDocument: 5,
        },
        pricingEngine: {
          duplexEnabled: true,
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
      } as any,
    } as any;
  });

  describe('1. File Format Agnostic Pricing: JPG photo vs DOCX containing full photo', () => {
    it('prices standalone JPG photo and DOCX-embedded full-page photo identically', () => {
      // Standalone JPG photo analysis
      const jpgPhotoAnalysis: DocumentAnalysis = {
        pageCount: 1,
        colorPages: 1,
        bwPages: 0,
        totalPages: 1,
        confidence: 'high',
        analyzedAt: new Date(),
        fileType: 'image',
        pages: [
          {
            index: 1,
            isColor: true,
            coverage: 0.85,
            coverageTier: 'very_high',
          },
        ],
      };

      // DOCX document containing a full-page photo converted to PDF
      const docxPhotoAnalysis: DocumentAnalysis = {
        pageCount: 1,
        colorPages: 1,
        bwPages: 0,
        totalPages: 1,
        confidence: 'high',
        analyzedAt: new Date(),
        fileType: 'docx',
        pages: [
          {
            index: 1,
            isColor: true,
            coverage: 0.85,
            coverageTier: 'very_high',
          },
        ],
      };

      const quoteJpg = buildPrintQuote({
        analysis: jpgPhotoAnalysis,
        copies: 1,
        colorMode: 'colored',
        quality: 'standard',
        paperSize: 'A4',
        pageRange: { type: 'all' },
        duplex: false,
      });

      const quoteDocx = buildPrintQuote({
        analysis: docxPhotoAnalysis,
        copies: 1,
        colorMode: 'colored',
        quality: 'standard',
        paperSize: 'A4',
        pageRange: { type: 'all' },
        duplex: false,
      });

      expect(quoteJpg.ok).toBe(true);
      expect(quoteDocx.ok).toBe(true);

      if (quoteJpg.ok && quoteDocx.ok) {
        // Both must be billed identically: ₱1 paperCost + ₱29 very_high colorPrint = ₱30
        expect(quoteJpg.quote.requiredAmount).toBe(30);
        expect(quoteDocx.quote.requiredAmount).toBe(30);

        expect(quoteJpg.quote.paperSubtotal).toBe(1);
        expect(quoteDocx.quote.paperSubtotal).toBe(1);

        expect(quoteJpg.quote.printSubtotal).toBe(29);
        expect(quoteDocx.quote.printSubtotal).toBe(29);

        expect(quoteJpg.quote.pageBreakdown[0].coverageTier).toBe('very_high');
        expect(quoteDocx.quote.pageBreakdown[0].coverageTier).toBe('very_high');
      }
    });
  });

  describe('2. JPG Scan of B&W Text: Elimination of File Format Bias', () => {
    it('bills scanned black-and-white text in JPG format at low B&W tier (₱3), not photo price (₱25)', () => {
      // Scanned document photo taken by phone camera / flatbed scanner containing B&W text
      const scannedBwDocAnalysis: DocumentAnalysis = {
        pageCount: 1,
        colorPages: 0,
        bwPages: 1,
        totalPages: 1,
        confidence: 'high',
        analyzedAt: new Date(),
        fileType: 'image',
        pages: [
          {
            index: 1,
            isColor: false,
            coverage: 0.05,
            coverageTier: 'low',
          },
        ],
      };

      // Even if user selected "colored" mode, auto-downgrade applies and page is billed at low B&W tier
      const quote = buildPrintQuote({
        analysis: scannedBwDocAnalysis,
        copies: 1,
        colorMode: 'colored',
        quality: 'standard',
        paperSize: 'A4',
        pageRange: { type: 'all' },
        duplex: false,
      });

      expect(quote.ok).toBe(true);
      if (quote.ok) {
        expect(quote.quote.effectiveColorMode).toBe('grayscale');
        // ₱1 paperCost + ₱2 low B&W print = ₱3
        expect(quote.quote.paperSubtotal).toBe(1);
        expect(quote.quote.printSubtotal).toBe(2);
        expect(quote.quote.requiredAmount).toBe(3);
        expect(quote.quote.pageBreakdown[0].coverageTier).toBe('low');
      }
    });
  });

  describe('3. Duplex Physical Sheet Savings', () => {
    it('accurately discounts physical paper sheets when 2-sided (duplex) printing is enabled', () => {
      // 10-page text document
      const pages = Array.from({ length: 10 }, (_, i) => ({
        index: i + 1,
        isColor: false,
        coverage: 0.05,
        coverageTier: 'low' as const,
      }));

      const docAnalysis: DocumentAnalysis = {
        pageCount: 10,
        colorPages: 0,
        bwPages: 10,
        totalPages: 10,
        confidence: 'high',
        analyzedAt: new Date(),
        fileType: 'pdf',
        pages,
      };

      // Simplex: 10 pages * (₱1 paper + ₱2 print) = ₱30 (10 physical sheets)
      const quoteSimplex = buildPrintQuote({
        analysis: docAnalysis,
        copies: 1,
        colorMode: 'grayscale',
        quality: 'standard',
        paperSize: 'A4',
        pageRange: { type: 'all' },
        duplex: false,
      });

      // Duplex: ceil(10 / 2) = 5 physical sheets @ ₱1 + 10 print sides @ ₱2 = ₱5 + ₱20 = ₱25 (saved ₱5)
      const quoteDuplex = buildPrintQuote({
        analysis: docAnalysis,
        copies: 1,
        colorMode: 'grayscale',
        quality: 'standard',
        paperSize: 'A4',
        pageRange: { type: 'all' },
        duplex: true,
      });

      expect(quoteSimplex.ok).toBe(true);
      expect(quoteDuplex.ok).toBe(true);

      if (quoteSimplex.ok && quoteDuplex.ok) {
        expect(quoteSimplex.quote.physicalSheets).toBe(10);
        expect(quoteSimplex.quote.paperSubtotal).toBe(10);
        expect(quoteSimplex.quote.printSubtotal).toBe(20);
        expect(quoteSimplex.quote.requiredAmount).toBe(30);
        expect(quoteSimplex.quote.duplexSavings).toBe(0);

        expect(quoteDuplex.quote.physicalSheets).toBe(5);
        expect(quoteDuplex.quote.paperSubtotal).toBe(5);
        expect(quoteDuplex.quote.printSubtotal).toBe(20);
        expect(quoteDuplex.quote.requiredAmount).toBe(25);
        expect(quoteDuplex.quote.duplexSavings).toBe(5);
      }
    });

    it('handles odd page counts and multiple copies correctly in duplex calculations', () => {
      // 7-page document with 2 copies
      const pages = Array.from({ length: 7 }, (_, i) => ({
        index: i + 1,
        isColor: false,
        coverage: 0.05,
        coverageTier: 'low' as const,
      }));

      const docAnalysis: DocumentAnalysis = {
        pageCount: 7,
        colorPages: 0,
        bwPages: 7,
        totalPages: 7,
        confidence: 'high',
        analyzedAt: new Date(),
        fileType: 'pdf',
        pages,
      };

      // 7 pages duplex = ceil(7 / 2) = 4 sheets per copy * 2 copies = 8 physical sheets
      // Paper subtotal = 8 sheets * ₱1 = ₱8
      // Print subtotal = 7 pages * 2 copies * ₱2 = ₱28
      // Total = ₱8 + ₱28 = ₱36
      // Simplex would be 14 sheets * ₱1 + 14 * ₱2 = ₱42
      // Duplex savings = (14 - 8) * ₱1 = ₱6
      const quote = buildPrintQuote({
        analysis: docAnalysis,
        copies: 2,
        colorMode: 'grayscale',
        quality: 'standard',
        paperSize: 'A4',
        pageRange: { type: 'all' },
        duplex: true,
      });

      expect(quote.ok).toBe(true);
      if (quote.ok) {
        expect(quote.quote.physicalSheets).toBe(8);
        expect(quote.quote.paperSubtotal).toBe(8);
        expect(quote.quote.printSubtotal).toBe(28);
        expect(quote.quote.requiredAmount).toBe(36);
        expect(quote.quote.duplexSavings).toBe(6);
      }
    });
  });

  describe('4. Tamper Verification & Quote Sealing', () => {
    it('validates genuine quote hash and rejects tampered options or prices', () => {
      const docAnalysis: DocumentAnalysis = {
        pageCount: 2,
        colorPages: 1,
        bwPages: 1,
        totalPages: 2,
        confidence: 'high',
        analyzedAt: new Date(),
        fileType: 'pdf',
        pages: [
          { index: 1, isColor: true, coverage: 0.25, coverageTier: 'medium' },
          { index: 2, isColor: false, coverage: 0.05, coverageTier: 'low' },
        ],
      };

      const result = buildPrintQuote({
        analysis: docAnalysis,
        copies: 1,
        colorMode: 'colored',
        quality: 'standard',
        paperSize: 'A4',
        pageRange: { type: 'all' },
        duplex: false,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const q = result.quote;
      const fileHash = (docAnalysis as any).fileHash ?? docAnalysis.fileType;

      // 1. Verify unmodified quote passes verification
      const isValidGenuine = verifyQuoteHash(q.quoteHash, {
        fileHash,
        paperSize: q.paperSize,
        colorMode: q.requestedColorMode,
        copies: q.copies,
        duplex: q.duplex,
        pageRange: q.pageRange,
        quality: q.quality,
        requiredAmount: q.requiredAmount,
        expiresAt: q.expiresAt,
      });
      expect(isValidGenuine).toBe(true);

      // 2. Client tampering requiredAmount downwards (e.g. ₱23 -> ₱10)
      const isTamperedAmountValid = verifyQuoteHash(q.quoteHash, {
        fileHash,
        paperSize: q.paperSize,
        colorMode: q.requestedColorMode,
        copies: q.copies,
        duplex: q.duplex,
        pageRange: q.pageRange,
        quality: q.quality,
        requiredAmount: 10,
        expiresAt: q.expiresAt,
      });
      expect(isTamperedAmountValid).toBe(false);

      // 3. Client tampering paperSize from A4 to Long
      const isTamperedPaperValid = verifyQuoteHash(q.quoteHash, {
        fileHash,
        paperSize: 'Long',
        colorMode: q.requestedColorMode,
        copies: q.copies,
        duplex: q.duplex,
        pageRange: q.pageRange,
        quality: q.quality,
        requiredAmount: q.requiredAmount,
        expiresAt: q.expiresAt,
      });
      expect(isTamperedPaperValid).toBe(false);

      // 4. Client tampering copies from 1 to 5
      const isTamperedCopiesValid = verifyQuoteHash(q.quoteHash, {
        fileHash,
        paperSize: q.paperSize,
        colorMode: q.requestedColorMode,
        copies: 5,
        duplex: q.duplex,
        pageRange: q.pageRange,
        quality: q.quality,
        requiredAmount: q.requiredAmount,
        expiresAt: q.expiresAt,
      });
      expect(isTamperedCopiesValid).toBe(false);

      // 5. Expired quote rejected
      const isExpiredValid = verifyQuoteHash(q.quoteHash, {
        fileHash,
        paperSize: q.paperSize,
        colorMode: q.requestedColorMode,
        copies: q.copies,
        duplex: q.duplex,
        pageRange: q.pageRange,
        quality: q.quality,
        requiredAmount: q.requiredAmount,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      expect(isExpiredValid).toBe(false);
    });
  });
});
