import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { IAdminSettingsRepository } from '@/domain';
import { UpdateAdminSettingsRequestDto } from '@/application/dto';

export class GetAdminSettingsQuery {}

@QueryHandler(GetAdminSettingsQuery)
export class GetAdminSettingsUseCase implements IQueryHandler<GetAdminSettingsQuery, UpdateAdminSettingsRequestDto> {
  constructor(
    @Inject('IAdminSettingsRepository')
    private readonly adminSettingsRepository: IAdminSettingsRepository,
  ) {}

  async execute(_query: GetAdminSettingsQuery): Promise<UpdateAdminSettingsRequestDto> {
    const settings = await this.adminSettingsRepository.get();
    const data = settings.toPrimitives();

    return {
      printPerPage: data.pricing.printPerPage,
      copyPerPage: data.pricing.copyPerPage,
      scanDocument: data.pricing.scanDocument,
      colorSurcharge: data.pricing.colorSurcharge,
      idleTimeoutSeconds: data.idleTimeoutSeconds,
      adminPin: data.adminPin,
      adminLocalOnly: data.adminLocalOnly,
      hopperEnabled: data.hopper.enabled,
      hopperTimeoutMs: data.hopper.timeoutMs,
      hopperRetryCount: data.hopper.retryCount,
    };
  }
}
