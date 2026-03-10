import { Provider } from '@nestjs/common';
import { PORT_TOKENS } from '@/infrastructure/hardware/tokens';
import { SocketIoEventAdapter } from './socket-io-event.adapter';

export const EventAdapterProviders: Provider[] = [
  SocketIoEventAdapter,
  {
    provide: PORT_TOKENS.EVENT_PUBLISHER,
    useExisting: SocketIoEventAdapter,
  },
];
