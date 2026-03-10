import { Module } from '@nestjs/common';
import {
  ScanUseCaseHandlers,
} from '@/application/use-cases/scan';
import { HardwareAdapterProviders } from '@/infrastructure';
import { PrismaModule, PrismaRepositoryProviders } from '@/infrastructure/persistence/prisma';
import { ScanController } from './scan.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ScanController],
  providers: [
    ...ScanUseCaseHandlers,
    ...PrismaRepositoryProviders,
    ...HardwareAdapterProviders,
  ],
})
export class ScanModule {}
