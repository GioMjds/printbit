import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { UploadSession, IUploadSessionRepository } from '@/domain';
import { UploadSessionResponseDto } from '@/application/dto';

export class CreateUploadSessionCommand {}

@CommandHandler(CreateUploadSessionCommand)
export class CreateUploadSessionUseCase implements ICommandHandler<CreateUploadSessionCommand, UploadSessionResponseDto> {
  constructor(
    @Inject('IUploadSessionRepository')
    private readonly uploadSessionRepository: IUploadSessionRepository,
  ) {}

  async execute(_command: CreateUploadSessionCommand): Promise<UploadSessionResponseDto> {
    const session = UploadSession.create();
    await this.uploadSessionRepository.create(session);
    const data = session.toPrimitives();
    return {
      sessionId: data.id,
      token: data.token,
      uploadUrl: data.uploadUrl,
      status: data.status,
    };
  }
}
