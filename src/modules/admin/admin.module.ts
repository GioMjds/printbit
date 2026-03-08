import { Module } from '@nestjs/common';
import {
  AdminUseCaseHandlers,
} from '@/application/use-cases/admin';
import { HardwareAdapterProviders } from '@/infrastructure';
import { PrismaModule, PrismaRepositoryProviders } from '@/infrastructure/persistence/prisma';
import { AdminController } from './admin.controller';
import { AdminLocalGuard } from './guards/admin-local.guard';
import { AdminPinGuard } from './guards/admin-pin.guard';

@Module({
  imports: [PrismaModule],
  controllers: [AdminController],
  providers: [
    ...AdminUseCaseHandlers,
    ...PrismaRepositoryProviders,
    ...HardwareAdapterProviders,
    AdminLocalGuard,
    AdminPinGuard,
  ],
})
export class AdminModule {}
