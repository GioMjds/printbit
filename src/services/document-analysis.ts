import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isMainThread, workerData, parentPort } from 'node:worker_threads';
import {
  COLOR_SATURATION_THRESHOLD,
  LOW_CONTENT_COVERAGE_THRESHOLD,
  MAX_PIXELS_TO_SAMPLE,
} from '@/config/document-analysis.config';

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
 */
export const ANALYSIS_ALGORITHM_VERSION = 5;

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
  coverage?: number;
  /**
   * Ratio of all visible non-white content on the page.
   * `coverage` tracks color coverage for pricing tiers; this field is used
   * to decide whether a B/W page is genuinely near-blank.
   */
  contentCoverage?: number;
  classification?: 'blank' | 'bw' | 'partial' | 'full_color' | 'image';
  /** True when the source file is a raster image (uploaded image file). Used for photo/image pricing tier. */
  isImagePage?: boolean;
  imageCoverage?: number;
  isBlank?: boolean;
  fallbackReasonFlags?: string[];
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
  blankPages: number[];
  blankPageCount: number;
  isEntirelyBlank: boolean;
  lowContentPages: number[];
  lowContentPageCount: number;
  hasLowContent: boolean;
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
    ext === '.webp'
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

function computeDocumentContentMetrics(
  pages: PageAnalysis[],
  totalPages: number,
) {
  const blankPages = pages.filter((p) => p.isBlank).map((p) => p.index);
  const blankPageCount = blankPages.length;
  const isEntirelyBlank = totalPages > 0 && blankPageCount === totalPages;
  const lowContentPages = pages
    .filter(
      (p) =>
        !p.isBlank &&
        (p.contentCoverage ?? p.coverage ?? 0) <
          LOW_CONTENT_COVERAGE_THRESHOLD,
    )
    .map((p) => p.index);
  const lowContentPageCount = lowContentPages.length;
  const hasLowContent = lowContentPageCount > 0;

  return {
    blankPages,
    blankPageCount,
    isEntirelyBlank,
    lowContentPages,
    lowContentPageCount,
    hasLowContent,
  };
}

async function analyzeImage(
  filePath: string,
  colorDetectionEnabled: boolean = true,
): Promise<DocumentAnalysisResult> {
  if (!colorDetectionEnabled) {
    const page: PageAnalysis = {
      index: 1,
      isColor: false,
      coverage: 0,
      contentCoverage: 0,
      classification: 'bw',
      isImagePage: true,
      imageCoverage: 1.0,
      isBlank: false,
    };
    const pages = [page];
    const {
      blankPages,
      blankPageCount,
      isEntirelyBlank,
      lowContentPages,
      lowContentPageCount,
      hasLowContent,
    } = computeDocumentContentMetrics(pages, 1);

    return {
      fileType: 'image',
      pageCount: 1,
      pages,
      colorPages: 0,
      bwPages: 1,
      totalPages: 1,
      confidence: 'high',
      analysisVersion: ANALYSIS_ALGORITHM_VERSION,
      blankPages,
      blankPageCount,
      isEntirelyBlank,
      lowContentPages,
      lowContentPageCount,
      hasLowContent,
    };
  }

  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const metrics = computeFrameMetrics({
    data,
    width: info.width,
    height: info.height,
  });
  const isBlank = metrics.contentCoverage < 0.001;
  const isColor = !isBlank && metrics.colorCoverage > 0.05; // Threshold: > 5% color pixels = colored page

  const page: PageAnalysis = {
    index: 1,
    isColor,
    coverage: metrics.colorCoverage,
    contentCoverage: metrics.contentCoverage,
    classification: isBlank
      ? 'blank'
      : isColor
        ? 'image' // Source-file images always get photo/image pricing tier
        : 'bw',
    isImagePage: !isBlank, // Mark as image page for photo pricing (blank images are excluded)
    imageCoverage: isBlank ? 0 : 1.0,
    isBlank,
  };

  const pages = [page];
  const {
    blankPages,
    blankPageCount,
    isEntirelyBlank,
    lowContentPages,
    lowContentPageCount,
    hasLowContent,
  } = computeDocumentContentMetrics(pages, 1);

  return {
    fileType: 'image',
    pageCount: 1,
    pages,
    colorPages: page.isColor ? 1 : 0,
    bwPages: page.isColor ? 0 : 1,
    totalPages: 1,
    confidence: 'high',
    analysisVersion: ANALYSIS_ALGORITHM_VERSION,
    blankPages,
    blankPageCount,
    isEntirelyBlank,
    lowContentPages,
    lowContentPageCount,
    hasLowContent,
  };
}

async function analyzePdfFile(
  pdfPath: string,
  fileType: AnalyzedFileType,
  colorDetectionEnabled: boolean = true,
  options?: { isOriginalImage?: boolean },
): Promise<DocumentAnalysisResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.promises.readFile(pdfPath));
  const loadingTask = pdfjs.getDocument({ data, verbosity: 0 });
  const doc = await loadingTask.promise;
  const totalPages = doc.numPages;

  if (!colorDetectionEnabled) {
    await loadingTask.destroy();
    const pages: PageAnalysis[] = [];
    for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
      const isBlank = false;
      const isColor = false;
      pages.push({
        index: pageNum,
        isColor: false,
        coverage: 0,
        contentCoverage: 0,
        classification: options?.isOriginalImage
          ? isBlank
            ? 'blank'
            : isColor
              ? 'image'
              : 'bw'
          : 'bw',
        isBlank: false,
        ...(options?.isOriginalImage
          ? {
              isImagePage: !isBlank,
              imageCoverage: isBlank ? 0 : 1.0,
            }
          : {}),
      });
    }
    const {
      blankPages,
      blankPageCount,
      isEntirelyBlank,
      lowContentPages,
      lowContentPageCount,
      hasLowContent,
    } = computeDocumentContentMetrics(pages, totalPages);

    return {
      fileType,
      pageCount: totalPages,
      pages,
      colorPages: 0,
      bwPages: totalPages,
      totalPages,
      confidence: 'high',
      analysisVersion: ANALYSIS_ALGORITHM_VERSION,
      blankPages,
      blankPageCount,
      isEntirelyBlank,
      lowContentPages,
      lowContentPageCount,
      hasLowContent,
    };
  }

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
      let isColor = false;
      let classification: 'blank' | 'bw' | 'partial' | 'full_color' | 'image' = 'bw';
      let isBlank = true;
      let isImagePage = false;
      let imageCoverage = 0;

      try {
        const viewport = page.getViewport({ scale: 1 });
        const opList = (await page.getOperatorList()) as PdfOperatorList;
        const analysis = analyzePageOperatorList(
          opList,
          ops,
          textRenderOps,
          textStructuralOps,
          {
            pageWidth: viewport.width,
            pageHeight: viewport.height,
            isOriginalImage: options?.isOriginalImage,
          },
        );
        coverage = analysis.coverage;
        isColor = analysis.hasColor;
        isBlank = analysis.isBlank;
        classification = analysis.classification;
        isImagePage = Boolean(analysis.isImagePage);
        imageCoverage = analysis.imageCoverage ?? 0;
      } catch (error) {
        console.warn(
          `[document-analysis] Page ${pageNum} operator scan failed; defaulting to colored.`,
          error,
        );
        coverage = 1;
        isColor = true;
        classification = 'full_color';
        fallbackPageCount += 1;
      } finally {
        page.cleanup();
      }

      pages.push({
        index: pageNum,
        isColor,
        coverage,
        contentCoverage: coverage,
        classification,
        isBlank,
        isImagePage,
        imageCoverage,
        fallbackReasonFlags:
          fallbackPageCount > 0
            ? ['operator_scan_failed_default_color']
            : undefined,
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

  const {
    blankPages,
    blankPageCount,
    isEntirelyBlank,
    lowContentPages,
    lowContentPageCount,
    hasLowContent,
  } = computeDocumentContentMetrics(pages, totalPages);

  return {
    fileType,
    pageCount: totalPages,
    pages,
    colorPages,
    bwPages: totalPages - colorPages,
    totalPages,
    confidence,
    analysisVersion: ANALYSIS_ALGORITHM_VERSION,
    blankPages,
    blankPageCount,
    isEntirelyBlank,
    lowContentPages,
    lowContentPageCount,
    hasLowContent,
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
}

type Matrix6 = [number, number, number, number, number, number];

function analyzePageOperatorList(
  opList: PdfOperatorList,
  ops: PdfOps,
  textRenderOps: Set<number> = new Set(),
  textStructuralOps: Set<number> = new Set(),
  options?: PageOperatorScanOptions,
): PageAnalysisMetrics {
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

    // ── Actual drawing ops: images, form XObjects, text renders, and path fills/strokes ──────
    const isImageOp = imagePaintOps.has(op);
    const isFormOp = op === ops.paintFormXObject;
    const isTextOp = textRenderOps.has(op);
    const isPathOp = pathDrawingOps.has(op);
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
        hasColor = true;
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
  const threshold = options?.imageCoverageThreshold ?? 0.50;
  const isImagePage = options?.isOriginalImage
    ? !isBlank
    : imageCoverage >= threshold;

  let classification: 'blank' | 'bw' | 'partial' | 'full_color' | 'image';
  if (isBlank) {
    classification = 'blank';
  } else if (!hasColor) {
    classification = 'bw';
  } else if (isImagePage) {
    classification = 'image';
  } else if (estimatedCoverage > 0.8 || hasImages) {
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
    return analyzePdfFile(input.filePath, fileType, colorDetectionEnabled, {
      isOriginalImage: fileType === 'image',
    });
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
