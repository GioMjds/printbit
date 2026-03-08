import { Injectable } from '@nestjs/common';
import {
  IdempotencyEntry,
  IIdempotencyRepository,
} from '@/domain';
import { PrismaService } from '../prisma.service';
import { IdempotencyMapper } from '../mappers';

@Injectable()
export class PrismaIdempotencyRepository implements IIdempotencyRepository {
  private readonly mapper = new IdempotencyMapper();

  constructor(private readonly prisma: PrismaService) {}

  async findByKey(key: string): Promise<IdempotencyEntry | null> {
    const row = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
    if (!row) return null;
    return this.mapper.toDomain(row);
  }

  async save(entry: IdempotencyEntry): Promise<void> {
    const data = this.mapper.toPersistence(entry);
    await this.prisma.idempotencyRecord.upsert({
      where: { key: data.key },
      update: data,
      create: data,
    });
  }

  async delete(key: string): Promise<void> {
    await this.prisma.idempotencyRecord.deleteMany({ where: { key } });
  }

  async deleteExpired(nowIso: string): Promise<number> {
    const result = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lte: new Date(nowIso) } },
    });
    return result.count;
  }
}
