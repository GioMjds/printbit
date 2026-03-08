import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import {
  InvalidStateException,
  IUploadSessionRepository,
} from '@/domain';
import { UploadFileToSessionRequestDto } from '@/application/dto';
import { IEventPublisherPort } from '@/application/ports';

export class UploadFileToSessionCommand {
  constructor(public readonly dto: UploadFileToSessionRequestDto) {}
}

@CommandHandler(UploadFileToSessionCommand)
export class UploadFileToSessionUseCase implements ICommandHandler<UploadFileToSessionCommand, void> {
  constructor(
    @Inject('IUploadSessionRepository')
    private readonly uploadSessionRepository: IUploadSessionRepository,
    @Inject('IEventPublisherPort')
    private readonly eventPublisherPort: IEventPublisherPort,
  ) {}

  async execute(command: UploadFileToSessionCommand): Promise<void> {
    const { dto } = command;
    const session = await this.uploadSessionRepository.findById(dto.sessionId);
    if (!session) {
      throw new InvalidStateException('Upload session not found.');
    }

    const nextSession = session.addFile({
      filename: dto.filename,
      originalName: dto.originalName,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      filePath: dto.filePath,
    });

    await this.uploadSessionRepository.save(nextSession);

    this.eventPublisherPort.emitUploadEvent(dto.sessionId, 'UploadCompleted', {
      filename: dto.originalName,
      sizeBytes: dto.sizeBytes,
      success: true,
    });
  }
}
