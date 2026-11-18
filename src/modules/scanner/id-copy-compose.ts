import fs from 'node:fs';
import {
  BlendMode,
  PDFDocument,
  degrees,
  type PDFEmbeddedPage,
} from 'pdf-lib';
import {
  idCardSheetLayout,
  type IdRotation,
  type IdSide,
  type IdSidePlacement,
} from '@/shared/id-card-layout';
import { PAPER_POINTS, type PaperSize } from '@/shared/print-configuration';

export interface IdSheetSideInput {
  filePath: string;
  rotationDeg: IdRotation;
}

export interface ComposeIdSheetInput {
  paperSize: PaperSize;
  front: IdSheetSideInput | null;
  back: IdSheetSideInput | null;
}

export interface RegionDrawOptions {
  x: number;
  y: number;
  /** Unrotated draw size. */
  width: number;
  height: number;
  /** Counter-clockwise degrees, as pdf-lib expects. */
  rotateDeg: number;
}

/**
 * Turns a rotated footprint into pdf-lib draw options. pdf-lib rotates
 * counter-clockwise about (x, y), so a clockwise turn starts from the corner
 * that the unrotated page's bottom-left ends up on.
 */
export function regionDrawOptions(
  placement: IdSidePlacement,
): RegionDrawOptions {
  const { x, y, width, height } = placement.region;
  switch (placement.rotationDeg) {
    case 90:
      return { x, y: y + height, width: height, height: width, rotateDeg: -90 };
    case 180:
      return { x: x + width, y: y + height, width, height, rotateDeg: 180 };
    case 270:
      return { x: x + width, y, width: height, height: width, rotateDeg: 90 };
    default:
      return { x, y, width, height, rotateDeg: 0 };
  }
}

async function embedFirstPage(
  out: PDFDocument,
  filePath: string,
): Promise<PDFEmbeddedPage> {
  const bytes = await fs.promises.readFile(filePath);
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const [embedded] = await out.embedPdf(source, [0]);
  return embedded;
}

/** Builds the one-page ID copy sheet. A side that is null is left empty. */
export async function composeIdSheet(
  input: ComposeIdSheetInput,
): Promise<Uint8Array> {
  if (!input.front && !input.back) {
    throw new Error('No ID side to compose.');
  }

  const out = await PDFDocument.create();
  const [pageWidth, pageHeight] = PAPER_POINTS[input.paperSize];
  const page = out.addPage([pageWidth, pageHeight]);

  const embedded: Record<IdSide, PDFEmbeddedPage | null> = {
    front: input.front ? await embedFirstPage(out, input.front.filePath) : null,
    back: input.back ? await embedFirstPage(out, input.back.filePath) : null,
  };

  const sideInput = (side: IdSide) => {
    const source = input[side];
    const pageRef = embedded[side];
    if (!source || !pageRef) return null;
    return {
      region: { width: pageRef.width, height: pageRef.height },
      rotationDeg: source.rotationDeg,
    };
  };

  const layout = idCardSheetLayout(input.paperSize, {
    front: sideInput('front'),
    back: sideInput('back'),
  });

  for (const side of ['front', 'back'] as const) {
    const placement = layout[side];
    const pageRef = embedded[side];
    if (!placement || !pageRef) continue;
    const draw = regionDrawOptions(placement);
    // Multiply keeps the white glass of one scan from covering the card on
    // the other, like toner from two passes on the same paper.
    page.drawPage(pageRef, {
      x: draw.x,
      y: draw.y,
      width: draw.width,
      height: draw.height,
      rotate: degrees(draw.rotateDeg),
      blendMode: BlendMode.Multiply,
    });
  }

  return out.save();
}
