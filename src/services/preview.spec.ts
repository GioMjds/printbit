import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const convertDocumentViaWorker = jest.fn();

jest.mock('@/config/http.config', () => ({
  PREVIEW_CACHE_DIR: path.join(os.tmpdir(), 'printbit-preview-spec-cache'),
}));
jest.mock('@/services/document-conversion-pipe', () => ({
  convertDocumentViaWorker: (...args: unknown[]) =>
    convertDocumentViaWorker(...args),
}));

import { PreviewService } from './preview';

describe('PreviewService.convertToPdfArtifact', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printbit-preview-spec-'));
    convertDocumentViaWorker.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not hand out an artifact that is still being written', async () => {
    // The worker names its output after the source file, so a source stored
    // as <documentId>.docx is written straight to the artifact path.
    const sourcePath = path.join(dir, 'doc-1.docx');
    const artifactPath = path.join(dir, 'doc-1.pdf');
    fs.writeFileSync(sourcePath, 'source');

    let finishConversion: () => void = () => {};
    convertDocumentViaWorker.mockImplementation(async () => {
      fs.writeFileSync(artifactPath, '%PDF-partial');
      await new Promise<void>((resolve) => {
        finishConversion = resolve;
      });
      fs.writeFileSync(artifactPath, '%PDF-complete');
      return { success: true, outputPath: artifactPath };
    });

    const service = new PreviewService();
    const first = service.convertToPdfArtifact(sourcePath, artifactPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.readFileSync(artifactPath, 'utf8')).toBe('%PDF-partial');

    let secondSettled = false;
    const second = service
      .convertToPdfArtifact(sourcePath, artifactPath)
      .then((result) => {
        secondSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondSettled).toBe(false);

    finishConversion();
    await expect(first).resolves.toBe(artifactPath);
    await expect(second).resolves.toBe(artifactPath);
    expect(fs.readFileSync(artifactPath, 'utf8')).toBe('%PDF-complete');
    expect(convertDocumentViaWorker).toHaveBeenCalledTimes(1);
  });

  it('rasterizes WebP to PNG so it takes the same image path as JPG and PNG', async () => {
    const sourcePath = path.join(dir, 'photo.webp');
    const artifactPath = path.join(dir, 'doc-2.pdf');
    fs.writeFileSync(
      sourcePath,
      await sharp({
        create: {
          width: 40,
          height: 20,
          channels: 3,
          background: { r: 200, g: 30, b: 30 },
        },
      })
        .webp()
        .toBuffer(),
    );

    let workerSource = '';
    let workerSourceSize: { width?: number; height?: number } = {};
    convertDocumentViaWorker.mockImplementation(async (source: string) => {
      workerSource = source;
      const meta = await sharp(fs.readFileSync(source)).metadata();
      workerSourceSize = { width: meta.width, height: meta.height };
      const outputPath = path.join(
        dir,
        `${path.basename(source, path.extname(source))}.pdf`,
      );
      fs.writeFileSync(outputPath, '%PDF-image');
      return { success: true, outputPath };
    });

    const service = new PreviewService();
    await expect(
      service.convertToPdfArtifact(sourcePath, artifactPath),
    ).resolves.toBe(artifactPath);

    expect(path.extname(workerSource).toLowerCase()).toBe('.png');
    expect(workerSourceSize).toEqual({ width: 40, height: 20 });
    expect(fs.readFileSync(artifactPath, 'utf8')).toBe('%PDF-image');
    // The intermediate PNG is not left behind next to the session files.
    expect(fs.existsSync(workerSource)).toBe(false);
    expect(fs.existsSync(sourcePath)).toBe(true);
  });
});
