import { CoinDenomination } from '@/domain/value-objects';

export interface CoinStatsProps {
	one: number;
	five: number;
	ten: number;
	twenty: number;
}

export class CoinStats {
	private constructor(private readonly props: CoinStatsProps) {}

	static create(props: CoinStatsProps): CoinStats {
		return new CoinStats({ ...props });
	}

	increment(denomination: CoinDenomination): CoinStats {
		const value = denomination.value;
		return new CoinStats({
			one: this.props.one + (value === 1 ? 1 : 0),
			five: this.props.five + (value === 5 ? 1 : 0),
			ten: this.props.ten + (value === 10 ? 1 : 0),
			twenty: this.props.twenty + (value === 20 ? 1 : 0),
		});
	}

	toPrimitives(): CoinStatsProps {
		return { ...this.props };
	}
}
