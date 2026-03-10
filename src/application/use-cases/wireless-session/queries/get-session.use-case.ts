import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InvalidStateException, IUploadSessionRepository } from '@/domain';
import { UploadSessionResponseDto } from '@/application/dto';

export class GetSessionQuery {
  constructor(
    public readonly sessionId?: string,
    public readonly token?: string,
  ) {}
}

@QueryHandler(GetSessionQuery)
export class GetSessionUseCase implements IQueryHandler<GetSessionQuery, UploadSessionResponseDto> {
  constructor(
    @Inject('IUploadSessionRepository')
    private readonly uploadSessionRepository: IUploadSessionRepository,
  ) {}

  async execute(query: GetSessionQuery): Promise<UploadSessionResponseDto> {
    const session = query.sessionId
      ? await this.uploadSessionRepository.findById(query.sessionId)
      : query.token
        ? await this.uploadSessionRepository.findByToken(query.token)
        : null;

    if (!session) {
      throw new InvalidStateException('Upload session not found.');
    }

    const data = session.toPrimitives();
    return {
      sessionId: data.id,
      token: data.token,
      uploadUrl: data.uploadUrl,
      status: data.status,
    };
  }
}
