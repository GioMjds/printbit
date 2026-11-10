import {
  DEFAULT_PRINT_SCALING,
  calculatePrintLayout,
  type PaperSize,
  type PrintLayoutConfiguration,
} from '../../shared/print-configuration';

/**
 * One sheet renderer for the kiosk previews (/config and /copy). Both pages
 * draw the source page onto a paper-shaped canvas with the shared print layout
 * (margins, fit or actual), so the preview matches the printed sheet.
 */
export interface SheetRender {
  /** pdf.js viewport scale for the source page. */
  renderScale: number;
  canvasWidth: number;
  canvasHeight: number;
  rotationRad: number;
}

export function computeSheetRender(
  sourceWidth: number,
  sourceHeight: number,
  config: PrintLayoutConfiguration,
  sheetWidthPx: number,
  sheetHeightPx: number,
  devicePixelRatio: number,
): SheetRender {
  const layout = calculatePrintLayout(sourceWidth, sourceHeight, config);
  const pixelsPerPoint = (sheetWidthPx / layout.width) * devicePixelRatio;
  return {
    renderScale: layout.scale * pixelsPerPoint,
    canvasWidth: Math.max(1, Math.ceil(sheetWidthPx * devicePixelRatio)),
    canvasHeight: Math.max(1, Math.ceil(sheetHeightPx * devicePixelRatio)),
    rotationRad: (config.rotationDeg * Math.PI) / 180,
  };
}

/** Largest sheet with the paper's aspect ratio that fits in the box. */
export function fitSheetInBox(
  paperWidth: number,
  paperHeight: number,
  boxWidth: number,
  boxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(boxWidth / paperWidth, boxHeight / paperHeight);
  return { width: paperWidth * scale, height: paperHeight * scale };
}

/**
 * The layout /config starts with for a copy: the selected paper, fit scaling,
 * no rotation, and the sheet turned to match the scan.
 */
export function defaultCopyLayout(
  paperSize: PaperSize,
  sourceWidth: number,
  sourceHeight: number,
): PrintLayoutConfiguration {
  return {
    paperSize,
    scaling: DEFAULT_PRINT_SCALING,
    orientation: sourceWidth > sourceHeight ? 'landscape' : 'portrait',
    rotationDeg: 0,
  };
}

/** Paints a white sheet, then the rendered page centered and rotated on it. */
export function paintPageOnSheet(
  ctx: CanvasRenderingContext2D,
  sheet: { width: number; height: number },
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  rotationRad: number,
): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.save();
  ctx.translate(sheet.width / 2, sheet.height / 2);
  ctx.rotate(rotationRad);
  ctx.drawImage(
    source,
    -sourceWidth / 2,
    -sourceHeight / 2,
    sourceWidth,
    sourceHeight,
  );
  ctx.restore();
}
