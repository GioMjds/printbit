import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { IPrinterStatusPort, IScannerPort } from '@/application/ports';

export interface AdminStatusResponseDto {
  printerOnline: boolean;
  scannerAvailable: boolean;
}

export class GetAdminStatusQuery {}

@QueryHandler(GetAdminStatusQuery)
export class GetAdminStatusUseCase implements IQueryHandler<GetAdminStatusQuery, AdminStatusResponseDto> {
  constructor(
    @Inject('IPrinterStatusPort')
    private readonly printerStatusPort: IPrinterStatusPort,
    @Inject('IScannerPort')
    private readonly scannerPort: IScannerPort,
  ) {}

  async execute(_query: GetAdminStatusQuery): Promise<AdminStatusResponseDto> {
    const printer = await this.printerStatusPort.getStatus();
    const scanner = await this.scannerPort.probe();
    return {
      printerOnline: printer.isOnline,
      scannerAvailable: scanner.isAvailable,
    };
  }
}
