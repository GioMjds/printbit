import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { StartScanRequestDto, StartScanResponseDto } from '@/application/dto';
import { IScannerPort } from '@/application/ports';

export class StartScanCommand {
  constructor(public readonly dto: StartScanRequestDto) {}
}

@CommandHandler(StartScanCommand)
export class StartScanUseCase implements ICommandHandler<StartScanCommand, StartScanResponseDto> {
  constructor(
    @Inject('IScannerPort')
    private readonly scannerPort: IScannerPort,
  ) {}

  async execute(command: StartScanCommand): Promise<StartScanResponseDto> {
    const { dto } = command;
    const filePath = await this.scannerPort.scan({
      outputPath: '',
      format: dto.format,
      dpi: dto.dpi,
      colorMode: dto.colorMode,
      source: dto.source,
    });

    return { filePath };
  }
}
