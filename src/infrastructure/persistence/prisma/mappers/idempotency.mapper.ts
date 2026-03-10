import { IdempotencyEntry } from '@/domain';
import type { IdempotencyRecord } from '@prisma/client';

export class IdempotencyMapper {
  toDomain(model: IdempotencyRecord): IdempotencyEntry {
    return {
      key: model.key,
      statusCode: model.statusCode,
      response: JSON.parse(model.response) as unknown,
      expiresAt: model.expiresAt.toISOString(),
    };
  }

  toPersistence(entry: IdempotencyEntry): {
    key: string;
    statusCode: number;
    response: string;
    expiresAt: Date;
  } {
    return {
      key: entry.key,
      statusCode: entry.statusCode,
      response: JSON.stringify(entry.response),
      expiresAt: new Date(entry.expiresAt),
    };
  }
}
