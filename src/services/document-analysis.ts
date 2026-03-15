import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  COLOR_SATURATION_THRESHOLD,
  MAX_PIXELS_TO_SAMPLE,
} from '../config/document-analysis.config';

export type AnalyzedFileType = 'pdf' | 'docx' | 'doc' | 'image' | 'unknown';

export interface PageAnalysis {
  index: number;
  isColor: boolean;
}

export interface DocumentAnalysisResult {
  fileType: AnalyzedFileType;
  pageCount: number;
  pages: PageAnalysis[];
  colorPages: number;
  bwPages: number;
  totalPages: number;
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

function isColorFrame(frame: RgbaFrame): boolean {
  const totalPixels = frame.width * frame.height;
  if (totalPixels === 0) return false;

  const step = Math.max(1, Math.ceil(totalPixels / MAX_PIXELS_TO_SAMPLE));
  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += step) {
    const offset = pixelIndex * 4;
    const alpha = frame.data[offset + 3];
    if (alpha < 8) continue;

    const r = frame.data[offset];
    const g = frame.data[offset + 1];
    const b = frame.data[offset + 2];

    if (isColorPixel(r, g, b)) {
      return true;
    }
  }

  return false;
}

async function analyzeImage(filePath: string): Promise<DocumentAnalysisResult> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const page: PageAnalysis = {
    index: 1,
    isColor: isColorFrame({ data, width: info.width, height: info.height }),
  };

  return {
    fileType: 'image',
    pageCount: 1,
    pages: [page],
    colorPages: page.isColor ? 1 : 0,
    bwPages: page.isColor ? 0 : 1,
    totalPages: 1,
  };
}

async function analyzePdfFile(
  pdfPath: string,
  fileType: AnalyzedFileType,
): Promise<DocumentAnalysisResult> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as any;
  const ops = (pdfjs.OPS ?? {}) as PdfOps;
  const data = new Uint8Array(await fs.promises.readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

  const pages: PageAnalysis[] = [];

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      let isColor = true;
      try {
        const opList = (await page.getOperatorList()) as PdfOperatorList;
        isColor = isPdfPageColorByOperatorList(opList, ops);
      } catch (error) {
        console.warn(
          `[document-analysis] Page ${pageNum} operator scan failed; defaulting to colored.`,
          error,
        );
        isColor = true;
      } finally {
        page.cleanup();
      }

      pages.push({ index: pageNum, isColor });
    }
  } finally {
    await doc.destroy();
  }

  const colorPages = pages.filter((page) => page.isColor).length;
  const totalPages = pages.length;

  return {
    fileType,
    pageCount: totalPages,
    pages,
    colorPages,
    bwPages: totalPages - colorPages,
    totalPages,
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

function isPdfPageColorByOperatorList(
  opList: PdfOperatorList,
  ops: PdfOps,
): boolean {
  const imagePaintOps = new Set(
    [
      ops.paintImageXObject,
      ops.paintInlineImageXObject,
      ops.paintImageMaskXObject,
      ops.paintJpegXObject,
    ].filter((op): op is number => typeof op === 'number'),
  );

  for (let i = 0; i < opList.fnArray.length; i += 1) {
    const op = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (imagePaintOps.has(op)) {
      // Conservative pricing safety rule: treat image-heavy pages as colored.
      return true;
    }

    if (op === ops.setFillRGBColor || op === ops.setStrokeRGBColor) {
      const rgb = parseRgbArgs(args);
      if (!rgb) continue;
      const [r, g, b] = rgb;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      if (spread > 10) return true;
    }

    if (op === ops.setFillCMYKColor || op === ops.setStrokeCMYKColor) {
      if (!Array.isArray(args) || args.length < 4) continue;
      const [c, m, y] = args as number[];
      if (c > 0.01 || m > 0.01 || y > 0.01) return true;
    }
  }

  return false;
}

export async function analyzeDocument(
  input: AnalyzeDocumentInput,
): Promise<DocumentAnalysisResult> {
  const contentType = (input.contentType ?? '').toLowerCase();
  const filename = input.filename ?? path.basename(input.filePath);
  const fileType = resolveFileType(contentType, filename);

  if (fileType === 'image') {
    return analyzeImage(input.filePath);
  }

  if (fileType === 'pdf') {
    return analyzePdfFile(input.filePath, fileType);
  }

  if (fileType === 'docx' || fileType === 'doc') {
    if (!input.convertToPdfPreview) {
      throw new Error(
        'Document conversion function is required for DOC/DOCX analysis.',
      );
    }

    const pdfPath = await input.convertToPdfPreview(input.filePath);
    return analyzePdfFile(pdfPath, fileType);
  }

  throw new Error('Unsupported file type for analysis.');
}
