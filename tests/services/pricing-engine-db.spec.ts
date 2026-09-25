import { db, defaultPricingEngine } from '../../src/core/database/db';

describe('Pricing Engine Database Schema & Defaults', () => {
  it('includes baseImageBwPrice in default paper profiles', () => {
    expect(defaultPricingEngine.paperProfiles.a4.baseImageBwPrice).toBe(10);
    expect(defaultPricingEngine.paperProfiles.shortBond.baseImageBwPrice).toBe(
      10,
    );
    expect(defaultPricingEngine.paperProfiles.longBond.baseImageBwPrice).toBe(
      12,
    );
  });

  it('normalizes missing baseImageBwPrice in existing paper profiles to defaults', () => {
    const rawEngine = {
      paperProfiles: {
        a4: { baseBwPrice: 3, baseColorPrice: 18, baseImagePrice: 25 },
        shortBond: { baseBwPrice: 3, baseColorPrice: 18, baseImagePrice: 25 },
        longBond: { baseBwPrice: 4, baseColorPrice: 20, baseImagePrice: 30 },
      },
    };
    const normalized =
      (db as any).normalizePricingEngine?.(rawEngine) ?? rawEngine;
    expect(normalized.paperProfiles.a4.baseImageBwPrice).toBe(10);
    expect(normalized.paperProfiles.shortBond.baseImageBwPrice).toBe(10);
    expect(normalized.paperProfiles.longBond.baseImageBwPrice).toBe(12);
  });
});
