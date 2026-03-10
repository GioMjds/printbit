import { ScanDeliveryToken } from '@/domain';
import type { ScanDeliveryToken as PrismaScanDeliveryToken } from '@prisma/client';

export class ScanDeliveryTokenMapper {
  toDomain(model: PrismaScanDeliveryToken): ScanDeliveryToken {
    return ScanDeliveryToken.reconstitute({
      id: model.id,
      token: model.token,
      filePath: model.filePath,
      filename: model.filename,
      createdAt: model.createdAt.toISOString(),
      expiresAt: model.expiresAt.toISOString(),
    });
  }

  toPersistence(entity: ScanDeliveryToken): {
    id: string;
    token: string;
    filePath: string;
    filename: string;
    createdAt: Date;
    expiresAt: Date;
  } {
    const data = entity.toPrimitives();
    return {
      id: data.id,
      token: data.token,
      filePath: data.filePath,
      filename: data.filename,
      createdAt: new Date(data.createdAt),
      expiresAt: new Date(data.expiresAt),
    };
  }
}
