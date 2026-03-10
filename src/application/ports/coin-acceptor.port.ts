export interface ICoinAcceptorPort {
  onCoinInserted(callback: (valueCents: number) => Promise<void> | void): void;
}
