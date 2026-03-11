// src/services/colorDetection.ts
import fs from 'node:fs';
import path from 'node:path';

// Threshold: if R/G/B channel spread exceeds this, the pixel is "coloured"
const COLOR_THRESHOLD = 20;
// Sample every Nth pixel — keeps it fast on large pages
const SAMPLE_STRIDE = 8;
// Max pages to sample (enough to catch color on most docs)
const MAX_SAMPLE_PAGES = 6;

export interface ColorDetectionResult {
  hasColor: boolean;
  isGrayscale: boolean;
  sampledPages: number;
}

export async function detectPdfColorContent(
  pdfPath: string,
): Promise<ColorDetectionResult> {
  if (!fs.existsSync(pdfPath)) {
    // File missing — default to allowing color (non-fatal)
    return { hasColor: true, isGrayscale: false, sampledPages: 0 };
  }

  try {
    // pdfjs-dist requires a legacy build for Node.js (no canvas/DOM)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

    const pagesToCheck = Math.min(doc.numPages, MAX_SAMPLE_PAGES);

    for (let pageNum = 1; pageNum <= pagesToCheck; pageNum++) {
      const page = await doc.getPage(pageNum);

      // Render at low scale — 0.2 is enough to detect color blobs
      const viewport = page.getViewport({ scale: 0.2 });

      // Create an in-memory canvas using Node canvas
      const { createCanvas } = await import('canvas');
      const canvas = createCanvas(
        Math.floor(viewport.width),
        Math.floor(viewport.height),
      );
      const ctx = canvas.getContext('2d');

      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
      }).promise;

      const {
        data: pixels,
        width,
        height,
      } = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Sample pixels — RGBA format (4 bytes per pixel)
      for (let i = 0; i < pixels.length; i += 4 * SAMPLE_STRIDE) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const spread = Math.max(r, g, b) - Math.min(r, g, b);
        if (spread > COLOR_THRESHOLD) {
          await doc.destroy();
          return { hasColor: true, isGrayscale: false, sampledPages: pageNum };
        }
      }

      page.cleanup();
    }

    await doc.destroy();
    return { hasColor: false, isGrayscale: true, sampledPages: pagesToCheck };
  } catch (err) {
    console.warn('[colorDetection] Detection error, defaulting to color:', err);
    return { hasColor: true, isGrayscale: false, sampledPages: 0 };
  }
}
