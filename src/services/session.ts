import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { Request } from 'express';
import { PUBLIC_URL } from '../config/http';

export interface DocumentPageAnalysis {
  index: number;
  isColor: boolean;
}

export interface DocumentAnalysis {
  fileType: 'pdf' | 'docx' | 'doc' | 'image' | 'unknown';
  pageCount: number;
  pages: DocumentPageAnalysis[];
  colorPages: number;
  bwPages: number;
  totalPages: number;
  analyzedAt: Date;
}

export interface UploadedDocument {
  documentId: string;
  sessionId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: Date;
  /** The full path to the uploaded file on the server, e.g. "uploads/abc123" */
  filePath: string;
  analysis?: DocumentAnalysis;
}

export interface Session {
  sessionId: string;
  token: string;
  /** Full URL the phone should open to upload a file */
  uploadUrl: string;
  status: 'pending' | 'uploaded';
  documents?: UploadedDocument[];
  document?: UploadedDocument;
  createdAt: Date;
  lastActivityAt: Date;
  ownerClientId?: string;
  ownerClaimedAt?: Date;
  expiresAt?: Date;
  remainingSeconds?: number;
  ttlSeconds?: number;
  warningThresholdSeconds?: number;
}

export interface StoreUploadResult {
  isSuccess: boolean;
  document?: UploadedDocument;
  errorMsg: string;
  errorCode: string;
}

export interface RemoveDocumentResult {
  success: boolean;
  errorCode?: 'SESSION_NOT_FOUND' | 'SESSION_EXPIRED' | 'DOCUMENT_NOT_FOUND';
  removedDocumentId?: string;
  remainingCount: number;
  deletedFile: boolean;
}

export type SessionState = 'active' | 'expired' | 'missing';

export interface OwnerClaimResult {
  ok: boolean;
  errorCode?:
    | 'SESSION_NOT_FOUND'
    | 'SESSION_EXPIRED'
    | 'INVALID_TOKEN'
    | 'INVALID_CLIENT_ID'
    | 'SESSION_OWNED';
  errorMsg?: string;
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
const SESSION_WARNING_SECONDS = 60;
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
    return Date.now() - session.lastActivityAt.getTime() > SESSION_TTL_MS;
  }

  /** Check if a token maps to a valid, non-expired session. */
  isTokenValid(token: string): boolean {
    const sessionId = this.byToken.get(token);
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (this.isSessionExpired(session)) {
      this.pruneExpiredSession(sessionId, session);
      return false;
    }
    return true;
  }

  getSessionState(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) return 'missing';
    if (this.isSessionExpired(session)) {
      this.pruneExpiredSession(sessionId, session);
      return 'expired';
    }
    return 'active';
  }

  getTokenState(token: string): SessionState {
    const sessionId = this.byToken.get(token);
    if (!sessionId) return 'missing';
    return this.getSessionState(sessionId);
  }

  createSession(baseUrl: URL): Session {
    const sessionId = randomUUID();
    const token = randomUUID();
    const uploadUrl = new URL(`/upload/${token}`, baseUrl).toString();
    const now = new Date();

    const session: Session = {
      sessionId,
      token,
      uploadUrl,
      status: 'pending',
      createdAt: now,
      lastActivityAt: now,
    };

    this.sessions.set(sessionId, session);
    this.byToken.set(token, sessionId);
    return session;
  }

  tryGetSession(sessionId: string, publicBaseUrl: URL): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.isSessionExpired(session)) {
      this.pruneExpiredSession(sessionId, session);
      return null;
    }
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
      this.pruneExpiredSession(sessionId, session);
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

    this.touchSession(sessionId);

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

    if (!file.buffer) {
      throw new Error('Uploaded file is missing in-memory content buffer.');
    }

    await fs.promises.writeFile(destPath, file.buffer);

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

  setDocumentAnalysis(
    sessionId: string,
    documentId: string,
    analysis: Omit<DocumentAnalysis, 'analyzedAt'>,
  ): DocumentAnalysis | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.isSessionExpired(session)) {
      this.pruneExpiredSession(sessionId, session);
      return null;
    }

    const docs =
      session.documents ?? (session.document ? [session.document] : []);
    const target = docs.find((doc) => doc.documentId === documentId);
    if (!target) return null;

    const stamped: DocumentAnalysis = {
      ...analysis,
      analyzedAt: new Date(),
    };

    target.analysis = stamped;
    if (session.document?.documentId === documentId) {
      session.document.analysis = stamped;
    }

    this.touchSession(sessionId);
    return stamped;
  }

  async removeDocument(
    sessionId: string,
    documentId: string,
  ): Promise<RemoveDocumentResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        success: false,
        errorCode: 'SESSION_NOT_FOUND',
        remainingCount: 0,
        deletedFile: false,
      };
    }
    if (this.isSessionExpired(session)) {
      this.pruneExpiredSession(sessionId, session);
      return {
        success: false,
        errorCode: 'SESSION_EXPIRED',
        remainingCount: 0,
        deletedFile: false,
      };
    }

    const docs = session.documents
      ? [...session.documents]
      : session.document
        ? [session.document]
        : [];
    const index = docs.findIndex((doc) => doc.documentId === documentId);
    if (index < 0) {
      return {
        success: false,
        errorCode: 'DOCUMENT_NOT_FOUND',
        remainingCount: docs.length,
        deletedFile: false,
      };
    }

    const [removed] = docs.splice(index, 1);
    let deletedFile = true;
    try {
      await fs.promises.unlink(removed.filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') deletedFile = false;
    }

    session.documents = docs;
    if (docs.length > 0) {
      session.document = docs[docs.length - 1];
      session.status = 'uploaded';
    } else {
      delete session.document;
      session.status = 'pending';
    }
    this.touchSession(sessionId);

    return {
      success: true,
      removedDocumentId: removed.documentId,
      remainingCount: docs.length,
      deletedFile,
    };
  }

  private withFreshUrl(session: Session, publicBaseUrl: URL): Session {
    const freshUrl = new URL(
      `/upload/${encodeURIComponent(session.token)}`,
      publicBaseUrl,
    ).toString();
    return {
      ...session,
      uploadUrl: freshUrl,
      expiresAt: new Date(this.getExpiryTimestamp(session)),
      remainingSeconds: this.getRemainingSeconds(session),
      ttlSeconds: Math.floor(SESSION_TTL_MS / 1000),
      warningThresholdSeconds: SESSION_WARNING_SECONDS,
    };
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

  touchSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (this.isSessionExpired(session)) {
      this.pruneExpiredSession(sessionId, session);
      return false;
    }
    session.lastActivityAt = new Date();
    return true;
  }

  touchSessionByToken(token: string): boolean {
    const sessionId = this.byToken.get(token);
    if (!sessionId) return false;
    return this.touchSession(sessionId);
  }

  claimOwner(
    sessionId: string,
    token: string,
    clientId: string,
  ): OwnerClaimResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        errorCode: 'SESSION_NOT_FOUND',
        errorMsg: 'Session not found.',
      };
    }
    if (this.isSessionExpired(session)) {
      this.pruneExpiredSession(sessionId, session);
      return {
        ok: false,
        errorCode: 'SESSION_EXPIRED',
        errorMsg: 'Session has expired. Please start a new session.',
      };
    }
    if (session.token !== token) {
      return {
        ok: false,
        errorCode: 'INVALID_TOKEN',
        errorMsg: 'Invalid session token.',
      };
    }

    const safeClientId = clientId.trim();
    if (!safeClientId) {
      return {
        ok: false,
        errorCode: 'INVALID_TOKEN',
        errorMsg: 'Missing upload client identifier.',
      };
    }

    if (session.ownerClientId && session.ownerClientId !== safeClientId) {
      return {
        ok: false,
        errorCode: 'SESSION_OWNED',
        errorMsg:
          'This session is already active on another device. Start a new session from the kiosk.',
      };
    }

    if (!session.ownerClientId) {
      session.ownerClientId = safeClientId;
      session.ownerClaimedAt = new Date();
    }

    session.lastActivityAt = new Date();
    return { ok: true };
  }

  claimOwnerByToken(token: string, clientId: string): OwnerClaimResult {
    const sessionId = this.byToken.get(token);
    if (!sessionId) {
      return {
        ok: false,
        errorCode: 'SESSION_NOT_FOUND',
        errorMsg: 'Session not found.',
      };
    }
    return this.claimOwner(sessionId, token, clientId);
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
    for (const [id, session] of this.sessions.entries()) {
      if (this.isSessionExpired(session)) {
        this.pruneExpiredSession(id, session);
      }
    }
  }

  private getExpiryTimestamp(session: Session): number {
    return session.lastActivityAt.getTime() + SESSION_TTL_MS;
  }

  private getRemainingSeconds(session: Session): number {
    const remainingMs = this.getExpiryTimestamp(session) - Date.now();
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }

  private pruneExpiredSession(sessionId: string, session: Session): void {
    const docs =
      session.documents ?? (session.document ? [session.document] : []);
    void Promise.allSettled(
      docs.map((doc) => fs.promises.unlink(doc.filePath)),
    );
    this.byToken.delete(session.token);
    this.sessions.delete(sessionId);
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
