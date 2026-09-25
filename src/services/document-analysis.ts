import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas } from 'canvas';
import { isMainThread, workerData, parentPort } from 'node:worker_threads';
import type { CoverageTier } from '@/core/database/models/admin.model';
export { CoverageTier };
import {
  COLOR_SATURATION_THRESHOLD,
  MAX_PIXELS_TO_SAMPLE,
} from '@/config/document-analysis.config';
import {
  resolveImageObject,
  getImageColorStats,
  type PdfPageProxy,
} from './color-detection';

/**
 * Monotonically-increasing version for the document analysis algorithm.
 * Bump this whenever the analysis logic changes in a way that could produce
 * different results for the same file (e.g. blank-page detection fixes,
 * RGB-spread threshold changes, white-paint guard additions, etc.).
 *
 * Consumers (wireless service, pricing cache) compare stored analysisVersion
 * against this constant and treat stale results as pending re-analysis.
 *
 * History:
 *   1 — initial operator-list analysis
 *   2 — colour-op / content-op separation; white-paint guard (blank page fix)
 *   3 — persist content coverage separately from color coverage
 *   4 — forward original file type to preserve image classification across PDF conversion
 *   5 — isolate Form XObjects from raster images, maintain graphics-state color stack, and auto-fallback converter
 *   6 — ignore whitespace-only text operations and handle setFillGray/setStrokeGray in color detection
 *   7 — sample embedded images for color, exclude grayscale/monochrome icons from color, and restrict image tier to converted image uploads
 *   8 — include constructPath and rawFillPath in pathDrawingOps to recognize vector shapes and colored boxes
 *   9 — uniform low-DPI canvas coverage metering for PDF pages and images; coverage tiers (low, medium, high, very_high)
 */
export const ANALYSIS_ALGORITHM_VERSION = 9;

export function resolveCoverageTier(contentCoverage: number): CoverageTier {
  if (contentCoverage <= 0.10) return 'low';
  if (contentCoverage <= 0.40) return 'medium';
  if (contentCoverage <= 0.70) return 'high';
  return 'very_high';
}

export type AnalyzedFileType =
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'xlsx'
  | 'xls'
  | 'pptx'
  | 'ppt'
  | 'image'
  | 'unknown';

export interface PageAnalysis {
  index: number;
  isColor: boolean;
  coverage: number;             // contentCoverage (0.0 to 1.0)
  colorCoverage: number;        // colorCoverage (0.0 to 1.0)
  coverageTier: CoverageTier;   // 'low' | 'medium' | 'high' | 'very_high'
  isBlank: boolean;
  classification: 'blank' | 'bw' | 'color';
  fallbackReasonFlags?: string[];
  contentCoverage?: number;
  isImagePage?: boolean;
  imageCoverage?: number;
}

export type AnalysisConfidence = 'high' | 'medium' | 'low';

export interface DocumentAnalysisResult {
  fileType: AnalyzedFileType;
  pageCount: number;
  pages: PageAnalysis[];
  colorPages: number;
  bwPages: number;
  totalPages: number;
  confidence?: AnalysisConfidence;
  /**
   * Version of the analysis algorithm that produced this result.
   * Compare against ANALYSIS_ALGORITHM_VERSION to detect stale cache entries.
   */
  analysisVersion: number;
}

interface AnalyzeDocumentInput {
  filePath: string;
  contentType?: string;
  filename?: string;
  convertToPdfPreview?: (sourcePath: string) => Promise<string>;
  colorDetectionEnabled?: boolean;
  originalFileType?: AnalyzedFileType;
}

interface RgbaFrame {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

interface PdfOperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

interface PdfOps {
  save?: number;
  restore?: number;
  transform?: number;
  setFillRGBColor?: number;
  setStrokeRGBColor?: number;
  setFillCMYKColor?: number;
  setStrokeCMYKColor?: number;
  setFillGray?: number;
  setStrokeGray?: number;
  paintImageXObject?: number;
  paintInlineImageXObject?: number;
  paintImageMaskXObject?: number;
  paintJpegXObject?: number;
  paintFormXObject?: number;
  // Path drawing operators — these are what actually commit ink to the page
  fill?: number;
  eoFill?: number;
  stroke?: number;
  closeStroke?: number;
  fillStroke?: number;
  eoFillStroke?: number;
  closeFillStroke?: number;
  closeEOFillStroke?: number;
  shadingFill?: number;
  constructPath?: number;
  rawFillPath?: number;
}

export function resolveFileType(
  contentType: string,
  filename: string,
): AnalyzedFileType {
  const ext = path.extname(filename).toLowerCase();

  if (contentType === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (
    contentType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    return 'docx';
  }
  if (contentType === 'application/msword' || ext === '.doc') return 'doc';
  if (
    contentType ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ext === '.xlsx'
  ) {
    return 'xlsx';
  }
  if (contentType === 'application/vnd.ms-excel' || ext === '.xls')
    return 'xls';
  if (
    contentType ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    ext === '.pptx'
  ) {
    return 'pptx';
  }
  if (contentType === 'application/vnd.ms-powerpoint' || ext === '.ppt')
    return 'ppt';

  if (
    contentType.startsWith('image/') ||
    ext === '.jpg' ||
    ext === '.jpeg' ||
    ext === '.png' ||
    ext === '.webp' ||
    ext === '.gif'
  ) {
    return 'image';
  }

  return 'unknown';
}

function isColorPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === 0) return false;
  const saturation = (max - min) / max;
  return saturation > COLOR_SATURATION_THRESHOLD;
}

/**
 * Checks if a pixel has any content (non-white/non-transparent).
 */
function isContentPixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 8) return false; // Transparent
  // Check if it's not white (with some tolerance)
  return r < 250 || g < 250 || b < 250;
}

interface CoverageMetrics {
  colorCoverage: number;
  contentCoverage: number;
}

function computeFrameMetrics(frame: RgbaFrame): CoverageMetrics {
  const totalPixels = frame.width * frame.height;
  if (totalPixels === 0) return { colorCoverage: 0, contentCoverage: 0 };

  const step = Math.max(1, Math.ceil(totalPixels / MAX_PIXELS_TO_SAMPLE));
  let colorPixels = 0;
  let contentPixels = 0;
  let sampledPixels = 0;

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += step) {
    const offset = pixelIndex * 4;
    const r = frame.data[offset];
    const g = frame.data[offset + 1];
    const b = frame.data[offset + 2];
    const a = frame.data[offset + 3];

    sampledPixels += 1;
    if (isContentPixel(r, g, b, a)) {
      contentPixels += 1;
      if (isColorPixel(r, g, b)) {
        colorPixels += 1;
      }
    }
  }

  return {
    colorCoverage: sampledPixels === 0 ? 0 : colorPixels / sampledPixels,
    contentCoverage: sampledPixels === 0 ? 0 : contentPixels / sampledPixels,
  };
}

async function analyzeImage(
  filePath: string,
  colorDetectionEnabled: boolean = true,
): Promise<DocumentAnalysisResult> {
  const { data, info } = await (sharp as any)(filePath)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const metrics = computeFrameMetrics({
    data,
    width: info.width,
    height: info.height,
  });
  const isBlank = metrics.contentCoverage < 0.001;
  const isColor = colorDetectionEnabled && !isBlank && metrics.colorCoverage > 0.02;
  const coverageTier = resolveCoverageTier(metrics.contentCoverage);
  const classification: 'blank' | 'bw' | 'color' = isBlank
    ? 'blank'
    : isColor
      ? 'color'
      : 'bw';

  const page: PageAnalysis = {
    index: 1,
    isColor,
    coverage: metrics.contentCoverage,
    colorCoverage: colorDetectionEnabled ? metrics.colorCoverage : 0,
    coverageTier,
    isBlank,
    classification,
    contentCoverage: metrics.contentCoverage,
  };

  return {
    fileType: 'image',
    pageCount: 1,
    pages: [page],
    colorPages: page.isColor ? 1 : 0,
    bwPages: page.isColor ? 0 : 1,
    totalPages: 1,
    confidence: 'high',
    analysisVersion: ANALYSIS_ALGORITHM_VERSION,
  };
}

async function analyzePdfFile(
  pdfPath: string,
  fileType: AnalyzedFileType,
  colorDetectionEnabled: boolean = true,
  options?: { isOriginalImage?: boolean },
): Promise<DocumentAnalysisResult> {
  let pdfjs: any;
  let canvasFactory: (w: number, h: number) => any = createCanvas;
  try {
    const mod = (process as any).getBuiltinModule
      ? (process as any).getBuiltinModule('node:module')
      : require('node:module');
    const nativeRequire = mod.createRequire(
      typeof __filename !== 'undefined' ? __filename : path.join(process.cwd(), 'index.js'),
    );
    pdfjs = nativeRequire('pdfjs-dist/legacy/build/pdf.mjs');
    try {
      const pdfjsPath = nativeRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs');
      const pdfjsReq = mod.createRequire(pdfjsPath);
      const napiCanvas = pdfjsReq('@napi-rs/canvas');
      if (napiCanvas && typeof napiCanvas.createCanvas === 'function') {
        canvasFactory = (w: number, h: number) => napiCanvas.createCanvas(w, h);
      }
    } catch {
      // Keep default createCanvas
    }
  } catch {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  const data = new Uint8Array(await fs.promises.readFile(pdfPath));
  const loadingTask = pdfjs.getDocument({ data, verbosity: 0 });
  const doc = await loadingTask.promise;
  const totalPages = doc.numPages;

  const ops = (pdfjs.OPS ?? {}) as PdfOps;
  const pdfjsAllOps = (pdfjs.OPS ?? {}) as Record<string, number>;
  const textRenderOps = new Set<number>(
    [
      'showText',
      'showSpacedText',
      'nextLineShowText',
      'nextLineSetSpacingShowText',
    ]
      .map((k) => pdfjsAllOps[k])
      .filter((v): v is number => typeof v === 'number'),
  );

  const textStructuralOps = new Set<number>(
    [
      'beginText', // BT
      'endText', // ET
      'nextLine', // T* — cursor move only
      'moveText', // Td/TD — cursor move only
    ]
      .map((k) => pdfjsAllOps[k])
      .filter((v): v is number => typeof v === 'number'),
  );

  const pages: PageAnalysis[] = [];
  let fallbackPageCount = 0;

  try {
    for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      let coverage = 0;
      let colorCoverage = 0;
      let isColor = false;
      let isBlank = false;
      let coverageTier: CoverageTier = 'low';
      let classification: 'blank' | 'bw' | 'color' = 'bw';
      const fallbackFlags: string[] = [];

      try {
        const viewport = page.getViewport({ scale: 0.5 });
        const canvas = canvasFactory(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        await (page.render as any)({
          canvasContext: ctx as any,
          viewport,
          canvas: canvas as any,
        }).promise;
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const metrics = computeFrameMetrics({
          data: imgData.data,
          width: canvas.width,
          height: canvas.height,
        });

        isBlank = metrics.contentCoverage < 0.001;
        isColor = colorDetectionEnabled && !isBlank && metrics.colorCoverage > 0.02;
        coverageTier = resolveCoverageTier(metrics.contentCoverage);
        classification = isBlank ? 'blank' : isColor ? 'color' : 'bw';
        coverage = metrics.contentCoverage;
        colorCoverage = colorDetectionEnabled ? metrics.colorCoverage : 0;
      } catch (canvasErr) {
        console.warn(
          `[document-analysis] Page ${pageNum} canvas render failed; falling back to operator list scan.`,
          canvasErr,
        );
        fallbackFlags.push('canvas_render_failed_fallback_operator_scan');
        fallbackPageCount += 1;

        try {
          const viewport = page.getViewport({ scale: 1 });
          const opList = (await page.getOperatorList()) as PdfOperatorList;
          const analysis = await analyzePageOperatorList(
            opList,
            ops,
            textRenderOps,
            textStructuralOps,
            {
              pageWidth: viewport.width,
              pageHeight: viewport.height,
              page,
            },
          );
          coverage = analysis.coverage;
          isColor = colorDetectionEnabled && analysis.hasColor;
          colorCoverage = isColor ? analysis.coverage : 0;
          isBlank = analysis.isBlank;
          coverageTier = resolveCoverageTier(coverage);
          classification = isBlank ? 'blank' : isColor ? 'color' : 'bw';
        } catch (opErr) {
          console.warn(
            `[document-analysis] Page ${pageNum} operator scan failed; defaulting to colored.`,
            opErr,
          );
          fallbackFlags.push('operator_scan_failed_default_color');
          coverage = 1;
          isColor = colorDetectionEnabled;
          colorCoverage = colorDetectionEnabled ? 1 : 0;
          isBlank = false;
          coverageTier = 'very_high';
          classification = colorDetectionEnabled ? 'color' : 'bw';
        }
      } finally {
        page.cleanup();
      }

      pages.push({
        index: pageNum,
        isColor,
        coverage,
        colorCoverage,
        coverageTier,
        classification,
        isBlank,
        contentCoverage: coverage,
        ...(fallbackFlags.length > 0
          ? { fallbackReasonFlags: fallbackFlags }
          : {}),
      });
    }
  } finally {
    await loadingTask.destroy();
  }

  const colorPages = pages.filter((page) => page.isColor).length;

  const confidence: AnalysisConfidence =
    fallbackPageCount === 0
      ? 'high'
      : fallbackPageCount >= totalPages
        ? 'low'
        : 'medium';

  return {
    fileType,
    pageCount: totalPages,
    pages,
    colorPages,
    bwPages: totalPages - colorPages,
    totalPages,
    confidence,
    analysisVersion: ANALYSIS_ALGORITHM_VERSION,
  };
}

function parseRgbArgs(args: unknown): [number, number, number] | null {
  if (!Array.isArray(args) || args.length === 0) return null;

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

  if (
    args.length >= 3 &&
    typeof args[0] === 'number' &&
    typeof args[1] === 'number' &&
    typeof args[2] === 'number'
  ) {
    return [
      Math.round(args[0] * 255),
      Math.round(args[1] * 255),
      Math.round(args[2] * 255),
    ];
  }

  return null;
}

interface PageAnalysisMetrics {
  hasColor: boolean;
  coverage: number;
  isBlank: boolean;
  classification: 'blank' | 'bw' | 'partial' | 'full_color' | 'image';
  isImagePage?: boolean;
  imageCoverage?: number;
}

interface PageOperatorScanOptions {
  pageWidth?: number;
  pageHeight?: number;
  isOriginalImage?: boolean;
  imageCoverageThreshold?: number;
  page?: PdfPageProxy;
}

type Matrix6 = [number, number, number, number, number, number];

export function hasVisibleGlyphs(args: unknown): boolean {
  if (!Array.isArray(args) || args.length === 0) return false;
  const glyphs = Array.isArray(args[args.length - 1])
    ? args[args.length - 1]
    : args[0];
  if (!Array.isArray(glyphs)) return false;
  for (const item of glyphs) {
    if (typeof item === 'string') {
      if (item.trim().length > 0) return true;
    } else if (item && typeof item === 'object') {
      const g = item as {
        isSpace?: boolean;
        unicode?: string;
        fontChar?: string;
      };
      if (g.isSpace) continue;
      const text = g.unicode ?? g.fontChar ?? '';
      if (text.trim().length > 0) return true;
    }
  }
  return false;
}

async function analyzePageOperatorList(
  opList: PdfOperatorList,
  ops: PdfOps,
  textRenderOps: Set<number> = new Set(),
  textStructuralOps: Set<number> = new Set(),
  options?: PageOperatorScanOptions,
): Promise<PageAnalysisMetrics> {
  const imagePaintOps = new Set(
    [
      ops.paintImageXObject,
      ops.paintInlineImageXObject,
      ops.paintImageMaskXObject,
      ops.paintJpegXObject,
    ].filter((op): op is number => typeof op === 'number'),
  );

  // Path-drawing ops commit ink to the page. Color-setting ops (setFillRGBColor
  // etc.) only mutate graphics state and must NOT be treated as content on their
  // own — a blank page can legitimately contain color-state ops (e.g. setting a
  // white fill) without rendering anything visible.
  const pathDrawingOps = new Set(
    [
      ops.fill,
      ops.eoFill,
      ops.stroke,
      ops.closeStroke,
      ops.fillStroke,
      ops.eoFillStroke,
      ops.closeFillStroke,
      ops.closeEOFillStroke,
      ops.shadingFill,
      ops.constructPath,
      ops.rawFillPath,
    ].filter((op): op is number => typeof op === 'number'),
  );

  let hasColor = false;
  let hasImages = false;
  let hasContent = false;

  // Tracks the active color in the graphics state
  let currentRgb: [number, number, number] | null = null;
  let currentCmyk: [number, number, number, number] | null = null;
  const colorStack: {
    rgb: [number, number, number] | null;
    cmyk: [number, number, number, number] | null;
  }[] = [];

  let contentOpsCount = 0;
  let totalNonStructuralOps = 0;

  let currentCtm: Matrix6 = [1, 0, 0, 1, 0, 0];
  const ctmStack: Matrix6[] = [];
  let totalImageArea = 0;

  for (let i = 0; i < opList.fnArray.length; i += 1) {
    const op = opList.fnArray[i];
    if (textStructuralOps.has(op)) continue;

    totalNonStructuralOps += 1;

    // ── CTM matrix tracking & graphics state stack ─────────────────────────
    if (op === ops.save) {
      ctmStack.push([...currentCtm]);
      colorStack.push({
        rgb: currentRgb ? [...currentRgb] : null,
        cmyk: currentCmyk ? [...currentCmyk] : null,
      });
      continue;
    }
    if (op === ops.restore) {
      currentCtm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0];
      const poppedColor = colorStack.pop();
      currentRgb = poppedColor ? poppedColor.rgb : null;
      currentCmyk = poppedColor ? poppedColor.cmyk : null;
      continue;
    }
    if (op === ops.transform) {
      const args = opList.argsArray[i];
      if (Array.isArray(args) && args.length >= 6) {
        const [a1, b1, c1, d1, e1, f1] = currentCtm;
        const [a2, b2, c2, d2, e2, f2] = args as number[];
        currentCtm = [
          a1 * a2 + b1 * c2,
          a1 * b2 + b1 * d2,
          c1 * a2 + d1 * c2,
          c1 * b2 + d1 * d2,
          e1 * a2 + f1 * c2 + e2,
          e1 * b2 + f1 * d2 + f2,
        ];
      }
      continue;
    }

    // ── Color-state ops: record color, but do NOT mark page as having content ──
    if (op === ops.setFillRGBColor || op === ops.setStrokeRGBColor) {
      currentRgb = parseRgbArgs(opList.argsArray[i]);
      currentCmyk = null;
      continue;
    }
    if (op === ops.setFillCMYKColor || op === ops.setStrokeCMYKColor) {
      const args = opList.argsArray[i];
      if (Array.isArray(args) && args.length >= 4) {
        currentCmyk = args as [number, number, number, number];
        currentRgb = null;
      }
      continue;
    }
    if (op === ops.setFillGray || op === ops.setStrokeGray) {
      currentRgb = null;
      currentCmyk = null;
      continue;
    }

    // ── Actual drawing ops: images, form XObjects, text renders, and path fills/strokes ──────
    const isImageOp = imagePaintOps.has(op);
    const isFormOp = op === ops.paintFormXObject;
    const isTextOp = textRenderOps.has(op);
    const isPathOp = pathDrawingOps.has(op);

    // Skip text operations that only contain invisible whitespace (e.g. spaces with colored styles)
    if (isTextOp && !hasVisibleGlyphs(opList.argsArray[i])) {
      continue;
    }

    const isDrawingOp = isImageOp || isFormOp || isPathOp || isTextOp;

    if (isDrawingOp) {
      contentOpsCount += 1;

      // ── White-paint guard ────────────────────────────────────────────────
      // Painting with white on a white page is invisible. Many PDF generators
      // emit a white fill rectangle as a page background — this should NOT mark
      // the page as having content. Images and text are always counted (they
      // have their own colour data / are intentional even if "invisible").
      if (isImageOp) {
        const det = Math.abs(
          currentCtm[0] * currentCtm[3] - currentCtm[1] * currentCtm[2],
        );
        if (Number.isFinite(det) && det > 0) {
          totalImageArea += det;
        }
      }

      const isWhitePaint =
        !isImageOp &&
        !isTextOp &&
        ((currentRgb !== null &&
          currentRgb[0] > 245 &&
          currentRgb[1] > 245 &&
          currentRgb[2] > 245) ||
          (currentRgb === null &&
            currentCmyk !== null &&
            currentCmyk[0] < 0.01 &&
            currentCmyk[1] < 0.01 &&
            currentCmyk[2] < 0.01 &&
            currentCmyk[3] < 0.01));

      // A path drawn with no explicit colour is in the current graphics state
      // (defaulting to black in PDF). Count it as real content.
      const isDefaultColorPaint =
        !isImageOp && !isTextOp && currentRgb === null && currentCmyk === null;

      if (!isWhitePaint) {
        hasContent = true;
      }

      // ── Color detection ──────────────────────────────────────────────────
      if (isImageOp) {
        hasImages = true;
        const args = opList.argsArray[i];
        const imageName =
          Array.isArray(args) && typeof args[0] === 'string'
            ? args[0]
            : null;
        if (imageName && options?.page) {
          const imageObj = await resolveImageObject(options.page, imageName);
          if (imageObj && getImageColorStats(imageObj).isColor) {
            hasColor = true;
          }
        }
      } else if (!isWhitePaint) {
        if (currentRgb && !isDefaultColorPaint) {
          const [r, g, b] = currentRgb;
          if (Math.max(r, g, b) - Math.min(r, g, b) > 15) {
            hasColor = true;
          }
        } else if (currentCmyk) {
          const [c, m, y] = currentCmyk;
          if (c > 0.05 || m > 0.05 || y > 0.05) {
            hasColor = true;
          }
        }
      }
    }
  }

  const isBlank = !hasContent;
  const estimatedCoverage =
    !isBlank && totalNonStructuralOps > 0
      ? Math.min(1.0, contentOpsCount / totalNonStructuralOps)
      : 0;

  const pageWidth = options?.pageWidth ?? 0;
  const pageHeight = options?.pageHeight ?? 0;
  const pageArea =
    pageWidth > 0 && pageHeight > 0 ? pageWidth * pageHeight : 0;
  const rawImageCoverage =
    pageArea > 0
      ? Math.min(1.0, totalImageArea / pageArea)
      : hasImages
        ? 0.5
        : 0;
  const imageCoverage = options?.isOriginalImage
    ? isBlank
      ? 0
      : 1.0
    : rawImageCoverage;
  // Only uploaded image file formats (converted to PDF) qualify for the image/photo pricing tier
  const isImagePage = Boolean(options?.isOriginalImage && !isBlank);

  let classification: 'blank' | 'bw' | 'partial' | 'full_color' | 'image';
  if (isBlank) {
    classification = 'blank';
  } else if (!hasColor) {
    classification = 'bw';
  } else if (isImagePage) {
    classification = 'image';
  } else if (estimatedCoverage > 0.8 || (hasImages && hasColor)) {
    classification = 'full_color';
  } else {
    classification = 'partial';
  }

  return {
    hasColor,
    coverage: estimatedCoverage,
    isBlank,
    classification,
    isImagePage,
    imageCoverage,
  };
}

/**
 * Direct implementation of document analysis, used within worker threads or as fallback.
 */
async function analyzeDocumentDirect(
  input: AnalyzeDocumentInput,
): Promise<DocumentAnalysisResult> {
  const contentType = (input.contentType ?? '').toLowerCase();
  const filename = input.filename ?? path.basename(input.filePath);
  const fileType = input.originalFileType ?? resolveFileType(contentType, filename);
  const colorDetectionEnabled = input.colorDetectionEnabled !== false;

  if (fileType === 'image' && path.extname(input.filePath).toLowerCase() !== '.pdf') {
    return analyzeImage(input.filePath, colorDetectionEnabled);
  }
  if (
    fileType === 'pdf' ||
    (fileType === 'image' && path.extname(input.filePath).toLowerCase() === '.pdf')
  ) {
    return analyzePdfFile(input.filePath, fileType, colorDetectionEnabled);
  }

  if (
    fileType === 'docx' ||
    fileType === 'doc' ||
    fileType === 'xlsx' ||
    fileType === 'xls' ||
    fileType === 'pptx' ||
    fileType === 'ppt'
  ) {
    const convert =
      input.convertToPdfPreview ??
      (await import('@/services/preview')).convertToPdfPreview;

    const pdfPath = await convert(input.filePath);
    return analyzePdfFile(pdfPath, fileType, colorDetectionEnabled);
  }

  throw new Error('Unsupported file type for analysis.');
}

interface AnalysisCacheEntry {
  mtimeMs: number;
  size: number;
  result: DocumentAnalysisResult;
  timestamp: number;
}

const analysisCache = new Map<string, AnalysisCacheEntry>();
const inFlightAnalysis = new Map<string, Promise<DocumentAnalysisResult>>();
const MAX_CACHE_ENTRIES = 200;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function clearDocumentAnalysisCache(filePath?: string): void {
  if (filePath) {
    const resolved = path.resolve(filePath);
    analysisCache.delete(`${resolved}:color`);
    analysisCache.delete(`${resolved}:bw`);
    analysisCache.delete(resolved);
  } else {
    analysisCache.clear();
  }
}

/**
 * Public entry point for document analysis. Caches results by file mtime and size,
 * and deduplicates concurrent analysis calls for the same file.
 */
export async function analyzeDocument(
  input: AnalyzeDocumentInput,
): Promise<DocumentAnalysisResult> {
  if (!isMainThread) return analyzeDocumentDirect(input);

  const resolvedPath = path.resolve(input.filePath);
  const isColorEnabled = input.colorDetectionEnabled !== false;
  const cacheKey = `${resolvedPath}:${isColorEnabled ? 'color' : 'bw'}`;

  let stat: fs.Stats | null = null;
  try {
    stat = await fs.promises.stat(resolvedPath);
  } catch {
    return analyzeDocumentDirect(input);
  }

  const cached = analysisCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    Date.now() - cached.timestamp < CACHE_TTL_MS
  ) {
    return cached.result;
  }

  const inFlight = inFlightAnalysis.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const analysisPromise = (async () => {
    try {
      const result = await analyzeDocumentDirect(input);
      if (stat) {
        if (analysisCache.size >= MAX_CACHE_ENTRIES) {
          const firstKey = analysisCache.keys().next().value;
          if (firstKey) analysisCache.delete(firstKey);
        }
        analysisCache.set(cacheKey, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          result,
          timestamp: Date.now(),
        });
      }
      return result;
    } finally {
      inFlightAnalysis.delete(cacheKey);
    }
  })();

  inFlightAnalysis.set(cacheKey, analysisPromise);
  return analysisPromise;
}

// Worker thread entry point
if (!isMainThread && parentPort) {
  (async () => {
    try {
      const result = await analyzeDocumentDirect(workerData);
      parentPort!.postMessage({ type: 'success', result });
    } catch (error) {
      parentPort!.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}
