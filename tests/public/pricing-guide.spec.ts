import {
  normalizePricingConfig,
  formatPricingGuide,
  formatPeso,
} from '../../src/public/shared/pricing-guide';

describe('pricing-guide', () => {
  it('normalizes pricing configuration including image prices', () => {
    const normalized = normalizePricingConfig({
      paperProfiles: {
        a4: { baseBwPrice: 5, baseColorPrice: 20, baseImagePrice: 30 },
      },
    });

    expect(normalized.paperProfiles.a4).toEqual({
      baseBwPrice: 5,
      baseColorPrice: 20,
      baseImagePrice: 30,
    });
    expect(normalized.paperProfiles.shortBond.baseImagePrice).toBe(25);
    expect(normalized.paperProfiles.longBond.baseImagePrice).toBe(30);
  });

  it('formats pricing table with photo/image column', () => {
    const pricing = normalizePricingConfig({});
    const html = formatPricingGuide(pricing);

    expect(html).toContain('<th scope="col">Photo (Color)</th>');
    expect(html).toContain('<th scope="col">Photo (B&amp;W)</th>');
    expect(html).toContain(`<td>${formatPeso(pricing.paperProfiles.a4.baseImagePrice)}</td>`);
    expect(html).toContain(`<td>${formatPeso(pricing.paperProfiles.a4.baseImageBwPrice)}</td>`);
    expect(html).toContain(`<td>${formatPeso(pricing.paperProfiles.longBond.baseImagePrice)}</td>`);
    expect(html).toContain(`<td>${formatPeso(pricing.paperProfiles.longBond.baseImageBwPrice)}</td>`);
  });
});
