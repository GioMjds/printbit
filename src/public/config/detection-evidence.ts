export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface ColorDetectionEvidence {
  colorPages: number;
  grayscalePages: number;
  selectedPages: number;
  meteredCoveragePercentage: number;
  colorPercentage: number;
  confidence: DetectionConfidence;
}

export interface ColorEvidenceInput {
  selectedColorPages: number;
  selectedBwPages: number;
  analysisConfidence: DetectionConfidence;
  pageBreakdown?: Array<{ coverage?: number; coverageTier?: string }>;
  meteredCoveragePercentage?: number;
}

function safePageCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function buildColorDetectionEvidence(
  input: ColorEvidenceInput,
): ColorDetectionEvidence {
  const colorPages = safePageCount(input.selectedColorPages);
  const grayscalePages = safePageCount(input.selectedBwPages);
  const selectedPages = colorPages + grayscalePages;

  let meteredCoveragePercentage = 0;
  if (
    typeof input.meteredCoveragePercentage === 'number' &&
    Number.isFinite(input.meteredCoveragePercentage)
  ) {
    meteredCoveragePercentage = Math.max(
      0,
      Math.min(100, Math.round(input.meteredCoveragePercentage)),
    );
  } else if (input.pageBreakdown && input.pageBreakdown.length > 0) {
    const total = input.pageBreakdown.reduce(
      (sum, p) =>
        sum +
        (typeof p.coverage === 'number' && Number.isFinite(p.coverage)
          ? p.coverage
          : 0),
      0,
    );
    meteredCoveragePercentage = Math.max(
      0,
      Math.min(100, Math.round((total / input.pageBreakdown.length) * 100)),
    );
  }

  return {
    colorPages,
    grayscalePages,
    selectedPages,
    meteredCoveragePercentage,
    colorPercentage: meteredCoveragePercentage,
    confidence: input.analysisConfidence,
  };
}
