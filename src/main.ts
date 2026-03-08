import os from 'os';
import { NestFactory } from '@nestjs/core';
import { Server } from 'socket.io';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './shared/filters/domain-exception.filter';
import { SocketIoEventAdapter } from './infrastructure/events/socket-io-event.adapter';

function getLocalIPv4(): string {
  const interfaces = os.networkInterfaces();
  let fallback = '0.0.0.0';

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family !== 'IPv4' || iface.internal) continue;

      const isHotspot =
        /Wi-Fi Direct|Local Area Connection\*/i.test(name) ||
        iface.address.startsWith('192.168.5.') ||
        iface.address.startsWith('192.168.137.');
      if (isHotspot) return iface.address;

      if (fallback === '0.0.0.0') fallback = iface.address;
    }
  }

  return fallback;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new DomainExceptionFilter());

  const httpServer = app.getHttpServer();
  const io = new Server(httpServer);

  const socketAdapter = app.get(SocketIoEventAdapter);
  socketAdapter.setServer(io);

  io.on('connection', (socket) => {
    socket.on('joinSession', (sessionId: string) => {
      socket.join(`session:${sessionId}`);
    });
  });

  await app.listen(3000, '0.0.0.0');

  const ip = getLocalIPv4();
  console.log(`NestJS running → http://${ip}:3000`);
}

bootstrap();