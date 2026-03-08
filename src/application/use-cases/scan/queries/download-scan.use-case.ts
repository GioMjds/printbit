import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InvalidStateException, IScanDeliveryTokenRepository } from '@/domain';

export class DownloadScanQuery {
  constructor(public readonly token: string) {}
}

@QueryHandler(DownloadScanQuery)
export class DownloadScanUseCase implements IQueryHandler<DownloadScanQuery, string> {
  constructor(
    @Inject('IScanDeliveryTokenRepository')
    private readonly scanDeliveryTokenRepository: IScanDeliveryTokenRepository,
  ) {}

  async execute(query: DownloadScanQuery): Promise<string> {
    const { token } = query;
    const found = await this.scanDeliveryTokenRepository.findByToken(token);
    if (!found) {
      throw new InvalidStateException('Scan download token not found.');
    }

    if (found.isExpired()) {
      await this.scanDeliveryTokenRepository.deleteByToken(token);
      throw new InvalidStateException('Scan download token has expired.');
    }

    return found.toPrimitives().filePath;
  }
}
