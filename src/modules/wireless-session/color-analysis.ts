export interface ColorAnalysisResponse {
  hasColor: boolean;
  isGrayscale: boolean;
  sampledPages: number;
}

/** Answer used when no analysis is available. Color is the safe default. */
export const COLOR_ANALYSIS_FALLBACK: ColorAnalysisResponse = {
  hasColor: true,
  isGrayscale: false,
  sampledPages: 0,
};

/**
 * Derives the /color-analysis answer from the pricing analysis.
 *
 * The /config page uses this answer to pick the default color mode. Pricing
 * bills color per page from the same analysis (`colorPages`). Deriving one
 * from the other means the default mode and the price cannot disagree.
 */
export function colorAnalysisFromDocumentAnalysis(
  analysis: { colorPages: number; pageCount: number } | null | undefined,
): ColorAnalysisResponse {
  if (
    !analysis ||
    !Number.isFinite(analysis.colorPages) ||
    !Number.isFinite(analysis.pageCount)
  ) {
    return { ...COLOR_ANALYSIS_FALLBACK };
  }
  const hasColor = analysis.colorPages > 0;
  return {
    hasColor,
    isGrayscale: !hasColor,
    sampledPages: Math.max(0, Math.floor(analysis.pageCount)),
  };
}
