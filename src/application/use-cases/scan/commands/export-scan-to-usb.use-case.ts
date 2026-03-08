import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ExportScanToUsbRequestDto } from '@/application/dto';
import { IUsbDrivePort } from '@/application/ports';

export class ExportScanToUsbCommand {
  constructor(public readonly dto: ExportScanToUsbRequestDto) {}
}

@CommandHandler(ExportScanToUsbCommand)
export class ExportScanToUsbUseCase implements ICommandHandler<ExportScanToUsbCommand, string> {
  constructor(
    @Inject('IUsbDrivePort')
    private readonly usbDrivePort: IUsbDrivePort,
  ) {}

  async execute(command: ExportScanToUsbCommand): Promise<string> {
    const { dto } = command;
    return this.usbDrivePort.exportFile(dto.filePath, dto.driveLetter);
  }
}
