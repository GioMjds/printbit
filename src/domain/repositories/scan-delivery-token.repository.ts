import { ScanDeliveryToken } from '@/domain/entities';

export interface IScanDeliveryTokenRepository {
	create(token: ScanDeliveryToken): Promise<void>;
	findByToken(token: string): Promise<ScanDeliveryToken | null>;
	deleteByToken(token: string): Promise<void>;
	deleteExpired(nowIso: string): Promise<number>;
}
