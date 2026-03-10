import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { IEventPublisherPort } from '@/application/ports';

@Injectable()
export class SocketIoEventAdapter implements IEventPublisherPort {
  private server: Server | null = null;

  setServer(server: Server): void {
    this.server = server;
  }

  emitBalance(balance: number): void {
    this.server?.emit('balance', balance);
  }

  emitCoinAccepted(value: number, balance: number): void {
    this.server?.emit('coinAccepted', { value, balance });
  }

  emitUploadEvent(
    sessionId: string,
    eventName: 'UploadStarted' | 'UploadCompleted' | 'UploadFailed',
    payload: Record<string, string | number | boolean | null>,
  ): void {
    this.server?.to(`session:${sessionId}`).emit(eventName, payload);
  }
}
