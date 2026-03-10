import { CreateUploadSessionUseCase } from './commands/create-upload-session.use-case';
import { UploadFileToSessionUseCase } from './commands/upload-file-to-session.use-case';
import { GetSessionUseCase } from './queries/get-session.use-case';
import { PreviewSessionFileUseCase } from './queries/preview-session-file.use-case';

export const WirelessSessionUseCaseHandlers = [
  CreateUploadSessionUseCase,
  GetSessionUseCase,
  PreviewSessionFileUseCase,
  UploadFileToSessionUseCase,
] as const;
