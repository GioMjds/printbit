/**
 * Geometry of an ID card copy sheet. Like a normal photocopy run twice on one
 * paper: each side's full-glass scan is fitted to the sheet at the same place,
 * and the customer keeps the two sides apart on the glass.
 * Units are PDF points.
 */
import { PAPER_POINTS, type PaperSize } from './print-configuration';

export type IdSide = 'front' | 'back';
export type IdRotation = 0 | 90 | 180 | 270;

/** PDF points, origin bottom-left. */
export interface IdRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IdSideInput {
  /** Unrotated size of the scanned page, in points. */
  region: { width: number; height: number };
  rotationDeg: IdRotation;
}

export interface IdSidePlacement {
  /** Footprint of the rotated scan on the sheet. */
  region: IdRect;
  rotationDeg: IdRotation;
}

export interface IdCardSheetLayout {
  pageWidth: number;
  pageHeight: number;
  front: IdSidePlacement | null;
  back: IdSidePlacement | null;
}

/** The rotated scan, scaled to fit the sheet and centred on it. */
function fitOnSheet(
  pageWidth: number,
  pageHeight: number,
  input: IdSideInput,
): IdRect {
  const quarterTurn = input.rotationDeg === 90 || input.rotationDeg === 270;
  const width = quarterTurn ? input.region.height : input.region.width;
  const height = quarterTurn ? input.region.width : input.region.height;
  const scale = Math.min(pageWidth / width, pageHeight / height);
  return {
    x: (pageWidth - width * scale) / 2,
    y: (pageHeight - height * scale) / 2,
    width: width * scale,
    height: height * scale,
  };
}

export function idCardSheetLayout(
  paperSize: PaperSize,
  sides: Record<IdSide, IdSideInput | null>,
): IdCardSheetLayout {
  const [pageWidth, pageHeight] = PAPER_POINTS[paperSize];
  const place = (side: IdSide): IdSidePlacement | null => {
    const input = sides[side];
    if (!input) return null;
    return {
      region: fitOnSheet(pageWidth, pageHeight, input),
      rotationDeg: input.rotationDeg,
    };
  };
  return { pageWidth, pageHeight, front: place('front'), back: place('back') };
}
