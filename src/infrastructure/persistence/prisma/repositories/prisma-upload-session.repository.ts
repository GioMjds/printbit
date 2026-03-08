import { Injectable } from '@nestjs/common';
import { IUploadSessionRepository, UploadSession } from '@/domain';
import { PrismaService } from '../prisma.service';
import { UploadSessionMapper } from '../mappers';

@Injectable()
export class PrismaUploadSessionRepository implements IUploadSessionRepository {
  private readonly mapper = new UploadSessionMapper();

  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<UploadSession | null> {
    const row = await this.prisma.uploadSession.findUnique({
      where: { id },
      include: { files: true },
    });

    if (!row) return null;
    return this.mapper.toDomain(row, row.files);
  }

  async findByToken(token: string): Promise<UploadSession | null> {
    const row = await this.prisma.uploadSession.findUnique({
      where: { token },
      include: { files: true },
    });

    if (!row) return null;
    return this.mapper.toDomain(row, row.files);
  }

  async create(session: UploadSession): Promise<void> {
    await this.persist(session);
  }

  async save(session: UploadSession): Promise<void> {
    await this.persist(session);
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.uploadSession.deleteMany({ where: { id } });
  }

  async deleteExpired(nowIso: string): Promise<number> {
    const result = await this.prisma.uploadSession.deleteMany({
      where: {
        expiresAt: { lte: new Date(nowIso) },
      },
    });
    return result.count;
  }

  private async persist(session: UploadSession): Promise<void> {
    const data = session.toPrimitives();
    const expiresAt = new Date(new Date(data.createdAt).getTime() + UploadSession.TTL_MS);

    await this.prisma.uploadSession.upsert({
      where: { id: data.id },
      update: {
        token: data.token,
        uploadUrl: data.uploadUrl,
        status: data.status,
        createdAt: new Date(data.createdAt),
        expiresAt,
      },
      create: {
        id: data.id,
        token: data.token,
        uploadUrl: data.uploadUrl,
        status: data.status,
        createdAt: new Date(data.createdAt),
        expiresAt,
      },
    });

    await this.prisma.uploadFile.deleteMany({ where: { sessionId: data.id } });

    if (data.documents.length > 0) {
      await this.prisma.uploadFile.createMany({
        data: data.documents.map((document) => ({
          id: document.id,
          sessionId: data.id,
          filename: document.filename,
          originalName: document.originalName,
          contentType: document.contentType,
          sizeBytes: document.sizeBytes,
          filePath: document.filePath,
          uploadedAt: new Date(document.uploadedAt),
        })),
      });
    }
  }
}
