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

  it('formats pricing table with paper sheet cost, print tiers, and duplex savings note', () => {
    const pricing = normalizePricingConfig({});
    const html = formatPricingGuide(pricing);

    expect(html).toContain('<th scope="col">Paper (sheet)</th>');
    expect(html).toContain('<th scope="col">B&amp;W (Low)</th>');
    expect(html).toContain('<th scope="col">Color (Photo)</th>');
    expect(html).toContain(`<td>${formatPeso(pricing.paperProfiles.a4.paperCost)}</td>`);
    expect(html).toContain(`<td>${formatPeso(pricing.paperProfiles.a4.bwPrint.low)}</td>`);
    expect(html).toContain(`<td>${formatPeso(pricing.paperProfiles.a4.colorPrint.very_high)}</td>`);
    expect(html).toContain('Duplex Savings');
  });
});

