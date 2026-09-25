import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeDocument } from '../../src/services/document-analysis';

describe('Direct Image Analysis (Sharp)', () => {
  const tmpDir = path.join(__dirname, '..', 'tmp-image-test');
  const colorImagePath = path.join(tmpDir, 'test-color.png');
  const bwImagePath = path.join(tmpDir, 'test-bw.png');
  const blankImagePath = path.join(tmpDir, 'test-blank.png');

  beforeAll(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Generate 100x100 vibrant red image
    await (sharp as any)({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toFile(colorImagePath);

    // Generate 100x100 pure grayscale image
    await (sharp as any)({
      create: { width: 100, height: 100, channels: 3, background: { r: 128, g: 128, b: 128 } },
    }).png().toFile(bwImagePath);

    // Generate 100x100 pure white (blank) image
    await (sharp as any)({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toFile(blankImagePath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('analyzes color PNG directly without PDF conversion, assigning color classification and coverageTier', async () => {
    const result = await analyzeDocument({
      filePath: colorImagePath,
      contentType: 'image/png',
      filename: 'test-color.png',
      originalFileType: 'image',
    });

    expect(result.fileType).toBe('image');
    expect(result.pageCount).toBe(1);
    expect(result.colorPages).toBe(1);
    expect(result.bwPages).toBe(0);
    expect(result.pages[0].classification).toBe('color');
    expect(result.pages[0].isColor).toBe(true);
    expect(result.pages[0].coverageTier).toBe('very_high');
    expect(result.pages[0].coverage).toBeGreaterThan(0.7);
    expect(result.pages[0].colorCoverage).toBeGreaterThan(0.02);
    expect((result.pages[0] as any).isImagePage).toBeUndefined();
  });

  it('analyzes grayscale PNG directly as bw image without format bias', async () => {
    const result = await analyzeDocument({
      filePath: bwImagePath,
      contentType: 'image/png',
      filename: 'test-bw.png',
      originalFileType: 'image',
    });

    expect(result.fileType).toBe('image');
    expect(result.pageCount).toBe(1);
    expect(result.colorPages).toBe(0);
    expect(result.bwPages).toBe(1);
    expect(result.pages[0].classification).toBe('bw');
    expect(result.pages[0].isColor).toBe(false);
    expect(result.pages[0].coverageTier).toBe('very_high');
    expect(result.pages[0].coverage).toBeGreaterThan(0.7);
    expect(result.pages[0].colorCoverage).toBe(0);
    expect((result.pages[0] as any).isImagePage).toBeUndefined();
  });

  it('analyzes blank white PNG as blank classification and low coverageTier', async () => {
    const result = await analyzeDocument({
      filePath: blankImagePath,
      contentType: 'image/png',
      filename: 'test-blank.png',
      originalFileType: 'image',
    });

    expect(result.fileType).toBe('image');
    expect(result.pageCount).toBe(1);
    expect(result.colorPages).toBe(0);
    expect(result.bwPages).toBe(1);
    expect(result.pages[0].isBlank).toBe(true);
    expect(result.pages[0].classification).toBe('blank');
    expect(result.pages[0].coverageTier).toBe('low');
    expect(result.pages[0].coverage).toBe(0);
  });
});
