import { Injectable } from '@nestjs/common';
import {
  IScanDeliveryTokenRepository,
  ScanDeliveryToken,
} from '@/domain';
import { PrismaService } from '../prisma.service';
import { ScanDeliveryTokenMapper } from '../mappers';

@Injectable()
export class PrismaScanDeliveryTokenRepository
  implements IScanDeliveryTokenRepository
{
  private readonly mapper = new ScanDeliveryTokenMapper();

  constructor(private readonly prisma: PrismaService) {}

  async create(token: ScanDeliveryToken): Promise<void> {
    const data = this.mapper.toPersistence(token);
    await this.prisma.scanDeliveryToken.upsert({
      where: { token: data.token },
      update: data,
      create: data,
    });
  }

  async findByToken(token: string): Promise<ScanDeliveryToken | null> {
    const row = await this.prisma.scanDeliveryToken.findUnique({
      where: { token },
    });

    if (!row) return null;
    return this.mapper.toDomain(row);
  }

  async deleteByToken(token: string): Promise<void> {
    await this.prisma.scanDeliveryToken.deleteMany({ where: { token } });
  }

  async deleteExpired(nowIso: string): Promise<number> {
    const result = await this.prisma.scanDeliveryToken.deleteMany({
      where: { expiresAt: { lte: new Date(nowIso) } },
    });
    return result.count;
  }
}
