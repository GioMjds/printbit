import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { IHopperPort } from '@/application/ports';

export class RunHopperSelfTestCommand {}

@CommandHandler(RunHopperSelfTestCommand)
export class RunHopperSelfTestUseCase implements ICommandHandler<RunHopperSelfTestCommand, void> {
  constructor(
    @Inject('IHopperPort')
    private readonly hopperPort: IHopperPort,
  ) {}

  async execute(_command: RunHopperSelfTestCommand): Promise<void> {
    await this.hopperPort.selfTest();
  }
}
