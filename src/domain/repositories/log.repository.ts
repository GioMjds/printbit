import { Log } from '@/domain/entities';

export interface ILogRepository {
	create(entry: Log): Promise<void>;
	findAll(limit?: number, offset?: number): Promise<Log[]>;
	findByType(type: string, limit?: number, offset?: number): Promise<Log[]>;
}
