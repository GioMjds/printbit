import { ValidationException } from '@/domain/errors';

export type CoinDenominationValue = 1 | 5 | 10 | 20;

const ALLOWED: ReadonlySet<number> = new Set([1, 5, 10, 20]);

export class CoinDenomination {
	private constructor(private readonly denomination: CoinDenominationValue) {}

	static from(value: number): CoinDenomination {
		if (!ALLOWED.has(value)) {
			throw new ValidationException('Coin denomination must be one of 1, 5, 10, or 20.');
		}
		return new CoinDenomination(value as CoinDenominationValue);
	}

	get value(): CoinDenominationValue {
		return this.denomination;
	}
}
