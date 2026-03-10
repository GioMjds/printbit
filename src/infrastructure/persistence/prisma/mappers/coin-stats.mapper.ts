import { CoinStats } from '@/domain';
import type { CoinStats as PrismaCoinStats } from '@prisma/client';

export class CoinStatsMapper {
  toDomain(model: PrismaCoinStats): CoinStats {
    return CoinStats.create({
      one: model.one,
      five: model.five,
      ten: model.ten,
      twenty: model.twenty,
    });
  }

  toPersistence(entity: CoinStats): {
    one: number;
    five: number;
    ten: number;
    twenty: number;
  } {
    return entity.toPrimitives();
  }
}
