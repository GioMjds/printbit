import { Module } from '@nestjs/common';
import {
  WirelessSessionUseCaseHandlers,
} from '@/application/use-cases/wireless-session';
import {
  HardwareAdapterProviders,
  StorageAdapterProviders,
} from '@/infrastructure';
import { PrismaModule, PrismaRepositoryProviders } from '@/infrastructure/persistence/prisma';
import { WirelessSessionController } from './wireless-session.controller';

@Module({
  imports: [PrismaModule],
  controllers: [WirelessSessionController],
  providers: [
    ...WirelessSessionUseCaseHandlers,
    ...PrismaRepositoryProviders,
    ...StorageAdapterProviders,
    ...HardwareAdapterProviders,
  ],
})
export class WirelessSessionModule {}
