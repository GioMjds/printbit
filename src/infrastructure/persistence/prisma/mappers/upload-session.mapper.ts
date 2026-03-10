import { UploadSession } from '@/domain';
import type { UploadFile as PrismaUploadFile, UploadSession as PrismaUploadSession } from '@prisma/client';

export class UploadSessionMapper {
  toDomain(
    session: PrismaUploadSession,
    files: PrismaUploadFile[],
  ): UploadSession {
    return UploadSession.reconstitute({
      id: session.id,
      token: session.token,
      uploadUrl: session.uploadUrl,
      status: session.status as 'pending' | 'uploaded',
      createdAt: session.createdAt.toISOString(),
      documents: files.map((file) => ({
        id: file.id,
        filename: file.filename,
        originalName: file.originalName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        filePath: file.filePath,
        uploadedAt: file.uploadedAt.toISOString(),
      })),
    });
  }
}
