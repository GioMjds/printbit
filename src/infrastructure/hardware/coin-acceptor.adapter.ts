import { Injectable } from '@nestjs/common';
import { ICoinAcceptorPort } from '@/application/ports';

@Injectable()
export class CoinAcceptorAdapter implements ICoinAcceptorPort {
  onCoinInserted(_callback: (valueCents: number) => Promise<void> | void): void {
  }
}
