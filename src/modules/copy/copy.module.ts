import { Module } from '@nestjs/common';
import { CopyUseCaseHandlers } from '@/application/use-cases/copy';
import { HardwareAdapterProviders } from '@/infrastructure';
import { CopyController } from './copy.controller';

@Module({
  controllers: [CopyController],
  providers: [
    ...CopyUseCaseHandlers,
    ...HardwareAdapterProviders,
  ],
})
export class CopyModule {}
