/**
 * @file color-detection.ts
 * @description Provides utilities for detecting chromatic (color) content within document(s).
 * It analyzes PDF operator lists for RGB/CMYK color settings and performs statistical 
 * sampling on embedded image data to differentiate between true grayscale and color files.
 */

import fs from 'node:fs';

/** The maximum difference between R, G, and B values to be considered grayscale. */
const RGB_SPREAD_THRESHOLD = 10;
/** Threshold for CMYK channels (C, M, Y). If any channel exceeds this, the operator is flagged as a color operation. */
const CMYK_COLOR_THRESHOLD = 0.01;
/** Target number of pixels to sample when analyzing embedded images to balance accuracy and performance. */
const IMAGE_SAMPLE_PIXEL_TARGET = 10_000;
/** The minimum ratio of colored pixels to sampled pixels required to classify an image as "colored". */
const IMAGE_COLOR_RATIO_THRESHOLD = 0.001;

/** Represents the final determination of the color analysis. */
export interface ColorDetectionResult {
  hasColor: boolean;
  isGrayscale: boolean;
  sampledPages: number;
}

interface PdfOps {
  setFillRGBColor?: number;
  setStrokeRGBColor?: number;
  setFillCMYKColor?: number;
  setStrokeCMYKColor?: number;
  setFillGray?: number;
  setStrokeGray?: number;
  paintImageXObject?: number;
  paintInlineImageXObject?: number;
  paintJpegXObject?: number;
}

/** Structure of the operator list returned by PDF.js for a specific page. */
interface PdfOperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

interface PdfObjectStore {
  get(name: string, callback?: (obj: unknown) => void): unknown;
}

export interface PdfPageProxy {
  getOperatorList(): Promise<PdfOperatorList>;
  cleanup(): void;
  objs?: PdfObjectStore;
}

export interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNum: number): Promise<PdfPageProxy>;
}

export interface PdfDocumentLoadingTask {
  promise: Promise<PdfDocumentProxy>;
  destroy(): Promise<void> | void;
}

export interface PdfImageObject {
  width: number;
  height: number;
  data?: Uint8Array | Uint8ClampedArray;
  dataLen?: number;
  kind?: number;
}

export interface ImageColorStats {
  sampledPixels: number;
  colorPixels: number;
  colorRatio: number;
  channels: number;
  width: number;
  height: number;
  isColor: boolean;
}

/**
 * Ensures a numeric value is within the standard 0-255 byte range.
 * @param value The number to clamp.
 */
function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Normalizes RGB arguments from PDF.js into a standard [r, g, b] byte array.
 * Handles both hex string formats and float arrays (0.0 - 1.0).
 * 
 * @param args The arguments array from a PDF operator.
 * @returns A tuple of [r, g, b] or null if parsing fails.
 */
function parseRgbArgs(args: unknown): [number, number, number] | null {
  if (!Array.isArray(args) || args.length === 0) return null;

  // Case 1: hex string e.g. ["#555555"] or ["#e74c3c"]
  if (typeof args[0] === 'string' && args[0].startsWith('#')) {
    const hex = args[0].slice(1);
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return [r, g, b];
    }
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return [r, g, b];
    }
    return null;
  }

  // Case 2: float array [r, g, b] in range 0–1
  if (
    args.length >= 3 &&
    typeof args[0] === 'number' &&
    typeof args[1] === 'number' &&
    typeof args[2] === 'number'
  ) {
    const [r, g, b] = [args[0], args[1], args[2]];
    const maxChannel = Math.max(r, g, b);
    if (maxChannel <= 1.01) {
      return [clampByte(r * 255), clampByte(g * 255), clampByte(b * 255)];
    }
    return [clampByte(r), clampByte(g), clampByte(b)];
  }

  return null;
}

function parseImageName(args: unknown): string | null {
  if (!Array.isArray(args) || args.length === 0) return null;
  return typeof args[0] === 'string' ? args[0] : null;
}

function isPdfImageObject(value: unknown): value is PdfImageObject {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PdfImageObject>;
  return (
    typeof candidate.width === 'number' && typeof candidate.height === 'number'
  );
}

function isPendingPdfObjectLookupError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /isn't resolved yet/i.test(error.message);
}

/**
 * Retrieves an image object from the PDF page's object store.
 * Handles both synchronous cached lookups and asynchronous fetches.
 * 
 * @param page The PDF page proxy.
 * @param imageName The resource name of the image.
 */
export async function resolveImageObject(
  page: PdfPageProxy,
  imageName: string,
): Promise<PdfImageObject | null> {
  const objs = page.objs;
  if (!objs || typeof objs.get !== 'function') return null;

  let immediate: unknown = null;
  let immediateLookupError: unknown = null;
  try {
    immediate = objs.get(imageName);
  } catch (error) {
    immediateLookupError = error;
  }

  if (
    immediateLookupError &&
    !isPendingPdfObjectLookupError(immediateLookupError)
  ) {
    console.warn(
      '[colorDetection] Unexpected image lookup error, skipping image object.',
      {
        imageName,
        error:
          immediateLookupError instanceof Error
            ? immediateLookupError.message
            : String(immediateLookupError),
      },
    );
    return null;
  }

  if (isPdfImageObject(immediate)) {
    return immediate;
  }

  return new Promise<PdfImageObject | null>((resolve) => {
    let settled = false;
    const settle = (value: PdfImageObject | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => settle(null), 200);
    try {
      objs.get(imageName, (obj) => {
        clearTimeout(timer);
        settle(isPdfImageObject(obj) ? obj : null);
      });
    } catch {
      clearTimeout(timer);
      settle(null);
    }
  });
}

/**
 * Analyzes the raw pixel data of an image to detect color.
 * Uses a sampling stride to efficiently process large images.
 * 
 * @param image The image object containing raw data.
 * @returns Statistics regarding pixel color distribution.
 */
export function getImageColorStats(image: PdfImageObject): ImageColorStats {
  const width = image.width;
  const height = image.height;
  const data = image.data;
  const totalPixels = width * height;

  if (!data || totalPixels <= 0) {
    return {
      sampledPixels: 0,
      colorPixels: 0,
      colorRatio: 0,
      channels: 0,
      width,
      height,
      isColor: false,
    };
  }

  const channels = Math.max(0, Math.floor(data.length / totalPixels));
  if (channels < 3) {
    return {
      sampledPixels: 0,
      colorPixels: 0,
      colorRatio: 0,
      channels,
      width,
      height,
      isColor: false,
    };
  }

  const stride = Math.max(
    1,
    Math.floor(totalPixels / IMAGE_SAMPLE_PIXEL_TARGET),
  );
  let sampledPixels = 0;
  let colorPixels = 0;

  for (let pixel = 0; pixel < totalPixels; pixel += stride) {
    const offset = pixel * channels;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];

    if (r === undefined || g === undefined || b === undefined) continue;

    sampledPixels += 1;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread > RGB_SPREAD_THRESHOLD) {
      colorPixels += 1;
    }
  }

  const colorRatio = sampledPixels > 0 ? colorPixels / sampledPixels : 0;
  const minimumColorPixels = Math.max(
    3,
    Math.ceil(sampledPixels * IMAGE_COLOR_RATIO_THRESHOLD),
  );

  return {
    sampledPixels,
    colorPixels,
    colorRatio,
    channels,
    width,
    height,
    isColor: sampledPixels > 0 && colorPixels >= minimumColorPixels,
  };
}

/**
 * Main entry point for PDF color detection.
 * 
 * Iterates through every page of a PDF and scans the underlying drawing 
 * instructions (operators). If an instruction specifies a non-gray color 
 * or draws a color image, the function returns immediately with a positive result.
 * 
 * @param pdfPath Absolute path to the PDF file on disk.
 * @returns A promise resolving to the color detection result.
 */
export async function detectPdfColorContent(
  pdfPath: string,
): Promise<ColorDetectionResult> {
  if (!fs.existsSync(pdfPath)) {
    console.warn('[colorDetection] File not found, defaulting to color.');
    return { hasColor: true, isGrayscale: false, sampledPages: 0 };
  }

  try {
    const pdfjs =
      (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
        OPS: PdfOps;
        getDocument(src: {
          data: Uint8Array;
          verbosity: number;
        }): PdfDocumentLoadingTask;
      };
    const OPS = pdfjs.OPS;

    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const loadingTask = pdfjs.getDocument({ data, verbosity: 0 });
    const doc = await loadingTask.promise;
    const imagePaintOps = new Set(
      [
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintJpegXObject,
      ].filter((op): op is number => typeof op === 'number'),
    );

    const totalPages = doc.numPages;
    console.log(
      `[colorDetection] Scanning all ${totalPages} pages via operator list`,
    );

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const opList = await page.getOperatorList();
      const { fnArray, argsArray } = opList;

      let rgbColorCount = 0;
      let rgbGrayCount = 0;
      let cmykCount = 0;
      let grayCount = 0;
      let imageOps = 0;
      let sampledImageOps = 0;

      for (let i = 0; i < fnArray.length; i++) {
        const op = fnArray[i];
        const args = argsArray[i];

        // ── RGB operators ──────────────────────────────────────────────
        if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
          const rgb = parseRgbArgs(args);
          if (!rgb) continue;

          const [r, g, b] = rgb;
          const spread = Math.max(r, g, b) - Math.min(r, g, b);

          if (spread > RGB_SPREAD_THRESHOLD) {
            console.log(
              `[colorDetection] ✓ COLOR via RGB on page ${pageNum}: ` +
                `R=${r} G=${g} B=${b} spread=${spread} raw=${JSON.stringify(args)}`,
            );
            await loadingTask.destroy();
            return {
              hasColor: true,
              isGrayscale: false,
              sampledPages: pageNum,
            };
          } else {
            // It's a grey RGB value (r≈g≈b) — log first few for visibility
            if (rgbGrayCount < 3) {
              console.log(
                `[colorDetection]   grey RGB on page ${pageNum}: ` +
                  `R=${r} G=${g} B=${b} spread=${spread} raw=${JSON.stringify(args)}`,
              );
            }
            rgbGrayCount++;
          }
          rgbColorCount++;
        }

        // ── CMYK operators ─────────────────────────────────────────────
        if (op === OPS.setFillCMYKColor || op === OPS.setStrokeCMYKColor) {
          if (!Array.isArray(args) || args.length < 4) continue;
          const [c, m, y, k] = args as number[];
          cmykCount++;
          if (
            c > CMYK_COLOR_THRESHOLD ||
            m > CMYK_COLOR_THRESHOLD ||
            y > CMYK_COLOR_THRESHOLD
          ) {
            console.log(
              `[colorDetection] ✓ COLOR via CMYK on page ${pageNum}: ` +
                `C=${c.toFixed(3)} M=${m.toFixed(3)} Y=${y.toFixed(3)} K=${k.toFixed(3)}`,
            );
            await loadingTask.destroy();
            return {
              hasColor: true,
              isGrayscale: false,
              sampledPages: pageNum,
            };
          }
        }

        // ── Embedded image operators (scanned PDFs usually store color here) ─
        if (imagePaintOps.has(op)) {
          imageOps++;
          const imageName = parseImageName(args);
          if (!imageName) continue;

          const image = await resolveImageObject(page, imageName);
          if (!image) continue;

          const imageStats = getImageColorStats(image);
          sampledImageOps++;

          if (imageStats.isColor) {
            console.log(
              `[colorDetection] ✓ COLOR via embedded image on page ${pageNum}: ` +
                `image=${imageName} size=${imageStats.width}x${imageStats.height} ` +
                `channels=${imageStats.channels} sampled=${imageStats.sampledPixels} ` +
                `color_pixels=${imageStats.colorPixels} ratio=${imageStats.colorRatio.toFixed(4)}`,
            );
            await loadingTask.destroy();
            return {
              hasColor: true,
              isGrayscale: false,
              sampledPages: pageNum,
            };
          }
        }

        // ── Grayscale operators ────────────────────────────────────────
        if (op === OPS.setFillGray || op === OPS.setStrokeGray) {
          grayCount++;
        }
      }

      console.log(
        `[colorDetection] Page ${pageNum}/${totalPages}: ` +
          `rgb_ops=${rgbColorCount} (grey=${rgbGrayCount}) cmyk_ops=${cmykCount} ` +
          `gray_ops=${grayCount} image_ops=${imageOps} (sampled=${sampledImageOps}) — no color`,
      );

      page.cleanup();
    }

    await loadingTask.destroy();
    console.log(
      `[colorDetection] ✗ Classified as GRAYSCALE after all ${totalPages} pages`,
    );
    return { hasColor: false, isGrayscale: true, sampledPages: totalPages };
  } catch (err) {
    console.warn('[colorDetection] Detection error, defaulting to color:', err);
    return { hasColor: true, isGrayscale: false, sampledPages: 0 };
  }
}
