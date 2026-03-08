import { Injectable } from '@nestjs/common';
import { ILogRepository, Log } from '@/domain';
import { PrismaService } from '../prisma.service';
import { LogMapper } from '../mappers';

@Injectable()
export class PrismaLogRepository implements ILogRepository {
  private readonly mapper = new LogMapper();

  constructor(private readonly prisma: PrismaService) {}

  async create(entry: Log): Promise<void> {
    const data = this.mapper.toPersistence(entry);
    await this.prisma.log.create({ data });
  }

  async findAll(limit?: number, offset?: number): Promise<Log[]> {
    const rows = await this.prisma.log.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset,
    });

    return rows.map((row) => this.mapper.toDomain(row));
  }

  async findByType(type: string, limit?: number, offset?: number): Promise<Log[]> {
    const rows = await this.prisma.log.findMany({
      where: { type },
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset,
    });

    return rows.map((row) => this.mapper.toDomain(row));
  }
}
