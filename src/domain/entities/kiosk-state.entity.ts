import { Money } from "@/domain/value-objects";

export class KioskState {
  private constructor(
    private balance: Money,
    private earnings: Money,
  ) {}

  static create(balanceAmount: number, earningsAmount: number): KioskState {
    const balance = Money.fromCents(balanceAmount);
    const earnings = Money.fromCents(earningsAmount);
    return new KioskState(balance, earnings);
  }

  getBalanceAmount(): number {
    return this.balance.value;
  }

  getBalanceCents(): number {
    return this.getBalanceAmount();
  }

  getEarningsAmount(): number {
    return this.earnings.value;
  }

  getEarningsCents(): number {
    return this.getEarningsAmount();
  }

  canAfford(amount: Money): boolean {
    return this.balance.value >= amount.value;
  }

  addCoins(amount: Money): void {
    this.balance = this.balance.add(amount);
  }

  confirmPayment(cost: Money): void {
    this.balance = this.balance.subtract(cost);
    this.earnings = this.earnings.add(cost);
  }

  resetBalance(): void {
    this.balance = Money.fromCents(0);
  }

  toPrimitives(): { balance: number; earnings: number } {
    return {
      balance: this.balance.value,
      earnings: this.earnings.value,
    };
  }
}