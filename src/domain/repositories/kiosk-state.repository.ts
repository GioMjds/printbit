import { KioskState } from '@/domain/entities';

export interface IKioskStateRepository {
  get(): Promise<KioskState>;
  save(state: KioskState): Promise<void>;
}