/** Wire/layout contract: see docs/printing-configuration.md. Units are PDF points. */
export type PaperSize = 'A4' | 'Letter' | 'Legal';
export type Orientation = 'portrait' | 'landscape';
export type PrintScaling = 'fit' | 'actual';
export const DEFAULT_PRINT_SCALING: PrintScaling = 'fit';
export const PRINT_MARGIN_POINTS = 14.4;
export const PAPER_POINTS = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
  Legal: [612, 1008],
} satisfies Record<PaperSize, readonly [number, number]>;

export interface PrintConfiguration {
  paperSize: PaperSize;
  scaling: PrintScaling;
  orientation: Orientation;
  rotationDeg: 0 | 90 | 180 | 270;
  colorMode: 'colored' | 'grayscale';
  quality: 'standard' | 'high';
  copies: number;
}

export type PrintLayoutConfiguration = Pick<
  PrintConfiguration,
  'paperSize' | 'scaling' | 'orientation' | 'rotationDeg'
>;

export function calculatePrintLayout(
  sourceWidth: number,
  sourceHeight: number,
  config: PrintLayoutConfiguration,
) {
  if (
    !(
      sourceWidth > 0 &&
      sourceHeight > 0 &&
      Number.isFinite(sourceWidth) &&
      Number.isFinite(sourceHeight)
    )
  ) {
    throw new Error('Invalid source page dimensions');
  }
  let [width, height] = PAPER_POINTS[config.paperSize];
  if (config.orientation === 'landscape') [width, height] = [height, width];
  const quarterTurn = config.rotationDeg === 90 || config.rotationDeg === 270;
  const contentWidth = quarterTurn ? sourceHeight : sourceWidth;
  const contentHeight = quarterTurn ? sourceWidth : sourceHeight;
  const scale =
    config.scaling === 'actual'
      ? 1
      : Math.min(
          (width - 2 * PRINT_MARGIN_POINTS) / contentWidth,
          (height - 2 * PRINT_MARGIN_POINTS) / contentHeight,
        );
  return {
    width,
    height,
    scale,
    x: (width - contentWidth * scale) / 2,
    y: (height - contentHeight * scale) / 2,
  };
}
