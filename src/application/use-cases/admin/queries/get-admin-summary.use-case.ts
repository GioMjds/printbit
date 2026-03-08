import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import {
  ICoinStatsRepository,
  IKioskStateRepository,
} from '@/domain';
import { AdminSummaryResponseDto } from '@/application/dto';
import { IPrinterStatusPort, IScannerPort } from '@/application/ports';

export class GetAdminSummaryQuery {}

@QueryHandler(GetAdminSummaryQuery)
export class GetAdminSummaryUseCase implements IQueryHandler<GetAdminSummaryQuery, AdminSummaryResponseDto> {
  constructor(
    @Inject('IKioskStateRepository')
    private readonly kioskStateRepository: IKioskStateRepository,
    @Inject('ICoinStatsRepository')
    private readonly coinStatsRepository: ICoinStatsRepository,
    @Inject('IPrinterStatusPort')
    private readonly printerStatusPort: IPrinterStatusPort,
    @Inject('IScannerPort')
    private readonly scannerPort: IScannerPort,
  ) {}

  async execute(_query: GetAdminSummaryQuery): Promise<AdminSummaryResponseDto> {
    const state = await this.kioskStateRepository.get();
    const printer = await this.printerStatusPort.getStatus();
    const scanner = await this.scannerPort.probe();

    void this.coinStatsRepository;

    return {
      balance: state.getBalanceCents(),
      earnings: state.getEarningsCents(),
      printerOnline: printer.isOnline,
      scannerAvailable: scanner.isAvailable,
    };
  }
}
