import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { IKioskStateRepository, Money } from '@/domain';

export class ChargeSoftCopyCommand {
  constructor(public readonly costCents: number) {}
}

@CommandHandler(ChargeSoftCopyCommand)
export class ChargeSoftCopyUseCase implements ICommandHandler<ChargeSoftCopyCommand, number> {
  constructor(
    @Inject('IKioskStateRepository')
    private readonly kioskStateRepository: IKioskStateRepository,
  ) {}

  async execute(command: ChargeSoftCopyCommand): Promise<number> {
    const { costCents } = command;
    const state = await this.kioskStateRepository.get();
    state.confirmPayment(Money.fromCents(costCents));
    await this.kioskStateRepository.save(state);
    return state.getBalanceCents();
  }
}
