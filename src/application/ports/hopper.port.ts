export interface IHopperPort {
  dispenseChange(amountCents: number): Promise<void>;
  selfTest(): Promise<void>;
}
