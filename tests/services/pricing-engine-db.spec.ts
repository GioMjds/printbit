import { db, defaultPricingEngine } from '../../src/core/database/db';

describe('Pricing Engine Database Schema & Defaults', () => {
  it('defines default paper profiles with paperCost, bwPrint, and colorPrint tiers', () => {
    expect(defaultPricingEngine.paperProfiles.a4.paperCost).toBe(1);
    expect(defaultPricingEngine.paperProfiles.a4.bwPrint.low).toBe(2);
    expect(defaultPricingEngine.paperProfiles.a4.bwPrint.medium).toBe(3);
    expect(defaultPricingEngine.paperProfiles.a4.bwPrint.high).toBe(6);
    expect(defaultPricingEngine.paperProfiles.a4.bwPrint.very_high).toBe(9);
    expect(defaultPricingEngine.paperProfiles.a4.colorPrint.low).toBe(17);
    expect(defaultPricingEngine.paperProfiles.a4.colorPrint.medium).toBe(19);
    expect(defaultPricingEngine.paperProfiles.a4.colorPrint.high).toBe(24);
    expect(defaultPricingEngine.paperProfiles.a4.colorPrint.very_high).toBe(29);

    expect(defaultPricingEngine.paperProfiles.shortBond.paperCost).toBe(1);
    expect(defaultPricingEngine.paperProfiles.shortBond.bwPrint.low).toBe(2);
    expect(defaultPricingEngine.paperProfiles.shortBond.bwPrint.medium).toBe(3);
    expect(defaultPricingEngine.paperProfiles.shortBond.bwPrint.high).toBe(6);
    expect(defaultPricingEngine.paperProfiles.shortBond.bwPrint.very_high).toBe(9);
    expect(defaultPricingEngine.paperProfiles.shortBond.colorPrint.low).toBe(17);
    expect(defaultPricingEngine.paperProfiles.shortBond.colorPrint.medium).toBe(19);
    expect(defaultPricingEngine.paperProfiles.shortBond.colorPrint.high).toBe(24);
    expect(defaultPricingEngine.paperProfiles.shortBond.colorPrint.very_high).toBe(29);

    expect(defaultPricingEngine.paperProfiles.longBond.paperCost).toBe(1);
    expect(defaultPricingEngine.paperProfiles.longBond.bwPrint.low).toBe(3);
    expect(defaultPricingEngine.paperProfiles.longBond.bwPrint.medium).toBe(4);
    expect(defaultPricingEngine.paperProfiles.longBond.bwPrint.high).toBe(8);
    expect(defaultPricingEngine.paperProfiles.longBond.bwPrint.very_high).toBe(11);
    expect(defaultPricingEngine.paperProfiles.longBond.colorPrint.low).toBe(19);
    expect(defaultPricingEngine.paperProfiles.longBond.colorPrint.medium).toBe(22);
    expect(defaultPricingEngine.paperProfiles.longBond.colorPrint.high).toBe(29);
    expect(defaultPricingEngine.paperProfiles.longBond.colorPrint.very_high).toBe(34);

    expect(defaultPricingEngine.highQualitySurcharge).toBe(2);
    expect(defaultPricingEngine.rounding).toBe('whole_peso_total_only');
  });

  it('normalizes legacy paper profiles into new tiered format without data loss', () => {
    const rawLegacy = {
      paperProfiles: {
        a4: { baseBwPrice: 3, baseColorPrice: 18, baseImagePrice: 25, baseImageBwPrice: 10 },
        shortBond: { baseBwPrice: 3, baseColorPrice: 18, baseImagePrice: 25, baseImageBwPrice: 10 },
        longBond: { baseBwPrice: 4, baseColorPrice: 20, baseImagePrice: 30, baseImageBwPrice: 12 },
      },
    };
    const normalized = (db as any).normalizePricingEngine?.(rawLegacy) ?? rawLegacy;
    expect(normalized.paperProfiles.a4.paperCost).toBe(1);
    expect(normalized.paperProfiles.a4.bwPrint.low).toBe(2);
    expect(normalized.paperProfiles.a4.bwPrint.medium).toBe(3);
    expect(normalized.paperProfiles.a4.bwPrint.high).toBe(6);
    expect(normalized.paperProfiles.a4.bwPrint.very_high).toBe(9);
    expect(normalized.paperProfiles.a4.colorPrint.low).toBe(17);
    expect(normalized.paperProfiles.a4.colorPrint.medium).toBe(19);
    expect(normalized.paperProfiles.a4.colorPrint.high).toBe(24);
    expect(normalized.paperProfiles.a4.colorPrint.very_high).toBe(29);

    expect(normalized.paperProfiles.longBond.paperCost).toBe(1);
    expect(normalized.paperProfiles.longBond.bwPrint.low).toBe(3);
    expect(normalized.paperProfiles.longBond.bwPrint.medium).toBe(4);
    expect(normalized.paperProfiles.longBond.bwPrint.high).toBe(7);
    expect(normalized.paperProfiles.longBond.bwPrint.very_high).toBe(11);
    expect(normalized.paperProfiles.longBond.colorPrint.low).toBe(19);
    expect(normalized.paperProfiles.longBond.colorPrint.medium).toBe(21);
    expect(normalized.paperProfiles.longBond.colorPrint.high).toBe(29);
    expect(normalized.paperProfiles.longBond.colorPrint.very_high).toBe(34);
  });

  it('normalizes legacy profiles without baseImageBwPrice or baseImagePrice falling back to defaults', () => {
    const rawLegacy = {
      paperProfiles: {
        a4: { baseBwPrice: 3, baseColorPrice: 18 },
      },
    };
    const normalized = (db as any).normalizePricingEngine?.(rawLegacy) ?? rawLegacy;
    expect(normalized.paperProfiles.a4.paperCost).toBe(1);
    expect(normalized.paperProfiles.a4.bwPrint.low).toBe(2);
    expect(normalized.paperProfiles.a4.bwPrint.medium).toBe(3);
    expect(normalized.paperProfiles.a4.bwPrint.high).toBe(6);
    expect(normalized.paperProfiles.a4.bwPrint.very_high).toBe(9);
    expect(normalized.paperProfiles.a4.colorPrint.low).toBe(17);
    expect(normalized.paperProfiles.a4.colorPrint.medium).toBe(19);
    expect(normalized.paperProfiles.a4.colorPrint.high).toBe(24);
    expect(normalized.paperProfiles.a4.colorPrint.very_high).toBe(29);
  });

  it('normalizes already updated tiered profile values and preserves custom rates', () => {
    const customConfig = {
      paperProfiles: {
        a4: {
          paperCost: 2,
          bwPrint: { low: 1, medium: 2, high: 5, very_high: 8 },
          colorPrint: { low: 10, medium: 15, high: 20, very_high: 25 },
        },
      },
    };
    const normalized = (db as any).normalizePricingEngine?.(customConfig) ?? customConfig;
    expect(normalized.paperProfiles.a4.paperCost).toBe(2);
    expect(normalized.paperProfiles.a4.bwPrint.low).toBe(1);
    expect(normalized.paperProfiles.a4.bwPrint.medium).toBe(2);
    expect(normalized.paperProfiles.a4.bwPrint.high).toBe(5);
    expect(normalized.paperProfiles.a4.bwPrint.very_high).toBe(8);
    expect(normalized.paperProfiles.a4.colorPrint.low).toBe(10);
    expect(normalized.paperProfiles.a4.colorPrint.medium).toBe(15);
    expect(normalized.paperProfiles.a4.colorPrint.high).toBe(20);
    expect(normalized.paperProfiles.a4.colorPrint.very_high).toBe(25);
    expect(normalized.paperProfiles.shortBond.paperCost).toBe(1);
    expect(normalized.paperProfiles.longBond.paperCost).toBe(1);
  });
});
