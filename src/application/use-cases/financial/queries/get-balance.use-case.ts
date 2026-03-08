import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { IKioskStateRepository } from '@/domain';
import { BalanceResponseDto } from '@/application/dto';

export class GetBalanceQuery {}

@QueryHandler(GetBalanceQuery)
export class GetBalanceUseCase implements IQueryHandler<GetBalanceQuery, BalanceResponseDto> {
  constructor(
    @Inject('IKioskStateRepository')
    private readonly kioskStateRepository: IKioskStateRepository,
  ) {}

  async execute(_query: GetBalanceQuery): Promise<BalanceResponseDto> {
    const state = await this.kioskStateRepository.get();
    return {
      balance: state.getBalanceCents(),
      earnings: state.getEarningsCents(),
    };
  }
}
