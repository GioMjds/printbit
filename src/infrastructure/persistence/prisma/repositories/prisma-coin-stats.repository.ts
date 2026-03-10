import { Injectable } from '@nestjs/common';
import { CoinStats, ICoinStatsRepository } from '@/domain';
import { PrismaService } from '../prisma.service';
import { CoinStatsMapper } from '../mappers';

@Injectable()
export class PrismaCoinStatsRepository implements ICoinStatsRepository {
  private readonly mapper = new CoinStatsMapper();

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<CoinStats> {
    const row = await this.prisma.coinStats.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, one: 0, five: 0, ten: 0, twenty: 0 },
    });

    return this.mapper.toDomain(row);
  }

  async save(stats: CoinStats): Promise<void> {
    const data = this.mapper.toPersistence(stats);
    await this.prisma.coinStats.upsert({
      where: { id: 1 },
      update: data,
      create: { id: 1, ...data },
    });
  }
}
