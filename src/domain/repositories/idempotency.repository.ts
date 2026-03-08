export interface IdempotencyEntry {
	key: string;
	statusCode: number;
	response: unknown;
	expiresAt: string;
}

export interface IIdempotencyRepository {
	findByKey(key: string): Promise<IdempotencyEntry | null>;
	save(entry: IdempotencyEntry): Promise<void>;
	delete(key: string): Promise<void>;
	deleteExpired(nowIso: string): Promise<number>;
}
