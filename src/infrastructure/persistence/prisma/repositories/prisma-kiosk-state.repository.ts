import { Injectable } from '@nestjs/common';
import { IKioskStateRepository, KioskState } from '@/domain';
import { PrismaService } from '../prisma.service';
import { KioskStateMapper } from '../mappers';

@Injectable()
export class PrismaKioskStateRepository implements IKioskStateRepository {
  private readonly mapper = new KioskStateMapper();

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<KioskState> {
    const row = await this.prisma.kioskState.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, balance: 0, earnings: 0 },
    });

    return this.mapper.toDomain(row);
  }

  async save(state: KioskState): Promise<void> {
    const data = this.mapper.toPersistence(state);
    await this.prisma.kioskState.upsert({
      where: { id: 1 },
      update: data,
      create: { id: 1, ...data },
    });
  }
}
