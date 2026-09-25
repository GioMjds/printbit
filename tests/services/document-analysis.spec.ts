import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import {
  hasVisibleGlyphs,
  resolveCoverageTier,
  ANALYSIS_ALGORITHM_VERSION,
  analyzeDocument,
} from '../../src/services/document-analysis';

describe('hasVisibleGlyphs', () => {
  it('returns false for space glyphs with colored style', () => {
    const spaceGlyph = [
      [
        {
          originalCharCode: 32,
          fontChar: ' ',
          unicode: ' ',
          accent: null,
          width: 320,
          isSpace: true,
          isInFont: false,
        },
      ],
    ];
    expect(hasVisibleGlyphs(spaceGlyph)).toBe(false);
  });

  it('returns false for whitespace strings and empty arrays', () => {
    expect(hasVisibleGlyphs([['   ']])).toBe(false);
    expect(hasVisibleGlyphs([[]])).toBe(false);
    expect(hasVisibleGlyphs(null)).toBe(false);
  });

  it('returns true for visible characters', () => {
    const textGlyph = [
      [
        {
          originalCharCode: 49,
          fontChar: '1',
          unicode: '1',
          accent: null,
          width: 620,
          isSpace: false,
          isInFont: true,
        },
      ],
    ];
    expect(hasVisibleGlyphs(textGlyph)).toBe(true);
    expect(hasVisibleGlyphs([['Hello World']])).toBe(true);
  });
});

describe('resolveCoverageTier', () => {
  it('correctly maps coverage values to coverage tiers', () => {
    expect(resolveCoverageTier(0)).toBe('low');
    expect(resolveCoverageTier(0.05)).toBe('low');
    expect(resolveCoverageTier(0.10)).toBe('low');
    expect(resolveCoverageTier(0.1001)).toBe('medium');
    expect(resolveCoverageTier(0.25)).toBe('medium');
    expect(resolveCoverageTier(0.40)).toBe('medium');
    expect(resolveCoverageTier(0.4001)).toBe('high');
    expect(resolveCoverageTier(0.55)).toBe('high');
    expect(resolveCoverageTier(0.70)).toBe('high');
    expect(resolveCoverageTier(0.7001)).toBe('very_high');
    expect(resolveCoverageTier(1.0)).toBe('very_high');
  });
});

describe('Document Analysis - Uniform Canvas Metering (PDF)', () => {
  const tmpDir = path.join(__dirname, '..', 'tmp-pdf-analysis-test');
  const fullColorPdfPath = path.join(tmpDir, 'test-full-color.pdf');
  const lowTextPdfPath = path.join(tmpDir, 'test-low-text.pdf');
  const blankPdfPath = path.join(tmpDir, 'test-blank.pdf');

  beforeAll(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });

    // Full-page color PDF (100% red background)
    const colorDoc = await PDFDocument.create();
    const colorPage = colorDoc.addPage([200, 200]);
    colorPage.drawRectangle({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      color: rgb(1, 0, 0),
    });
    fs.writeFileSync(fullColorPdfPath, await colorDoc.save());

    // Standard low-coverage text / shape PDF
    const textDoc = await PDFDocument.create();
    const textPage = textDoc.addPage([200, 200]);
    textPage.drawRectangle({
      x: 10,
      y: 10,
      width: 15,
      height: 15,
      color: rgb(0, 0, 0),
    });
    fs.writeFileSync(lowTextPdfPath, await textDoc.save());

    // Blank PDF
    const blankDoc = await PDFDocument.create();
    blankDoc.addPage([200, 200]);
    fs.writeFileSync(blankPdfPath, await blankDoc.save());
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bumps ANALYSIS_ALGORITHM_VERSION to 9', () => {
    expect(ANALYSIS_ALGORITHM_VERSION).toBe(9);
  });

  it('meters full-page color PDF as very_high coverageTier and color classification', async () => {
    const result = await analyzeDocument({
      filePath: fullColorPdfPath,
      contentType: 'application/pdf',
      filename: 'test-full-color.pdf',
    });

    expect(result.fileType).toBe('pdf');
    expect(result.pageCount).toBe(1);
    expect(result.colorPages).toBe(1);
    expect(result.bwPages).toBe(0);

    const page = result.pages[0];
    expect(page.isColor).toBe(true);
    expect(page.isBlank).toBe(false);
    expect(page.classification).toBe('color');
    expect(page.coverageTier).toBe('very_high');
    expect(page.coverage).toBeGreaterThan(0.7);
    expect(page.colorCoverage).toBeGreaterThan(0.02);
    expect((page as any).isImagePage).toBeUndefined();
  });

  it('meters sparse B/W PDF as low coverageTier and bw classification', async () => {
    const result = await analyzeDocument({
      filePath: lowTextPdfPath,
      contentType: 'application/pdf',
      filename: 'test-low-text.pdf',
    });

    expect(result.fileType).toBe('pdf');
    expect(result.pageCount).toBe(1);
    expect(result.colorPages).toBe(0);
    expect(result.bwPages).toBe(1);

    const page = result.pages[0];
    expect(page.isColor).toBe(false);
    expect(page.isBlank).toBe(false);
    expect(page.classification).toBe('bw');
    expect(page.coverageTier).toBe('low');
    expect(page.coverage).toBeLessThanOrEqual(0.10);
    expect(page.colorCoverage).toBe(0);
  });

  it('detects blank PDF page as blank classification and low coverageTier', async () => {
    const result = await analyzeDocument({
      filePath: blankPdfPath,
      contentType: 'application/pdf',
      filename: 'test-blank.pdf',
    });

    expect(result.fileType).toBe('pdf');
    expect(result.pageCount).toBe(1);
    const page = result.pages[0];
    expect(page.isBlank).toBe(true);
    expect(page.classification).toBe('blank');
    expect(page.coverageTier).toBe('low');
    expect(page.coverage).toBeLessThan(0.001);
  });
});
