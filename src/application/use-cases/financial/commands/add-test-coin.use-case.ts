import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import {
  CoinDenomination,
  ICoinStatsRepository,
  IKioskStateRepository,
  Money,
} from '@/domain';
import { AddTestCoinRequestDto, BalanceResponseDto } from '@/application/dto';
import { IEventPublisherPort } from '@/application/ports';

export class AddTestCoinCommand {
  constructor(public readonly dto: AddTestCoinRequestDto) {}
}

@CommandHandler(AddTestCoinCommand)
export class AddTestCoinUseCase implements ICommandHandler<AddTestCoinCommand, BalanceResponseDto> {
  constructor(
    @Inject('IKioskStateRepository')
    private readonly kioskStateRepository: IKioskStateRepository,
    @Inject('ICoinStatsRepository')
    private readonly coinStatsRepository: ICoinStatsRepository,
    @Inject('IEventPublisherPort')
    private readonly eventPublisherPort: IEventPublisherPort,
  ) {}

  async execute(command: AddTestCoinCommand): Promise<BalanceResponseDto> {
    const { dto } = command;
    const denomination = CoinDenomination.from(dto.value);

    const state = await this.kioskStateRepository.get();
    state.addCoins(Money.fromCents(denomination.value));
    await this.kioskStateRepository.save(state);

    const stats = await this.coinStatsRepository.get();
    const nextStats = stats.increment(denomination);
    await this.coinStatsRepository.save(nextStats);

    const balance = state.getBalanceCents();
    this.eventPublisherPort.emitCoinAccepted(denomination.value, balance);
    this.eventPublisherPort.emitBalance(balance);

    return {
      balance,
      earnings: state.getEarningsCents(),
    };
  }
}
