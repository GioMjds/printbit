import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { PAPER_POINTS, type PaperSize } from '@/shared/print-configuration';
import { composeIdSheet, regionDrawOptions } from './id-copy-compose';

const MM_TO_PT = 72 / 25.4;
let dir: string;

async function writeSidePdf(name: string): Promise<string> {
  const doc = await PDFDocument.create();
  const side = 100 * MM_TO_PT;
  const page = doc.addPage([side, side]);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: side / 2,
    height: side,
    color: rgb(0, 0, 0),
  });
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, await doc.save());
  return filePath;
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'id-compose-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('composeIdSheet', () => {
  it.each(['A4', 'Short', 'Long'] as PaperSize[])(
    'builds one %s page from both sides',
    async (paperSize) => {
      const front = await writeSidePdf('front.pdf');
      const back = await writeSidePdf('back.pdf');
      const bytes = await composeIdSheet({
        paperSize,
        front: { filePath: front, rotationDeg: 0 },
        back: { filePath: back, rotationDeg: 180 },
      });
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
      const { width, height } = doc.getPage(0).getSize();
      expect(width).toBeCloseTo(PAPER_POINTS[paperSize][0], 2);
      expect(height).toBeCloseTo(PAPER_POINTS[paperSize][1], 2);
    },
  );

  it('builds a valid sheet from the front alone', async () => {
    const front = await writeSidePdf('front.pdf');
    const bytes = await composeIdSheet({
      paperSize: 'A4',
      front: { filePath: front, rotationDeg: 90 },
      back: null,
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('rejects a sheet with no side', async () => {
    await expect(
      composeIdSheet({ paperSize: 'A4', front: null, back: null }),
    ).rejects.toThrow('No ID side to compose.');
  });

  it('rejects a missing side file', async () => {
    await expect(
      composeIdSheet({
        paperSize: 'A4',
        front: { filePath: path.join(dir, 'gone.pdf'), rotationDeg: 0 },
        back: null,
      }),
    ).rejects.toThrow();
  });
});

describe('regionDrawOptions', () => {
  const region = { x: 10, y: 20, width: 300, height: 200 };

  it('draws an unrotated scan at its footprint', () => {
    expect(regionDrawOptions({ region, rotationDeg: 0 })).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      rotateDeg: 0,
    });
  });

  it('starts a 90 degree clockwise turn at the top-left corner', () => {
    expect(regionDrawOptions({ region, rotationDeg: 90 })).toEqual({
      x: 10,
      y: 220,
      width: 200,
      height: 300,
      rotateDeg: -90,
    });
  });

  it('starts a half turn at the top-right corner', () => {
    expect(regionDrawOptions({ region, rotationDeg: 180 })).toEqual({
      x: 310,
      y: 220,
      width: 300,
      height: 200,
      rotateDeg: 180,
    });
  });

  it('starts a 270 degree clockwise turn at the bottom-right corner', () => {
    expect(regionDrawOptions({ region, rotationDeg: 270 })).toEqual({
      x: 310,
      y: 20,
      width: 200,
      height: 300,
      rotateDeg: 90,
    });
  });
});
