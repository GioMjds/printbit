import fs from 'node:fs';

const RGB_SPREAD_THRESHOLD = 10;
const CMYK_COLOR_THRESHOLD = 0.01;

export interface ColorDetectionResult {
  hasColor: boolean;
  isGrayscale: boolean;
  sampledPages: number;
}

/** Parse pdfjs RGB args — may be ["#rrggbb"] or [r, g, b] floats (0–1) */
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
    return [
      Math.round(args[0] * 255),
      Math.round(args[1] * 255),
      Math.round(args[2] * 255),
    ];
  }

  return null;
}

export async function detectPdfColorContent(
  pdfPath: string,
): Promise<ColorDetectionResult> {
  if (!fs.existsSync(pdfPath)) {
    console.warn('[colorDetection] File not found, defaulting to color.');
    return { hasColor: true, isGrayscale: false, sampledPages: 0 };
  }

  try {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as any;
    const OPS = pdfjs.OPS;

    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

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
            await doc.destroy();
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
            await doc.destroy();
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
          `rgb_ops=${rgbColorCount} (grey=${rgbGrayCount}) cmyk_ops=${cmykCount} gray_ops=${grayCount} — no color`,
      );

      page.cleanup();
    }

    await doc.destroy();
    console.log(
      `[colorDetection] ✗ Classified as GRAYSCALE after all ${totalPages} pages`,
    );
    return { hasColor: false, isGrayscale: true, sampledPages: totalPages };
  } catch (err) {
    console.warn('[colorDetection] Detection error, defaulting to color:', err);
    return { hasColor: true, isGrayscale: false, sampledPages: 0 };
  }
}
