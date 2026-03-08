import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { IKioskStateRepository } from '@/domain';

export class ResetBalanceCommand {}

@CommandHandler(ResetBalanceCommand)
export class ResetBalanceUseCase implements ICommandHandler<ResetBalanceCommand, void> {
  constructor(
    @Inject('IKioskStateRepository')
    private readonly kioskStateRepository: IKioskStateRepository,
  ) {}

  async execute(_command: ResetBalanceCommand): Promise<void> {
    const state = await this.kioskStateRepository.get();
    state.resetBalance();
    await this.kioskStateRepository.save(state);
  }
}
