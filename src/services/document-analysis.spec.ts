import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  MIN_CONTENT_COVERAGE_THRESHOLD,
  PDF_RENDER_SCALE,
} from '@/config/document-analysis.config';
import { analyzeDocument } from './document-analysis';

/** White canvas with one black block of `inkWidth` x `inkHeight` pixels. */
async function writeSparseImage(
  filePath: string,
  inkWidth: number,
  inkHeight: number,
): Promise<void> {
  const base = sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });
  if (inkWidth === 0 || inkHeight === 0) {
    await base.png().toFile(filePath);
    return;
  }
  const ink = await sharp({
    create: {
      width: inkWidth,
      height: inkHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
  await base
    .composite([{ input: ink, left: 190, top: 380 }])
    .png()
    .toFile(filePath);
}

describe('blank page detection', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printbit-analysis-spec-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not flag a page with one short line of text as blank', async () => {
    // 20 x 5 px of ink on 400 x 400 is 0.0625% coverage, about what a 12 pt
    // "Hello world" measures on an A4 page.
    const filePath = path.join(dir, 'short-line.png');
    await writeSparseImage(filePath, 20, 5);

    const result = await analyzeDocument({ filePath });

    expect(result.pages[0].coverage).toBeCloseTo(0.000625, 6);
    expect(result.pages[0].isBlank).toBe(false);
    expect(result.pages[0].classification).toBe('bw');
    expect(result.isEntirelyBlank).toBe(false);
    expect(result.blankPageCount).toBe(0);
  });

  it('does not flag a page with only a page number as blank', async () => {
    // 3 x 1 px is 0.0019%, about what a 9 pt "1" measures on an A4 page.
    const filePath = path.join(dir, 'page-number.png');
    await writeSparseImage(filePath, 3, 1);

    const result = await analyzeDocument({ filePath });

    expect(result.pages[0].isBlank).toBe(false);
    expect(result.isEntirelyBlank).toBe(false);
  });

  it('still flags a page with no ink as blank', async () => {
    const filePath = path.join(dir, 'empty.png');
    await writeSparseImage(filePath, 0, 0);

    const result = await analyzeDocument({ filePath });

    expect(result.pages[0].isBlank).toBe(true);
    expect(result.pages[0].classification).toBe('blank');
    expect(result.isEntirelyBlank).toBe(true);
    expect(result.blankPages).toEqual([1]);
  });
});

describe('analysis config', () => {
  it('keeps the blank threshold below the smallest real glyph', () => {
    expect(MIN_CONTENT_COVERAGE_THRESHOLD).toBeLessThanOrEqual(0.00001);
    expect(MIN_CONTENT_COVERAGE_THRESHOLD).toBeGreaterThan(0);
  });

  it('declares the scale the analyzer renders at', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'document-analysis.ts'),
      'utf8',
    );
    expect(source).toContain('getViewport({ scale: PDF_RENDER_SCALE })');
    expect(PDF_RENDER_SCALE).toBe(0.5);
  });
});
