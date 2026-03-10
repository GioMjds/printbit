import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { IAdminSettingsRepository } from '@/domain';

export class ValidateAdminPinQuery {
  constructor(public readonly pin: string) {}
}

@QueryHandler(ValidateAdminPinQuery)
export class ValidateAdminPinUseCase implements IQueryHandler<ValidateAdminPinQuery, boolean> {
  constructor(
    @Inject('IAdminSettingsRepository')
    private readonly adminSettingsRepository: IAdminSettingsRepository,
  ) {}

  async execute(query: ValidateAdminPinQuery): Promise<boolean> {
    const settings = await this.adminSettingsRepository.get();
    return settings.toPrimitives().adminPin === query.pin;
  }
}
