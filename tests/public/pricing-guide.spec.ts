import {
  normalizePricingConfig,
  formatPricingGuide,
  formatPeso,
} from '../../src/public/shared/pricing-guide';

describe('pricing-guide', () => {
  it('normalizes pricing configuration with tiered paper profiles', () => {
    const normalized = normalizePricingConfig({
      paperProfiles: {
        a4: {
          paperCost: 2,
          bwPrint: { low: 3, medium: 4, high: 7, very_high: 10 },
          colorPrint: { low: 18, medium: 20, high: 25, very_high: 30 },
        },
      },
    });

    expect(normalized.paperProfiles.a4).toEqual({
      paperCost: 2,
      bwPrint: { low: 3, medium: 4, high: 7, very_high: 10 },
      colorPrint: { low: 18, medium: 20, high: 25, very_high: 30 },
    });
    expect(normalized.paperProfiles.shortBond.paperCost).toBe(1);
    expect(normalized.paperProfiles.shortBond.bwPrint.low).toBe(2);
    expect(normalized.paperProfiles.longBond.colorPrint.very_high).toBe(34);
  });

  it('normalizes legacy pricing configuration without data loss', () => {
    const normalized = normalizePricingConfig({
      paperProfiles: {
        a4: { baseBwPrice: 5, baseColorPrice: 20, baseImagePrice: 30, baseImageBwPrice: 12 },
      },
    });

    expect(normalized.paperProfiles.a4.paperCost).toBe(1);
    expect(normalized.paperProfiles.a4.bwPrint.low).toBe(4);
    expect(normalized.paperProfiles.a4.colorPrint.low).toBe(19);
  });

  it('formats pricing table with paper sheet cost, print tiers, and duplex savings note when enabled', () => {
    const pricingDisabled = normalizePricingConfig({ duplexEnabled: false });
    const htmlDisabled = formatPricingGuide(pricingDisabled);

    expect(htmlDisabled).toContain('<th scope="col">Paper size</th>');
    expect(htmlDisabled).toContain('<th scope="col">Bond Paper (sheet)</th>');
    expect(htmlDisabled).toContain('<th scope="col">Print Mode</th>');
    expect(htmlDisabled).toContain('<th scope="col">Low (0&ndash;10%)</th>');
    expect(htmlDisabled).toContain('<th scope="col">Max (70&ndash;100%)</th>');
    expect(htmlDisabled).toContain('0&ndash;10%');
    expect(htmlDisabled).toContain('10&ndash;40%');
    expect(htmlDisabled).toContain('40&ndash;70%');
    expect(htmlDisabled).toContain('70&ndash;100%');
    expect(htmlDisabled).toContain(`>${formatPeso(pricingDisabled.paperProfiles.a4.paperCost)}<`);
    expect(htmlDisabled).toContain(`<td>${formatPeso(pricingDisabled.paperProfiles.a4.bwPrint.low)}</td>`);
    expect(htmlDisabled).toContain(`>${formatPeso(pricingDisabled.paperProfiles.a4.colorPrint.very_high)}<`);
    // When disabled, no duplex savings note is shown
    expect(htmlDisabled).not.toContain('Duplex Savings');

    const pricingEnabled = normalizePricingConfig({ duplexEnabled: true });
    const htmlEnabled = formatPricingGuide(pricingEnabled);
    expect(htmlEnabled).toContain('Duplex Savings');
  });
});

