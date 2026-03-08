import { CoinStats } from '@/domain/entities';

export interface ICoinStatsRepository {
	get(): Promise<CoinStats>;
	save(stats: CoinStats): Promise<void>;
}
