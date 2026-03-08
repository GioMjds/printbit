import { Log, LogMeta } from '@/domain';
import type { Log as PrismaLog } from '@prisma/client';

export class LogMapper {
  toDomain(model: PrismaLog): Log {
    const meta = model.meta ? (JSON.parse(model.meta) as LogMeta) : undefined;
    return Log.reconstitute({
      id: model.id,
      timestamp: model.timestamp.toISOString(),
      type: model.type,
      message: model.message,
      meta,
    });
  }

  toPersistence(entity: Log): {
    id: string;
    timestamp: Date;
    type: string;
    message: string;
    meta: string | null;
  } {
    const data = entity.toPrimitives();
    return {
      id: data.id,
      timestamp: new Date(data.timestamp),
      type: data.type,
      message: data.message,
      meta: data.meta ? JSON.stringify(data.meta) : null,
    };
  }
}
