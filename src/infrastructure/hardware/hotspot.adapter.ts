import { Injectable } from '@nestjs/common';
import { IHotspotPort } from '@/application/ports';
import { isHotspotRunning, startHotspot, stopHotspot } from '@/services';

@Injectable()
export class HotspotAdapter implements IHotspotPort {
  async start(): Promise<void> {
    await startHotspot();
  }

  async stop(): Promise<void> {
    stopHotspot();
  }

  isRunning(): boolean {
    return isHotspotRunning();
  }
}
