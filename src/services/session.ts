import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { Request } from 'express';
import { PUBLIC_URL } from '../config/http';

export interface UploadedDocument {
  documentId: string;
  sessionId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: Date;
  // The full path to the uploaded file on the server, e.g. "uploads/abc123"
  filePath: string;
}

export interface Session {
  sessionId: string;
  token: string;
  // Full URL the phone should open to upload a file
  uploadUrl: string;
  status: 'pending' | 'uploaded';
  documents?: UploadedDocument[];
  document?: UploadedDocument;
  createdAt: Date;
}

export interface StoreUploadResult {
  isSuccess: boolean;
  document?: UploadedDocument;
  errorMsg: string;
  errorCode: string;
}

const ALLOWED_TYPES = new Map<string, string>([
  ['application/pdf', '.pdf'],
  ['application/msword', '.doc'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.docx',
  ],
  ['application/vnd.ms-excel', '.xls'],
  [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsx',
  ],
  ['application/vnd.ms-powerpoint', '.ppt'],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pptx',
  ],
]);

const MAX_BYTES = 25 * 1024 * 1024; // 25MB

// Session limits
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FILES_PER_SESSION = 10;
const MAX_CUMULATIVE_BYTES = 50 * 1024 * 1024; // 50MB total per session
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // run cleanup every 2 minutes

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  private readonly byToken = new Map<string, string>();
  private readonly uploadDir: string;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(uploadDir = 'uploads') {
    this.uploadDir = uploadDir;
    fs.mkdirSync(uploadDir, { recursive: true });
    this.cleanupTimer = setInterval(
      () => this.cleanupExpired(),
      CLEANUP_INTERVAL_MS,
    );
  }

  /** Check whether a session is still within its TTL window. */
  isSessionExpired(session: Session): boolean {
    return Date.now() - session.createdAt.getTime() > SESSION_TTL_MS;
  }

  /** Check if a token maps to a valid, non-expired session. */
  isTokenValid(token: string): boolean {
    const sessionId = this.byToken.get(token);
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return !this.isSessionExpired(session);
  }

  createSession(baseUrl: URL): Session {
    const sessionId = randomUUID();
    const token = randomUUID();
    const uploadUrl = new URL(`/upload/${token}`, baseUrl).toString();

    const session: Session = {
      sessionId,
      token,
      uploadUrl,
      status: 'pending',
      createdAt: new Date(),
    };

    this.sessions.set(sessionId, session);
    this.byToken.set(token, sessionId);
    return session;
  }

  tryGetSession(sessionId: string, publicBaseUrl: URL): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.isSessionExpired(session)) return null;
    return this.withFreshUrl(session, publicBaseUrl);
  }

  tryGetSessionByToken(token: string, publicBaseUrl: URL): Session | null {
    const sessionId = this.byToken.get(token);
    if (!sessionId) return null;
    return this.tryGetSession(sessionId, publicBaseUrl);
  }

  async storeUpload(
    sessionId: string,
    token: string,
    file: Express.Multer.File,
  ): Promise<StoreUploadResult> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return {
        isSuccess: false,
        errorMsg: 'Session not found',
        errorCode: 'SESSION_NOT_FOUND',
      };
    }

    if (this.isSessionExpired(session)) {
      return {
        isSuccess: false,
        errorMsg:
          'Session has expired. Please start a new session from the kiosk.',
        errorCode: 'SESSION_EXPIRED',
      };
    }

    if (session.token !== token) {
      return {
        isSuccess: false,
        errorMsg: 'Invalid token for session',
        errorCode: 'INVALID_TOKEN',
      };
    }

    if (file.size > MAX_BYTES) {
      return {
        isSuccess: false,
        errorMsg: `File size exceeds limit of ${MAX_BYTES} bytes`,
        errorCode: 'FILE_TOO_LARGE',
      };
    }

    // Per-session file count limit
    const existingDocs =
      session.documents ?? (session.document ? [session.document] : []);
    if (existingDocs.length >= MAX_FILES_PER_SESSION) {
      return {
        isSuccess: false,
        errorMsg: `Maximum of ${MAX_FILES_PER_SESSION} files per session reached.`,
        errorCode: 'MAX_FILES_REACHED',
      };
    }

    // Per-session cumulative size limit
    const cumulativeBytes = existingDocs.reduce(
      (sum, d) => sum + d.sizeBytes,
      0,
    );
    if (cumulativeBytes + file.size > MAX_CUMULATIVE_BYTES) {
      return {
        isSuccess: false,
        errorMsg: `Total upload size would exceed ${MAX_CUMULATIVE_BYTES / (1024 * 1024)}MB session limit.`,
        errorCode: 'SESSION_SIZE_LIMIT',
      };
    }

    const allowedExt = ALLOWED_TYPES.get(file.mimetype);
    if (!allowedExt) {
      return {
        isSuccess: false,
        errorMsg: `Unsupported file type: ${file.mimetype}. Use PDF, Word, Excel, or PowerPoint documents.`,
        errorCode: 'UNSUPPORTED_TYPE',
      };
    }

    const documentId = randomUUID();
    const safeName = `${documentId}${allowedExt}`;
    const destPath = path.join(this.uploadDir, safeName);
    await fs.promises.rename(file.path, destPath);

    const document: UploadedDocument = {
      documentId,
      sessionId,
      filename: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
      uploadedAt: new Date(),
      filePath: destPath,
    };

    const documents = session.documents
      ? [...session.documents]
      : session.document
        ? [session.document]
        : [];

    documents.push(document);
    session.documents = documents;
    session.status = 'uploaded';
    session.document = document;

    return { isSuccess: true, document, errorCode: '', errorMsg: '' };
  }

  private withFreshUrl(session: Session, publicBaseUrl: URL): Session {
    const freshUrl = new URL(
      `/upload/${encodeURIComponent(session.token)}`,
      publicBaseUrl,
    ).toString();
    return { ...session, uploadUrl: freshUrl };
  }

  /** Return the token of the most recently created non-expired session (for captive portal redirect). */
  getActiveSessionToken(): string | null {
    let latest: Session | null = null;
    for (const session of this.sessions.values()) {
      if (this.isSessionExpired(session)) continue;
      if (!latest || session.createdAt > latest.createdAt) {
        latest = session;
      }
    }
    return latest?.token ?? null;
  }

  /** Cancel a session immediately and delete all uploaded files. */
  async cancelSession(
    sessionId: string,
  ): Promise<{ success: boolean; deletedFileCount: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, deletedFileCount: 0 };
    }

    // Delete uploaded files asynchronously to avoid blocking the event loop
    const docs =
      session.documents ?? (session.document ? [session.document] : []);
    const deletionResults = await Promise.allSettled(
      docs.map((doc) => fs.promises.unlink(doc.filePath)),
    );

    // Count successful deletions
    const deletedCount = deletionResults.filter(
      (result) => result.status === 'fulfilled',
    ).length;

    // Remove session from maps
    this.byToken.delete(session.token);
    this.sessions.delete(sessionId);

    return { success: true, deletedFileCount: deletedCount };
  }

  /** Remove expired sessions and their uploaded files from disk. */
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt.getTime() <= SESSION_TTL_MS) continue;

      // Delete uploaded files asynchronously to avoid blocking the event loop
      const docs =
        session.documents ?? (session.document ? [session.document] : []);
      void Promise.allSettled(
        docs.map((doc) => fs.promises.unlink(doc.filePath)),
      );

      this.byToken.delete(session.token);
      this.sessions.delete(id);
    }
  }

  /** Stop the cleanup timer (for graceful shutdown). */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export function renderUploadPortal(token: string, portalHtmlPath: string) {
  if (!fs.existsSync(portalHtmlPath)) {
    throw new Error(`Upload portal HTML not found at: ${portalHtmlPath}`);
  }

  let template = fs.readFileSync(portalHtmlPath, 'utf-8');

  // Inject <base href> so relative asset URLs resolve under /upload/{token}/
  const safeToken = encodeURIComponent(token);
  const assetBase = `/upload/${safeToken}/`;
  template = template.replace('<head>', `<head>\n  <base href="${assetBase}">`);

  // Inject token into the placeholder used by app.ts
  template = template.replace('{{token}}', token.replace(/"/g, '&quot;'));

  return template;
}

export function resolvePublicBaseUrl(req: Request): URL {
  if (PUBLIC_URL) return new URL(PUBLIC_URL);

  const protocol = req.protocol;
  const host = req.get('host') ?? 'localhost';

  return new URL(`${protocol}://${host}`);
}
