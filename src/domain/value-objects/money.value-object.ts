import { ValidationException } from '@/domain/errors';

export class Money {
  private constructor(private readonly amount: number) {}

  static fromCents(value: number): Money {
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationException(
        'Amount must be a non-negative integer representing cents.',
      );
    }
    return new Money(value);
  }

  get value(): number {
    return this.amount;
  }

  add(other: Money): Money {
    return new Money(this.amount + other.amount);
  }

  subtract(other: Money): Money {
    const next = this.amount - other.amount;
    if (next < 0) {
      throw new ValidationException('Insufficient funds.');
    }
    return new Money(next);
  }

  multiply(multiplier: number): Money {
    if (!Number.isInteger(multiplier) || multiplier < 0) {
      throw new ValidationException(
        'Multiplier must be a non-negative integer.',
      );
    }
    return new Money(this.amount * multiplier);
  }

  equals(other: Money): boolean {
    return this.amount === other.amount;
  }
}
