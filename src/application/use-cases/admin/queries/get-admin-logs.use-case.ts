import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { ILogRepository, LogProps } from '@/domain';

export class GetAdminLogsQuery {
  constructor(
    public readonly limit = 100,
    public readonly offset = 0,
  ) {}
}

@QueryHandler(GetAdminLogsQuery)
export class GetAdminLogsUseCase implements IQueryHandler<GetAdminLogsQuery, LogProps[]> {
  constructor(
    @Inject('ILogRepository')
    private readonly logRepository: ILogRepository,
  ) {}

  async execute(query: GetAdminLogsQuery): Promise<LogProps[]> {
    const logs = await this.logRepository.findAll(query.limit, query.offset);
    return logs.map((entry) => entry.toPrimitives());
  }
}
