import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { ILogRepository } from '@/domain';

export class ExportAdminLogsCsvQuery {}

@QueryHandler(ExportAdminLogsCsvQuery)
export class ExportAdminLogsCsvUseCase implements IQueryHandler<ExportAdminLogsCsvQuery, string> {
  constructor(
    @Inject('ILogRepository')
    private readonly logRepository: ILogRepository,
  ) {}

  async execute(_query: ExportAdminLogsCsvQuery): Promise<string> {
    const logs = await this.logRepository.findAll();
    const lines = ['id,timestamp,type,message'];

    for (const log of logs) {
      const row = log.toPrimitives();
      lines.push([
        row.id,
        row.timestamp,
        row.type,
        row.message.replaceAll('"', '""'),
      ].map((value) => `"${value}"`).join(','));
    }

    return `${lines.join('\n')}\n`;
  }
}
