import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  GetCopyJobStatusQuery,
  StartCopyJobCommand,
} from '@/application/use-cases/copy';
import { StartCopyJobRequestDto } from '@/application/dto';
import { JobStatus } from '@/domain';

@Controller('api/copy')
export class CopyController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post('jobs')
  async startJob(@Body() dto: StartCopyJobRequestDto): Promise<{ ok: true }> {
    await this.commandBus.execute(new StartCopyJobCommand(dto));
    return { ok: true };
  }

  @Get('jobs/:jobId')
  getJobStatus(@Param('jobId') jobId: string): Promise<JobStatus> {
    return this.queryBus.execute(new GetCopyJobStatusQuery(jobId));
  }
}
