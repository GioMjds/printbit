import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import {
  PDF_THUMBNAIL_SIZE,
  renderPdfGrayThumbnail,
} from './document-analysis';

// Jest cannot load pdf.js (ESM, uses import.meta), so hand it the real module
// through Node's own loader, as the server does at runtime.
jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () =>
  process
    .getBuiltinModule('module')
    .createRequire(__filename)('pdfjs-dist/legacy/build/pdf.mjs'),
);

let dir: string;

async function writePdf(name: string, leftHalfBlack: boolean): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([283, 283]);
  if (leftHalfBlack) {
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 141.5,
      height: 283,
      color: rgb(0, 0, 0),
    });
  }
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, await doc.save());
  return filePath;
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdf-thumb-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('renderPdfGrayThumbnail', () => {
  it('returns one gray level per cell', async () => {
    const thumbnail = await renderPdfGrayThumbnail(
      await writePdf('half.pdf', true),
    );
    expect(thumbnail).toHaveLength(PDF_THUMBNAIL_SIZE * PDF_THUMBNAIL_SIZE);
  });

  it('is dark where the page is dark and light where it is empty', async () => {
    const thumbnail = await renderPdfGrayThumbnail(
      await writePdf('half.pdf', true),
    );
    const row = 16 * PDF_THUMBNAIL_SIZE;
    expect(thumbnail[row + 4]).toBeLessThan(60);
    expect(thumbnail[row + 28]).toBeGreaterThan(200);
  });

  it('is light everywhere for an empty page', async () => {
    const thumbnail = await renderPdfGrayThumbnail(
      await writePdf('empty.pdf', false),
    );
    expect(Math.min(...thumbnail)).toBeGreaterThan(240);
  });
});
