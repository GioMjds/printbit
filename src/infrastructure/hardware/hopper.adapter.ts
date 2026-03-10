import { Injectable } from '@nestjs/common';
import { IHopperPort } from '@/application/ports';
import { dispenseChange, runHopperSelfTest } from '@/services';

@Injectable()
export class HopperAdapter implements IHopperPort {
  async dispenseChange(amountCents: number): Promise<void> {
    const amount = Number((amountCents / 100).toFixed(2));
    await dispenseChange(amount);
  }

  async selfTest(): Promise<void> {
    await runHopperSelfTest();
  }
}
