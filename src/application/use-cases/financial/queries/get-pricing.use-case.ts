import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { IAdminSettingsRepository } from '@/domain';
import { PricingResponseDto } from '@/application/dto';

export class GetPricingQuery {}

@QueryHandler(GetPricingQuery)
export class GetPricingUseCase implements IQueryHandler<GetPricingQuery, PricingResponseDto> {
  constructor(
    @Inject('IAdminSettingsRepository')
    private readonly adminSettingsRepository: IAdminSettingsRepository,
  ) {}

  async execute(): Promise<PricingResponseDto> {
    const settings = await this.adminSettingsRepository.get();
    const { pricing } = settings.toPrimitives();

    return {
      printPerPage: pricing.printPerPage,
      copyPerPage: pricing.copyPerPage,
      scanDocument: pricing.scanDocument,
      colorSurcharge: pricing.colorSurcharge,
    };
  }
}
