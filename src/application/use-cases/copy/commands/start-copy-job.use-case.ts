import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { StartCopyJobRequestDto } from '@/application/dto';
import { IPrinterPort } from '@/application/ports';

export class StartCopyJobCommand {
  constructor(public readonly dto: StartCopyJobRequestDto) {}
}

@CommandHandler(StartCopyJobCommand)
export class StartCopyJobUseCase implements ICommandHandler<StartCopyJobCommand, void> {
  constructor(
    @Inject('IPrinterPort')
    private readonly printerPort: IPrinterPort,
  ) {}

  async execute(command: StartCopyJobCommand): Promise<void> {
    const { dto } = command;
    await this.printerPort.print({
      filePath: dto.previewPath,
      copies: dto.copies,
      colorMode: dto.colorMode,
    });
  }
}
