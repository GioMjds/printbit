import { db } from '@/core/database/db';
import { AdminController } from '@/modules/admin/admin.controller';
import { AdminService } from '@/modules/admin/admin.service';
import { ConsumablesService } from '@/modules/admin/consumables.service';
import type { Request, Response } from 'express';

describe('Admin Pricing Settings Validation', () => {
  let controller: AdminController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let responseStatus = 200;
  let responseJson: any = null;

  beforeEach(async () => {
    await db.read();
    jest.spyOn(db, 'write').mockResolvedValue(undefined as any);
    controller = new AdminController(
      new AdminService(),
      new ConsumablesService(),
      {} as any,
    );
    responseStatus = 200;
    responseJson = null;
    mockRes = {
      status: jest.fn().mockImplementation((s: number) => {
        responseStatus = s;
        return mockRes;
      }),
      json: jest.fn().mockImplementation((j: any) => {
        responseJson = j;
        return mockRes;
      }),
    };
  });

  it('accepts and persists valid tiered paperProfiles in pricingEngine', async () => {
    mockReq = {
      body: {
        pricingEngine: {
          paperProfiles: {
            a4: {
              paperCost: 2,
              bwPrint: { low: 3, medium: 4, high: 7, very_high: 10 },
              colorPrint: { low: 18, medium: 20, high: 25, very_high: 30 },
            },
          },
        },
      },
    };

    await (controller as any).handleUpdateSettings(mockReq as Request, mockRes as Response);

    expect(responseStatus).toBe(200);
    expect(db.data?.settings.pricingEngine.paperProfiles.a4.paperCost).toBe(2);
    expect(db.data?.settings.pricingEngine.paperProfiles.a4.bwPrint.low).toBe(3);
    expect(db.data?.settings.pricingEngine.paperProfiles.a4.colorPrint.very_high).toBe(30);
  });

  it('rejects decimal cents in tiered pricing rates with 400', async () => {
    mockReq = {
      body: {
        pricingEngine: {
          paperProfiles: {
            a4: {
              paperCost: 1.5,
              bwPrint: { low: 2, medium: 3, high: 6, very_high: 9 },
              colorPrint: { low: 17, medium: 19, high: 24, very_high: 29 },
            },
          },
        },
      },
    };

    await (controller as any).handleUpdateSettings(mockReq as Request, mockRes as Response);

    expect(responseStatus).toBe(400);
    expect(responseJson.error).toContain('paperCost must be a whole peso');
  });

  it('rejects non-monotonic tier rates (e.g. high < medium) with 400', async () => {
    mockReq = {
      body: {
        pricingEngine: {
          paperProfiles: {
            a4: {
              paperCost: 1,
              bwPrint: { low: 2, medium: 5, high: 4, very_high: 9 },
              colorPrint: { low: 17, medium: 19, high: 24, very_high: 29 },
            },
          },
        },
      },
    };

    await (controller as any).handleUpdateSettings(mockReq as Request, mockRes as Response);

    expect(responseStatus).toBe(400);
    expect(responseJson.error).toContain('cannot be less than');
  });

  it('rejects color rate lower than bw rate for the same tier with 400', async () => {
    mockReq = {
      body: {
        pricingEngine: {
          paperProfiles: {
            a4: {
              paperCost: 1,
              bwPrint: { low: 5, medium: 6, high: 8, very_high: 10 },
              colorPrint: { low: 4, medium: 7, high: 9, very_high: 12 },
            },
          },
        },
      },
    };

    await (controller as any).handleUpdateSettings(mockReq as Request, mockRes as Response);

    expect(responseStatus).toBe(400);
    expect(responseJson.error).toContain('colorPrint.low cannot be less than bwPrint.low');
  });

  it('accepts and normalizes legacy paperProfiles format', async () => {
    mockReq = {
      body: {
        pricingEngine: {
          paperProfiles: {
            shortBond: {
              baseBwPrice: 4,
              baseColorPrice: 20,
              baseImagePrice: 28,
              baseImageBwPrice: 11,
            },
          },
        },
      },
    };

    await (controller as any).handleUpdateSettings(mockReq as Request, mockRes as Response);

    expect(responseStatus).toBe(200);
    const profile = db.data?.settings.pricingEngine.paperProfiles.shortBond;
    expect(profile?.paperCost).toBe(1);
    expect(profile?.bwPrint.low).toBe(3);
    expect(profile?.colorPrint.low).toBe(19);
  });

  it('accepts and persists duplexEnabled toggle in pricingEngine', async () => {
    mockReq = {
      body: {
        pricingEngine: {
          duplexEnabled: true,
        },
      },
    };

    await (controller as any).handleUpdateSettings(mockReq as Request, mockRes as Response);

    expect(responseStatus).toBe(200);
    expect(db.data?.settings.pricingEngine.duplexEnabled).toBe(true);

    mockReq = {
      body: {
        pricingEngine: {
          duplexEnabled: false,
        },
      },
    };

    await (controller as any).handleUpdateSettings(mockReq as Request, mockRes as Response);

    expect(responseStatus).toBe(200);
    expect(db.data?.settings.pricingEngine.duplexEnabled).toBe(false);
  });

  it('rejects non-boolean duplexEnabled with 400', async () => {
    mockReq = {
      body: {
        pricingEngine: {
          duplexEnabled: 'yes',
        },
      },
    };

    await (controller as any).handleUpdateSettings(mockReq as Request, mockRes as Response);

    expect(responseStatus).toBe(400);
    expect(responseJson?.error).toContain('pricingEngine.duplexEnabled must be boolean');
  });
});
