import { Module } from '@nestjs/common';
import {
  FinancialUseCaseHandlers,
} from '@/application/use-cases/financial';
import {
  HardwareAdapterProviders,
} from '@/infrastructure';
import { PrismaModule, PrismaRepositoryProviders } from '@/infrastructure/persistence/prisma';
import { FinancialController } from './financial.controller';

@Module({
  imports: [PrismaModule],
  controllers: [FinancialController],
  providers: [
    ...FinancialUseCaseHandlers,
    ...PrismaRepositoryProviders,
    ...HardwareAdapterProviders,
  ],
})
export class FinancialModule {}
