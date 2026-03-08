import { Injectable } from '@nestjs/common';
import { AdminSettings, IAdminSettingsRepository } from '@/domain';
import { PrismaService } from '../prisma.service';
import { AdminSettingsMapper } from '../mappers';

@Injectable()
export class PrismaAdminSettingsRepository implements IAdminSettingsRepository {
  private readonly mapper = new AdminSettingsMapper();

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<AdminSettings> {
    const settings = await this.prisma.adminSettings.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        printPerPage: 5,
        copyPerPage: 3,
        scanDocument: 5,
        colorSurcharge: 2,
        idleTimeoutSeconds: 120,
        adminPin: '1234',
        adminLocalOnly: true,
      },
    });

    const hopper = await this.prisma.hopperSettings.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        enabled: true,
        timeoutMs: 8000,
        retryCount: 1,
        dispenseCommandPrefix: 'HOPPER DISPENSE',
        selfTestCommand: 'HOPPER SELFTEST',
      },
    });

    return this.mapper.toDomain(settings, hopper);
  }

  async save(settings: AdminSettings): Promise<void> {
    const data = this.mapper.toPersistence(settings);

    await this.prisma.adminSettings.upsert({
      where: { id: 1 },
      update: data.settings,
      create: { id: 1, ...data.settings },
    });

    await this.prisma.hopperSettings.upsert({
      where: { id: 1 },
      update: data.hopper,
      create: { id: 1, ...data.hopper },
    });
  }
}
