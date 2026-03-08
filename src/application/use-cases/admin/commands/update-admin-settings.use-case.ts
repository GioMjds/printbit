import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { AdminSettings, IAdminSettingsRepository } from '@/domain';
import { UpdateAdminSettingsRequestDto } from '@/application/dto';

export class UpdateAdminSettingsCommand {
  constructor(public readonly dto: UpdateAdminSettingsRequestDto) {}
}

@CommandHandler(UpdateAdminSettingsCommand)
export class UpdateAdminSettingsUseCase implements ICommandHandler<UpdateAdminSettingsCommand, void> {
  constructor(
    @Inject('IAdminSettingsRepository')
    private readonly adminSettingsRepository: IAdminSettingsRepository,
  ) {}

  async execute(command: UpdateAdminSettingsCommand): Promise<void> {
    const { dto } = command;
    const next = AdminSettings.create({
      pricing: {
        printPerPage: dto.printPerPage,
        copyPerPage: dto.copyPerPage,
        scanDocument: dto.scanDocument,
        colorSurcharge: dto.colorSurcharge,
      },
      idleTimeoutSeconds: dto.idleTimeoutSeconds,
      adminPin: dto.adminPin,
      adminLocalOnly: dto.adminLocalOnly,
      hopper: {
        enabled: dto.hopperEnabled,
        timeoutMs: dto.hopperTimeoutMs,
        retryCount: dto.hopperRetryCount,
        dispenseCommandPrefix: 'HOPPER DISPENSE',
        selfTestCommand: 'HOPPER SELFTEST',
      },
    });

    await this.adminSettingsRepository.save(next);
  }
}
