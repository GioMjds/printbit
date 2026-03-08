import { Global, Module } from '@nestjs/common';
import { EventAdapterProviders } from '@/infrastructure/events';

@Global()
@Module({
  providers: [...EventAdapterProviders],
  exports: [...EventAdapterProviders],
})
export class EventsModule {}
