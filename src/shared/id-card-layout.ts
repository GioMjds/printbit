/**
 * Geometry of an ID card copy sheet: front above back, each at real size.
 * Units are PDF points unless a name says millimetres.
 */
import {
  DEFAULT_PRINT_SCALING,
  PAPER_POINTS,
  calculatePrintLayout,
  type PaperSize,
} from './print-configuration';

export type IdSide = 'front' | 'back';
export type IdRotation = 0 | 90 | 180 | 270;

export const MM_TO_PT = 72 / 25.4;
export const ID_CARD_WIDTH_MM = 85.6;
export const ID_CARD_HEIGHT_MM = 54;
/** Visible window per side. Matches the worker's scan region. */
export const ID_SLOT_SIZE_MM = 100;
export const ID_SLOT_TOP_MM = 15;
export const ID_SLOT_GAP_MM = 10;

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
  /** Clip window for this side. */
  slot: IdRect;
  /** Footprint of the rotated scan on the sheet. */
  region: IdRect;
  rotationDeg: IdRotation;
}

export interface IdCardSheetLayout {
  pageWidth: number;
  pageHeight: number;
  /** Scale the print path applies to a full page. */
  fitScale: number;
  front: IdSidePlacement | null;
  back: IdSidePlacement | null;
}

/** Millimetres on the printed sheet, origin top-left. */
interface MmRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function fitScaleFor(paperSize: PaperSize): number {
  const [width, height] = PAPER_POINTS[paperSize];
  return calculatePrintLayout(width, height, {
    paperSize,
    scaling: DEFAULT_PRINT_SCALING,
    orientation: 'portrait',
    rotationDeg: 0,
  }).scale;
}

function printedCardMm(paperSize: PaperSize, side: IdSide): MmRect {
  const paperWidthMm = PAPER_POINTS[paperSize][0] / MM_TO_PT;
  const slotTop =
    side === 'front'
      ? ID_SLOT_TOP_MM
      : ID_SLOT_TOP_MM + ID_SLOT_SIZE_MM + ID_SLOT_GAP_MM;
  return {
    x: (paperWidthMm - ID_CARD_WIDTH_MM) / 2,
    y: slotTop + (ID_SLOT_SIZE_MM - ID_CARD_HEIGHT_MM) / 2,
    width: ID_CARD_WIDTH_MM,
    height: ID_CARD_HEIGHT_MM,
  };
}

function printedSlotMm(paperSize: PaperSize, side: IdSide): MmRect {
  const card = printedCardMm(paperSize, side);
  return {
    x: card.x - (ID_SLOT_SIZE_MM - ID_CARD_WIDTH_MM) / 2,
    y: card.y - (ID_SLOT_SIZE_MM - ID_CARD_HEIGHT_MM) / 2,
    width: ID_SLOT_SIZE_MM,
    height: ID_SLOT_SIZE_MM,
  };
}

/**
 * The scan (already cropped to the card when the card was found) is centred in
 * its slot, whatever the rotation. A region larger than the slot is shrunk to
 * fit, so a whole-glass fallback still shows everything. The slot clip keeps
 * the two sides apart.
 */
function printedRegionMm(
  paperSize: PaperSize,
  side: IdSide,
  input: IdSideInput,
): MmRect {
  const width = input.region.width / MM_TO_PT;
  const height = input.region.height / MM_TO_PT;
  const quarterTurn = input.rotationDeg === 90 || input.rotationDeg === 270;
  const rotatedWidth = quarterTurn ? height : width;
  const rotatedHeight = quarterTurn ? width : height;
  const slot = printedSlotMm(paperSize, side);
  const shrink = Math.min(
    1,
    slot.width / rotatedWidth,
    slot.height / rotatedHeight,
  );
  const fittedWidth = rotatedWidth * shrink;
  const fittedHeight = rotatedHeight * shrink;
  return {
    x: slot.x + (slot.width - fittedWidth) / 2,
    y: slot.y + (slot.height - fittedHeight) / 2,
    width: fittedWidth,
    height: fittedHeight,
  };
}

/** Enlarges a printed rectangle about the page centre and flips to PDF axes. */
function toSheetRect(
  rect: MmRect,
  pageWidth: number,
  pageHeight: number,
  fitScale: number,
): IdRect {
  const grow = 1 / fitScale;
  const centreX = pageWidth / 2;
  const centreY = pageHeight / 2;
  const left = centreX + (rect.x * MM_TO_PT - centreX) * grow;
  const top = centreY + (rect.y * MM_TO_PT - centreY) * grow;
  const width = rect.width * MM_TO_PT * grow;
  const height = rect.height * MM_TO_PT * grow;
  return { x: left, y: pageHeight - top - height, width, height };
}

export function idCardSheetLayout(
  paperSize: PaperSize,
  sides: Record<IdSide, IdSideInput | null>,
): IdCardSheetLayout {
  const [pageWidth, pageHeight] = PAPER_POINTS[paperSize];
  const fitScale = fitScaleFor(paperSize);
  const place = (side: IdSide): IdSidePlacement | null => {
    const input = sides[side];
    if (!input) return null;
    return {
      slot: toSheetRect(
        printedSlotMm(paperSize, side),
        pageWidth,
        pageHeight,
        fitScale,
      ),
      region: toSheetRect(
        printedRegionMm(paperSize, side, input),
        pageWidth,
        pageHeight,
        fitScale,
      ),
      rotationDeg: input.rotationDeg,
    };
  };
  return {
    pageWidth,
    pageHeight,
    fitScale,
    front: place('front'),
    back: place('back'),
  };
}

/** Slot position as fractions of the printed sheet, origin top-left. */
export function slotFractions(
  paperSize: PaperSize,
  side: IdSide,
): { left: number; top: number; width: number; height: number } {
  const [pageWidth, pageHeight] = PAPER_POINTS[paperSize];
  const slot = printedSlotMm(paperSize, side);
  return {
    left: (slot.x * MM_TO_PT) / pageWidth,
    top: (slot.y * MM_TO_PT) / pageHeight,
    width: (slot.width * MM_TO_PT) / pageWidth,
    height: (slot.height * MM_TO_PT) / pageHeight,
  };
}
