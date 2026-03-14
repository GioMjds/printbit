import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas } from 'canvas';
import {
  COLOR_SATURATION_THRESHOLD,
  MAX_PIXELS_TO_SAMPLE,
  PDF_RENDER_SCALE,
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
  const data = new Uint8Array(await fs.promises.readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

  const pages: PageAnalysis[] = [];

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const canvas = createCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
      );
      const context = canvas.getContext('2d');

      await page.render({
        canvasContext: context,
        viewport,
      }).promise;

      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const isColor = isColorFrame({
        data: imageData.data,
        width: canvas.width,
        height: canvas.height,
      });

      pages.push({ index: pageNum, isColor });
      page.cleanup();
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
