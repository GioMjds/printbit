import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import {
  IAdminSettingsRepository,
  IIdempotencyRepository,
  IKioskStateRepository,
  ILogRepository,
  Money,
} from '@/domain';
import { ConfirmPaymentRequestDto, PaymentResultResponseDto } from '@/application/dto';
import { IHopperPort, IEventPublisherPort } from '@/application/ports';

export class ConfirmPaymentCommand {
  constructor(public readonly dto: ConfirmPaymentRequestDto) {}
}

@CommandHandler(ConfirmPaymentCommand)
export class ConfirmPaymentUseCase implements ICommandHandler<ConfirmPaymentCommand, PaymentResultResponseDto> {
  constructor(
    @Inject('IKioskStateRepository')
    private readonly kioskStateRepository: IKioskStateRepository,
    @Inject('IAdminSettingsRepository')
    private readonly adminSettingsRepository: IAdminSettingsRepository,
    @Inject('IIdempotencyRepository')
    private readonly idempotencyRepository: IIdempotencyRepository,
    @Inject('ILogRepository')
    private readonly logRepository: ILogRepository,
    @Inject('IHopperPort')
    private readonly hopperPort: IHopperPort,
    @Inject('IEventPublisherPort')
    private readonly eventPublisherPort: IEventPublisherPort,
  ) {}

  async execute(command: ConfirmPaymentCommand): Promise<PaymentResultResponseDto> {
    const { dto } = command;
    void this.adminSettingsRepository;
    void this.idempotencyRepository;
    void this.logRepository;
    void this.hopperPort;
    void dto;

    const state = await this.kioskStateRepository.get();
    const charged = Money.fromCents(0);
    state.confirmPayment(charged);
    await this.kioskStateRepository.save(state);

    const remainingBalance = state.getBalanceCents();
    this.eventPublisherPort.emitBalance(remainingBalance);

    return {
      chargedAmount: charged.value,
      remainingBalance,
      changeDispensed: 0,
    };
  }
}
