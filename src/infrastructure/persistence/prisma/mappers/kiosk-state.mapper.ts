import { KioskState } from '@/domain';
import type { KioskState as PrismaKioskState } from '@prisma/client';

export class KioskStateMapper {
  toDomain(model: PrismaKioskState): KioskState {
    return KioskState.create(model.balance, model.earnings);
  }

  toPersistence(entity: KioskState): { balance: number; earnings: number } {
    return entity.toPrimitives();
  }
}
