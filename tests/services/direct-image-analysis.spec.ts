import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeDocument } from '../../src/services/document-analysis';

describe('Direct Image Analysis (Sharp)', () => {
  const tmpDir = path.join(__dirname, '..', 'tmp-image-test');
  const colorImagePath = path.join(tmpDir, 'test-color.png');
  const bwImagePath = path.join(tmpDir, 'test-bw.png');

  beforeAll(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Generate 100x100 vibrant red image
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toFile(colorImagePath);

    // Generate 100x100 pure grayscale image
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 128, g: 128, b: 128 } },
    }).png().toFile(bwImagePath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('analyzes color PNG directly without PDF conversion', async () => {
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
    expect(result.pages[0].isImagePage).toBe(true);
    expect(result.pages[0].classification).toBe('image');
  });

  it('analyzes grayscale PNG directly as bw image', async () => {
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
    expect(result.pages[0].isImagePage).toBe(true);
    expect(result.pages[0].classification).toBe('bw');
  });
});
