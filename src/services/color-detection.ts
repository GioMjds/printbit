/**
 * @file color-detection.ts
 * @description Helpers for sampling embedded PDF images for chromatic (color)
 * content. They serve the operator-list fallback in document-analysis.ts.
 *
 * There is deliberately no whole-document detector here. The default color
 * mode shown on /config and the price must come from the same analysis
 * (analyzeDocument), otherwise the two can disagree.
 */

/** The maximum difference between R, G, and B values to be considered grayscale. */
const RGB_SPREAD_THRESHOLD = 10;
/** Target number of pixels to sample when analyzing embedded images to balance accuracy and performance. */
const IMAGE_SAMPLE_PIXEL_TARGET = 10_000;
/** The minimum ratio of colored pixels to sampled pixels required to classify an image as "colored". */
const IMAGE_COLOR_RATIO_THRESHOLD = 0.001;

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
  /** Objects that belong to this page only. */
  objs?: PdfObjectStore;
  /** Objects shared across the document (fonts, images reused on many pages). */
  commonObjs?: PdfObjectStore;
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
  // pdf.js keeps an image that is reused across pages (a logo, a letterhead)
  // in the document-level store under an id that starts with "g_". Asking the
  // page store for it never answers, so the lookup used to wait out the
  // timeout below and then skip the image, which could report a colored logo
  // as grayscale.
  const objs = imageName.startsWith('g_') ? page.commonObjs : page.objs;
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
