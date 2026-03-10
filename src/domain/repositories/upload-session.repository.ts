import { UploadSession } from '@/domain/entities';

export interface IUploadSessionRepository {
  findById(id: string): Promise<UploadSession | null>;
  findByToken(token: string): Promise<UploadSession | null>;
  create(session: UploadSession): Promise<void>;
  save(session: UploadSession): Promise<void>;
  deleteById(id: string): Promise<void>;
  deleteExpired(nowIso: string): Promise<number>;
}