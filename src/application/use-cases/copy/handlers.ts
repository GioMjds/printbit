import { StartCopyJobUseCase } from './commands/start-copy-job.use-case';
import { GetCopyJobStatusUseCase } from './queries/get-copy-job-status.use-case';

export const CopyUseCaseHandlers = [
  GetCopyJobStatusUseCase,
  StartCopyJobUseCase,
] as const;
