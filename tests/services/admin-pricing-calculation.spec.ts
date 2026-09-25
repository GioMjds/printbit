import { AdminService } from '../../src/services/admin';
import { db } from '../../src/core/database/db';

describe('AdminService Pricing Calculations with Dynamic Paper Profiles', () => {
  const adminService = new AdminService();

  beforeAll(() => {
    db.data = {
      settings: {
        pricing: { scanDocument: 5, highQualitySurcharge: 2 },
        pricingEngine: {
          paperProfiles: {
            a4: {
              paperCost: 1,
              bwPrint: { low: 2, medium: 3, high: 6, very_high: 9 },
              colorPrint: { low: 17, medium: 19, high: 24, very_high: 29 },
            },
            shortBond: {
              paperCost: 1,
              bwPrint: { low: 2, medium: 3, high: 6, very_high: 9 },
              colorPrint: { low: 17, medium: 19, high: 24, very_high: 29 },
            },
            longBond: {
              paperCost: 1,
              bwPrint: { low: 3, medium: 4, high: 8, very_high: 11 },
              colorPrint: { low: 19, medium: 22, high: 29, very_high: 34 },
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
    // Long: paperCost = 1. colorPrint.very_high = 34, bwPrint.very_high = 11 -> (1+34 + 1+11) * 2 = 47 * 2 = 94
    expect(amount).toBe(94);
  });

  it('calculates amount for standard B&W text page at low tier on A4', () => {
    const amount = adminService.calculateDocumentAmount(
      'print',
      { colorPages: 0, bwPages: 1 },
      1,
      'A4',
      'standard',
    );
    // A4: 1 paper (1) + 1 bw low (2) = 3
    expect(amount).toBe(3);
  });

  it('calculates amount for standard Color page at low tier on A4', () => {
    const amount = adminService.calculateDocumentAmount(
      'print',
      { colorPages: 1, bwPages: 0 },
      1,
      'A4',
      'standard',
    );
    // A4: 1 paper (1) + 1 color low (17) = 18
    expect(amount).toBe(18);
  });

  it('applies high quality surcharge correctly', () => {
    const amount = adminService.calculateDocumentAmount(
      'print',
      { colorPages: 0, bwPages: 1 },
      1,
      'A4',
      'high',
    );
    // A4: 1 paper (1) + 1 bw low (2) + high quality surcharge (2) = 5
    expect(amount).toBe(5);
  });
});
