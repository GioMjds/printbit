import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { IScanDeliveryTokenRepository, ScanDeliveryToken } from '@/domain';

export class CreateScanDownloadCommand {
  constructor(
    public readonly filePath: string,
    public readonly filename: string,
    public readonly ttlMs: number,
  ) {}
}

@CommandHandler(CreateScanDownloadCommand)
export class CreateScanDownloadUseCase implements ICommandHandler<CreateScanDownloadCommand, string> {
  constructor(
    @Inject('IScanDeliveryTokenRepository')
    private readonly scanDeliveryTokenRepository: IScanDeliveryTokenRepository,
  ) {}

  async execute(command: CreateScanDownloadCommand): Promise<string> {
    const token = ScanDeliveryToken.create(
      command.filePath,
      command.filename,
      command.ttlMs,
    );
    await this.scanDeliveryTokenRepository.create(token);
    return token.toPrimitives().token;
  }
}
