import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { JobStatus, JOB_STATUS } from '@/domain';

export class GetCopyJobStatusQuery {
  constructor(public readonly jobId: string) {}
}

@QueryHandler(GetCopyJobStatusQuery)
export class GetCopyJobStatusUseCase implements IQueryHandler<GetCopyJobStatusQuery, JobStatus> {
  async execute(_query: GetCopyJobStatusQuery): Promise<JobStatus> {
    return JOB_STATUS.QUEUED;
  }
}
