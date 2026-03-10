import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { ScannerStatusResponseDto } from '@/application/dto';
import { IScannerPort } from '@/application/ports';

export class GetScannerStatusQuery {}

@QueryHandler(GetScannerStatusQuery)
export class GetScannerStatusUseCase implements IQueryHandler<GetScannerStatusQuery, ScannerStatusResponseDto> {
  constructor(
    @Inject('IScannerPort')
    private readonly scannerPort: IScannerPort,
  ) {}

  async execute(_query: GetScannerStatusQuery): Promise<ScannerStatusResponseDto> {
    const info = await this.scannerPort.probe();
    return {
      isAvailable: info.isAvailable,
      deviceName: info.deviceName,
      error: info.error,
    };
  }
}
