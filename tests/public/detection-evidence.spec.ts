import { buildColorDetectionEvidence } from '../../src/public/config/detection-evidence';

describe('buildColorDetectionEvidence', () => {
  it('calculates metered coverage percentage from page breakdown', () => {
    const evidence = buildColorDetectionEvidence({
      selectedColorPages: 1,
      selectedBwPages: 1,
      analysisConfidence: 'high',
      pageBreakdown: [
        { coverage: 0.10, coverageTier: 'low' },
        { coverage: 0.30, coverageTier: 'medium' },
      ],
    });

    expect(evidence.selectedPages).toBe(2);
    expect(evidence.colorPages).toBe(1);
    expect(evidence.grayscalePages).toBe(1);
    expect(evidence.meteredCoveragePercentage).toBe(20);
    expect(evidence.colorPercentage).toBe(20);
    expect(evidence.confidence).toBe('high');
  });

  it('uses direct meteredCoveragePercentage if provided and valid', () => {
    const evidence = buildColorDetectionEvidence({
      selectedColorPages: 2,
      selectedBwPages: 0,
      analysisConfidence: 'medium',
      meteredCoveragePercentage: 45,
    });

    expect(evidence.meteredCoveragePercentage).toBe(45);
    expect(evidence.colorPercentage).toBe(45);
    expect(evidence.confidence).toBe('medium');
  });

  it('clamps meteredCoveragePercentage between 0 and 100', () => {
    const high = buildColorDetectionEvidence({
      selectedColorPages: 1,
      selectedBwPages: 0,
      analysisConfidence: 'high',
      meteredCoveragePercentage: 150,
    });
    expect(high.meteredCoveragePercentage).toBe(100);

    const low = buildColorDetectionEvidence({
      selectedColorPages: 1,
      selectedBwPages: 0,
      analysisConfidence: 'high',
      meteredCoveragePercentage: -10,
    });
    expect(low.meteredCoveragePercentage).toBe(0);
  });

  it('defaults to 0 when no page breakdown or coverage is available', () => {
    const evidence = buildColorDetectionEvidence({
      selectedColorPages: 0,
      selectedBwPages: 0,
      analysisConfidence: 'low',
    });

    expect(evidence.meteredCoveragePercentage).toBe(0);
    expect(evidence.selectedPages).toBe(0);
    expect(evidence.confidence).toBe('low');
  });
});
