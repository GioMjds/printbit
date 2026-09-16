import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isMainThread, workerData, parentPort } from 'node:worker_threads';
import {
  COLOR_SATURATION_THRESHOLD,
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
 */
export const ANALYSIS_ALGORITHM_VERSION = 3;

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
  classification?: 'blank' | 'bw' | 'partial' | 'full_color';
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
}

interface AnalyzeDocumentInput {
  filePath: string;
  contentType?: string;
  filename?: string;
  convertToPdfPreview?: (sourcePath: string) => Promise<string>;
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

function resolveFileType(
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

async function analyzeImage(filePath: string): Promise<DocumentAnalysisResult> {
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
        ? metrics.colorCoverage > 0.95
          ? 'full_color'
          : 'partial'
        : 'bw',
    isBlank,
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
): Promise<DocumentAnalysisResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const ops = (pdfjs.OPS ?? {}) as PdfOps;
  const data = new Uint8Array(await fs.promises.readFile(pdfPath));

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
  const loadingTask = pdfjs.getDocument({ data, verbosity: 0 });
  const doc = await loadingTask.promise;

  const pages: PageAnalysis[] = [];
  let fallbackPageCount = 0;

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      let coverage = 0;
      let isColor = false;
      let classification: 'blank' | 'bw' | 'partial' | 'full_color' = 'bw';
      let isBlank = true;

      try {
        const opList = (await page.getOperatorList()) as PdfOperatorList;
        const analysis = analyzePageOperatorList(
          opList,
          ops,
          textRenderOps,
          textStructuralOps,
        );
        coverage = analysis.coverage;
        isColor = analysis.hasColor;
        isBlank = analysis.isBlank;
        classification = analysis.classification;
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
  const totalPages = pages.length;
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
  classification: 'blank' | 'bw' | 'partial' | 'full_color';
}

function analyzePageOperatorList(
  opList: PdfOperatorList,
  ops: PdfOps,
  textRenderOps: Set<number> = new Set(),
  textStructuralOps: Set<number> = new Set(),
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

  // Tracks the most-recently-set color so we can evaluate it when a draw op fires.
  let pendingRgb: [number, number, number] | null = null;
  let pendingCmyk: [number, number, number, number] | null = null;

  let contentOpsCount = 0;
  let totalNonStructuralOps = 0;

  for (let i = 0; i < opList.fnArray.length; i += 1) {
    const op = opList.fnArray[i];
    if (textStructuralOps.has(op)) continue;

    totalNonStructuralOps += 1;

    // ── Color-state ops: record color, but do NOT mark page as having content ──
    if (op === ops.setFillRGBColor || op === ops.setStrokeRGBColor) {
      pendingRgb = parseRgbArgs(opList.argsArray[i]);
      continue;
    }
    if (op === ops.setFillCMYKColor || op === ops.setStrokeCMYKColor) {
      const args = opList.argsArray[i];
      if (Array.isArray(args) && args.length >= 4) {
        pendingCmyk = args as [number, number, number, number];
      }
      continue;
    }

    // ── Actual drawing ops: images, text renders, and path fills/strokes ──────
    const isDrawingOp =
      op === ops.paintImageXObject ||
      op === ops.paintInlineImageXObject ||
      op === ops.paintImageMaskXObject ||
      op === ops.paintJpegXObject ||
      op === ops.paintFormXObject ||
      pathDrawingOps.has(op) ||
      textRenderOps.has(op);

    if (isDrawingOp) {
      contentOpsCount += 1;

      // ── White-paint guard ────────────────────────────────────────────────
      // Painting with white on a white page is invisible.  Many PDF generators
      // emit a white fill rectangle as a page background — this should NOT mark
      // the page as having content.  Images and text are always counted (they
      // have their own colour data / are intentional even if "invisible").
      const isImageOp = imagePaintOps.has(op) || op === ops.paintFormXObject;
      const isTextOp = textRenderOps.has(op);

      const isWhitePaint =
        !isImageOp &&
        !isTextOp &&
        // RGB white: all channels above 245
        ((pendingRgb !== null &&
          pendingRgb[0] > 245 &&
          pendingRgb[1] > 245 &&
          pendingRgb[2] > 245) ||
          // CMYK white: C=M=Y=K=0 (no ink at all)
          (pendingRgb === null &&
            pendingCmyk !== null &&
            pendingCmyk[0] < 0.01 &&
            pendingCmyk[1] < 0.01 &&
            pendingCmyk[2] < 0.01 &&
            pendingCmyk[3] < 0.01));

      // A path drawn with no explicit colour is in the current graphics state
      // (defaulting to black in PDF).  Count it as real content.
      const isDefaultColorPaint =
        !isImageOp && !isTextOp && pendingRgb === null && pendingCmyk === null;

      if (!isWhitePaint) {
        hasContent = true;
      }

      // ── Color detection ──────────────────────────────────────────────────
      if (isImageOp) {
        hasImages = true;
        hasColor = true;
      } else if (!isWhitePaint) {
        if (pendingRgb && !isDefaultColorPaint) {
          const [r, g, b] = pendingRgb;
          if (Math.max(r, g, b) - Math.min(r, g, b) > 15) {
            hasColor = true;
          }
        } else if (pendingCmyk) {
          const [c, m, y] = pendingCmyk;
          if (c > 0.05 || m > 0.05 || y > 0.05) {
            hasColor = true;
          }
        }
      }

      pendingRgb = null;
      pendingCmyk = null;
    }
  }

  const isBlank = !hasContent;
  const estimatedCoverage =
    !isBlank && totalNonStructuralOps > 0
      ? Math.min(1.0, contentOpsCount / totalNonStructuralOps)
      : 0;
  let classification: 'blank' | 'bw' | 'partial' | 'full_color';
  if (isBlank) {
    classification = 'blank';
  } else if (!hasColor) {
    classification = 'bw';
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
  const fileType = resolveFileType(contentType, filename);

  if (fileType === 'image') return analyzeImage(input.filePath);
  if (fileType === 'pdf') return analyzePdfFile(input.filePath, fileType);

  if (
    fileType === 'docx' ||
    fileType === 'doc' ||
    fileType === 'xlsx' ||
    fileType === 'xls' ||
    fileType === 'pptx' ||
    fileType === 'ppt'
  ) {
    if (!input.convertToPdfPreview) {
      throw new Error(
        'Document conversion function is required for Office document analysis.',
      );
    }

    const pdfPath = await input.convertToPdfPreview(input.filePath);
    return analyzePdfFile(pdfPath, fileType);
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
    analysisCache.delete(path.resolve(filePath));
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

  let stat: fs.Stats | null = null;
  try {
    stat = await fs.promises.stat(resolvedPath);
  } catch {
    return analyzeDocumentDirect(input);
  }

  const cached = analysisCache.get(resolvedPath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    Date.now() - cached.timestamp < CACHE_TTL_MS
  ) {
    return cached.result;
  }

  const inFlight = inFlightAnalysis.get(resolvedPath);
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
        analysisCache.set(resolvedPath, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          result,
          timestamp: Date.now(),
        });
      }
      return result;
    } finally {
      inFlightAnalysis.delete(resolvedPath);
    }
  })();

  inFlightAnalysis.set(resolvedPath, analysisPromise);
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
