export type DetectionConfidence = 'high' | 'medium' | 'low';
export type CoverageTier = 'low' | 'medium' | 'high' | 'very_high';

export interface CoverageTierInfo {
  tier: CoverageTier;
  label: string;
  rangeLabel: string;
}

export function getCoverageTierInfo(coveragePercent: number): CoverageTierInfo {
  const p = Math.max(0, Math.min(100, Math.round(coveragePercent)));
  if (p <= 10) {
    return { tier: 'low', label: 'Low', rangeLabel: '0% - 10%' };
  }
  if (p <= 40) {
    return { tier: 'medium', label: 'Medium', rangeLabel: '11% - 40%' };
  }
  if (p <= 70) {
    return { tier: 'high', label: 'High', rangeLabel: '41% - 70%' };
  }
  return { tier: 'very_high', label: 'Max', rangeLabel: '71% - 100%' };
}

export interface ColorDetectionEvidence {
  colorPages: number;
  grayscalePages: number;
  selectedPages: number;
  meteredCoveragePercentage: number;
  colorPercentage: number;
  coverageTier: CoverageTier;
  tierLabel: string;
  tierRangeLabel: string;
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

  const tierInfo = getCoverageTierInfo(meteredCoveragePercentage);

  return {
    colorPages,
    grayscalePages,
    selectedPages,
    meteredCoveragePercentage,
    colorPercentage: meteredCoveragePercentage,
    coverageTier: tierInfo.tier,
    tierLabel: tierInfo.label,
    tierRangeLabel: tierInfo.rangeLabel,
    confidence: input.analysisConfidence,
  };
}
