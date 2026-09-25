import { AdminService } from '../../src/services/admin';
import { db } from '../../src/core/database/db';

describe('AdminService Pricing Calculations with Image B/W', () => {
  const adminService = new AdminService();

  beforeAll(() => {
    db.data = {
      settings: {
        pricing: { scanDocument: 5, highQualitySurcharge: 2 },
        pricingEngine: {
          paperProfiles: {
            a4: {
              baseBwPrice: 3,
              baseColorPrice: 18,
              baseImagePrice: 25,
              baseImageBwPrice: 10,
            },
            shortBond: {
              baseBwPrice: 3,
              baseColorPrice: 18,
              baseImagePrice: 25,
              baseImageBwPrice: 10,
            },
            longBond: {
              baseBwPrice: 4,
              baseColorPrice: 20,
              baseImagePrice: 30,
              baseImageBwPrice: 12,
            },
          },
          highQualitySurcharge: 2,
        },
      },
    } as any;
  });

  it('calculates amount for 1 Image B/W page on A4 standard quality', () => {
    const amount = adminService.calculateDocumentAmount(
      'print',
      { colorPages: 0, bwPages: 0, imagePages: 0, imageBwPages: 1 },
      1,
      'A4',
      'standard',
    );
    expect(amount).toBe(10);
  });

  it('calculates amount for 1 Image Color page and 1 Image B/W page on Long with 2 copies', () => {
    const amount = adminService.calculateDocumentAmount(
      'print',
      { colorPages: 0, bwPages: 0, imagePages: 1, imageBwPages: 1 },
      2,
      'Long',
      'standard',
    );
    // Long: baseImagePrice = 30, baseImageBwPrice = 12 -> (30 + 12) * 2 = 84
    expect(amount).toBe(84);
  });
});
