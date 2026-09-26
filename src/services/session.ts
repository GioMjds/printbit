import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import {
  PUBLIC_URL,
  NETWORK_PROVIDER,
  ESP32_KIOSK_SUBNET_PREFIX,
  ESP32_KIOSK_IP,
  ESP32_AP_BASE_URL,
  PORT,
} from '@/config/http.config';
import { getLocalIPv4 } from '@/utils/network';
import { detectEsp32KioskIp } from './hotspot';
import {
  wirelessSessionStore,
  type WirelessSessionDocumentStorageEntry,
  type WirelessSessionStorageEntry,
} from '@/core/database/sqlite-storage';
import { discardStagedUpload, promoteStagedUpload } from '@/services/upload-staging';
import type { CoverageTier } from '@/core/database/models/admin.model';
export { CoverageTier };

export interface PageAnalysis {
  index: number;
  isColor: boolean;
  coverage: number;             // contentCoverage (0.0 to 1.0)
  colorCoverage: number;        // colorCoverage (0.0 to 1.0)
  coverageTier: CoverageTier;   // 'low' | 'medium' | 'high' | 'very_high'
  isBlank: boolean;
  classification: 'blank' | 'bw' | 'color';
  fallbackReasonFlags?: string[];
  contentCoverage?: number;
  isImagePage?: boolean;
}

export function resolveCoverageTier(contentCoverage: number): CoverageTier {
  const coverage = contentCoverage > 1 ? contentCoverage / 100 : contentCoverage;
  if (coverage <= 0.10) return 'low';
  if (coverage <= 0.40) return 'medium';
  if (coverage <= 0.70) return 'high';
  return 'very_high';
}

export interface DocumentPageAnalysis {
  index: number;
  isColor: boolean;
  coverage?: number;
  colorCoverage?: number;
  coverageTier?: CoverageTier;
  isBlank?: boolean;
  classification?: 'blank' | 'bw' | 'color' | 'partial' | 'full_color' | 'image';
  fallbackReasonFlags?: string[];
  contentCoverage?: number;
  isImagePage?: boolean;
  imageCoverage?: number;
}

export interface DocumentAnalysis {
  analysisVersion?: number;
  fileType:
    | 'pdf'
    | 'docx'
    | 'doc'
    | 'xlsx'
    | 'xls'
    | 'pptx'
    | 'ppt'
    | 'image'
    | 'unknown';
  pageCount: number;
  pages: DocumentPageAnalysis[];
  colorPages: number;
  bwPages: number;
  totalPages: number;
  confidence: 'high' | 'medium' | 'low';
  analyzedAt: Date;
  isEntirelyBlank?: boolean;
  blankPages?: number[];
  blankPageCount?: number;
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
  /** Durable session-owned PDF generated from a non-PDF source upload. */
  convertedPdfPath?: string;
  /** SHA-256 of the original bytes; used to reject duplicate session uploads. */
  contentHash?: string;
  analysis?: DocumentAnalysis;
  analysisStatus?: 'pending' | 'completed' | 'failed';
  analysisError?: string | null;
  analysisRequestedAt?: Date;
  analysisVersion?: number;
}

export interface Session {
  sessionId: string;
  token: string;
  /** Full URL the phone should open to upload a file */
  uploadUrl: string;
  /** Public internet URL (optional, when PRINTBIT_PUBLIC_URL is configured). */
  publicUploadUrl?: string;
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

function getDocumentOwnedFilePaths(document: UploadedDocument): string[] {
  const sourcePath = path.resolve(document.filePath);
  const artifactPath = path.join(
    path.dirname(sourcePath),
    `${path.basename(document.documentId)}.pdf`,
  );
  return [
    sourcePath,
    ...(document.convertedPdfPath &&
    path.resolve(document.convertedPdfPath) === artifactPath
      ? [artifactPath]
      : []),
  ];
}

export interface RemoveDocumentResult {
  success: boolean;
  errorCode?:
    | 'SESSION_NOT_FOUND'
    | 'SESSION_EXPIRED'
    | 'DOCUMENT_NOT_FOUND'
    | 'SESSION_PERSIST_FAILED';
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
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
]);

const MAX_BYTES = 25 * 1024 * 1024; // 25MB

// Session limits
const DEFAULT_SESSION_EXPIRY_ENABLED = false;
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_WARNING_SECONDS = 60;
const MAX_FILES_PER_SESSION = 10;
const MAX_CUMULATIVE_BYTES = 50 * 1024 * 1024; // 50MB total per session
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // run cleanup every 2 minutes
const CLEANUP_RETRY_DELAY_MS = 30 * 1000;
const MAX_CLEANUP_ATTEMPTS = 3;
const DOCUMENT_ANALYSIS_FILE_TYPES = new Set<DocumentAnalysis['fileType']>([
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'ppt',
  'image',
  'unknown',
]);

function isMissingFileError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  private readonly byToken = new Map<string, string>();
  private readonly uploadDir: string;
  private readonly expiryEnabled: boolean;
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly cleanupInFlight = new Set<string>();
  private readonly cleanupAttempts = new Map<string, number>();

  constructor(uploadDir = 'uploads', options?: { expiryEnabled?: boolean }) {
    this.uploadDir = uploadDir;
    fs.mkdirSync(uploadDir, { recursive: true });
    this.expiryEnabled =
      options?.expiryEnabled ?? DEFAULT_SESSION_EXPIRY_ENABLED;
    this.restorePersistedSessions();
    if (this.expiryEnabled) {
      this.cleanupTimer = setInterval(
        () => this.cleanupExpired(),
        CLEANUP_INTERVAL_MS,
      );
    }
  }

  /** Check whether a session is still within its TTL window. */
  isSessionExpired(session: Session): boolean {
    if (!this.expiryEnabled) return false;
    return Date.now() - session.lastActivityAt.getTime() > SESSION_TTL_MS;
  }

  /** Check if a token maps to a valid, non-expired session. */
  isTokenValid(token: string): boolean {
    const sessionId = this.byToken.get(token);
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (this.isSessionExpired(session)) {
      void this.pruneExpiredSession(sessionId, session);
      return false;
    }
    return true;
  }

  getSessionState(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) return 'missing';
    if (this.isSessionExpired(session)) {
      void this.pruneExpiredSession(sessionId, session);
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
    const uploadUrl = buildUploadUrl(baseUrl, token);
    const publicUploadUrl = buildPublicUploadUrl(token);
    const now = new Date();

    const session: Session = {
      sessionId,
      token,
      uploadUrl,
      ...(publicUploadUrl ? { publicUploadUrl } : {}),
      status: 'pending',
      createdAt: now,
      lastActivityAt: now,
    };

    this.sessions.set(sessionId, session);
    this.byToken.set(token, sessionId);
    this.persistSessionSnapshot(session);
    return session;
  }

  tryGetSession(sessionId: string, publicBaseUrl: URL): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.isSessionExpired(session)) {
      void this.pruneExpiredSession(sessionId, session);
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
      void this.pruneExpiredSession(sessionId, session);
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

    const contentHash = await this.computeUploadContentHash(file);
    const existingContentHashes = await Promise.all(
      existingDocs.map((document) => this.resolveDocumentContentHash(document)),
    );
    if (existingContentHashes.includes(contentHash)) {
      if (file.path) await discardStagedUpload(file);
      return {
        isSuccess: false,
        errorMsg: 'This file is already in the current print session.',
        errorCode: 'DUPLICATE_FILE',
      };
    }

    const documentId = randomUUID();
    const safeName = `${documentId}${allowedExt}`;
    const destPath = path.join(this.uploadDir, safeName);

    if (file.path) {
      await promoteStagedUpload(file, destPath);
    } else if (file.buffer) {
      await fs.promises.writeFile(destPath, file.buffer);
    } else {
      throw new Error('Uploaded file is missing disk path and in-memory buffer.');
    }

    const document: UploadedDocument = {
      documentId,
      sessionId,
      filename: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
      uploadedAt: new Date(),
      filePath: destPath,
      contentHash,
      analysisStatus: 'pending',
      analysisError: null,
      analysisRequestedAt: new Date(),
    };

    const documents = session.documents
      ? [...session.documents]
      : session.document
        ? [session.document]
        : [];
    const previousStatus = session.status;
    const previousCurrentDocument = session.document;

    documents.push(document);
    session.documents = documents;
    session.status = 'uploaded';
    session.document = document;
    try {
      this.persistSessionSnapshot(session);
    } catch {
      session.documents = documents.slice(0, -1);
      session.status = previousStatus;
      if (previousCurrentDocument) {
        session.document = previousCurrentDocument;
      } else {
        delete session.document;
      }
      await fs.promises.unlink(destPath).catch((unlinkError) => {
        console.error(
          '[session-store] Failed to rollback uploaded file after persistence error.',
          {
            sessionId,
            filePath: destPath,
            error:
              unlinkError instanceof Error
                ? unlinkError.message
                : String(unlinkError),
          },
        );
      });
      return {
        isSuccess: false,
        errorMsg: 'Failed to persist uploaded document session state.',
        errorCode: 'SESSION_PERSIST_FAILED',
      };
    }

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
      void this.pruneExpiredSession(sessionId, session);
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
    target.analysisVersion = stamped.analysisVersion ?? 0;
    target.analysisStatus = 'completed';
    target.analysisError = null;
    if (!target.analysisRequestedAt) {
      target.analysisRequestedAt = new Date();
    }
    if (session.document?.documentId === documentId) {
      session.document.analysis = stamped;
      session.document.analysisVersion = stamped.analysisVersion ?? 0;
      session.document.analysisStatus = 'completed';
      session.document.analysisError = null;
      if (!session.document.analysisRequestedAt) {
        session.document.analysisRequestedAt = new Date();
      }
    }

    session.lastActivityAt = new Date();
    this.persistSessionSnapshot(session);
    return stamped;
  }

  setDocumentConvertedPdfPath(
    sessionId: string,
    documentId: string,
    convertedPdfPath: string,
  ): UploadedDocument | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.isSessionExpired(session)) {
      void this.pruneExpiredSession(sessionId, session);
      return null;
    }

    const docs =
      session.documents ?? (session.document ? [session.document] : []);
    const target = docs.find((doc) => doc.documentId === documentId);
    if (!target) return null;

    target.convertedPdfPath = convertedPdfPath;
    if (session.document?.documentId === documentId) {
      session.document.convertedPdfPath = convertedPdfPath;
    }
    session.lastActivityAt = new Date();
    this.persistSessionSnapshot(session);
    return target;
  }

  markDocumentAnalysisPending(
    sessionId: string,
    documentId: string,
  ): UploadedDocument | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.isSessionExpired(session)) {
      void this.pruneExpiredSession(sessionId, session);
      return null;
    }

    const docs =
      session.documents ?? (session.document ? [session.document] : []);
    const target = docs.find((doc) => doc.documentId === documentId);
    if (!target) return null;

    target.analysisStatus = 'pending';
    target.analysisError = null;
    target.analysisRequestedAt = new Date();
    if (session.document?.documentId === documentId) {
      session.document.analysisStatus = 'pending';
      session.document.analysisError = null;
      session.document.analysisRequestedAt = target.analysisRequestedAt;
    }
    session.lastActivityAt = new Date();
    this.persistSessionSnapshot(session);
    return target;
  }

  markDocumentAnalysisFailure(
    sessionId: string,
    documentId: string,
    reason: string,
  ): UploadedDocument | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.isSessionExpired(session)) {
      void this.pruneExpiredSession(sessionId, session);
      return null;
    }

    const docs =
      session.documents ?? (session.document ? [session.document] : []);
    const target = docs.find((doc) => doc.documentId === documentId);
    if (!target) return null;

    const trimmedReason = reason.trim();
    target.analysisStatus = 'failed';
    target.analysisError = trimmedReason || 'Document analysis failed.';
    target.analysisRequestedAt = target.analysisRequestedAt ?? new Date();
    if (session.document?.documentId === documentId) {
      session.document.analysisStatus = 'failed';
      session.document.analysisError = target.analysisError;
      session.document.analysisRequestedAt = target.analysisRequestedAt;
    }
    session.lastActivityAt = new Date();
    this.persistSessionSnapshot(session);
    return target;
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
      void this.pruneExpiredSession(sessionId, session);
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
    const previousStatus = session.status;
    const previousCurrentDocument = session.document;
    session.documents = docs;
    if (docs.length > 0) {
      session.document = docs[docs.length - 1];
      session.status = 'uploaded';
    } else {
      delete session.document;
      session.status = 'pending';
    }
    session.lastActivityAt = new Date();
    try {
      this.persistSessionSnapshot(session);
    } catch {
      session.documents = [...docs, removed];
      session.status = previousStatus;
      if (previousCurrentDocument) {
        session.document = previousCurrentDocument;
      } else {
        delete session.document;
      }
      return {
        success: false,
        errorCode: 'SESSION_PERSIST_FAILED',
        remainingCount: docs.length + 1,
        deletedFile: false,
      };
    }

    const filePaths = getDocumentOwnedFilePaths(removed);
    const deletionResults = await Promise.allSettled(
      filePaths.map((filePath) => fs.promises.unlink(filePath)),
    );
    const deletedFile = deletionResults.every(
      (result) =>
        result.status === 'fulfilled' ||
        (result.reason as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
    );

    return {
      success: true,
      removedDocumentId: removed.documentId,
      remainingCount: docs.length,
      deletedFile,
    };
  }

  private restorePersistedSessions(): void {
    let snapshots: {
      session: WirelessSessionStorageEntry;
      documents: WirelessSessionDocumentStorageEntry[];
    }[];
    try {
      snapshots = wirelessSessionStore.listSessionSnapshots();
    } catch (error) {
      console.error('[session-store] Failed to load persisted sessions.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const snapshot of snapshots) {
      const { session } = snapshot;
      try {
        const hydratedSession = this.fromStorageSnapshot(
          snapshot.session,
          snapshot.documents,
        );
        this.sessions.set(hydratedSession.sessionId, hydratedSession);
        this.byToken.set(hydratedSession.token, hydratedSession.sessionId);
        if (this.isSessionExpired(hydratedSession)) {
          void this.pruneExpiredSession(
            hydratedSession.sessionId,
            hydratedSession,
          );
        }
      } catch (error) {
        console.error(
          '[session-store] Dropping malformed persisted wireless session row.',
          {
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        try {
          wirelessSessionStore.deleteSession(session.sessionId);
        } catch (deleteError) {
          console.error(
            '[session-store] Failed to delete malformed persisted session.',
            {
              sessionId: session.sessionId,
              error:
                deleteError instanceof Error
                  ? deleteError.message
                  : String(deleteError),
            },
          );
        }
      }
    }
  }

  private fromStorageSnapshot(
    sessionEntry: WirelessSessionStorageEntry,
    documentEntries: WirelessSessionDocumentStorageEntry[],
  ): Session {
    const createdAt = this.parseRequiredDate(
      sessionEntry.createdAt,
      'createdAt',
      sessionEntry.sessionId,
    );
    const lastActivityAt = this.parseRequiredDate(
      sessionEntry.lastActivityAt,
      'lastActivityAt',
      sessionEntry.sessionId,
    );
    const uploadUrl = buildUploadUrl(
      new URL(`http://localhost:${PORT}`),
      sessionEntry.token,
    );
    const publicUploadUrl = buildPublicUploadUrl(sessionEntry.token);

    const documents = documentEntries.map((entry) =>
      this.fromStorageDocument(entry),
    );
    const status = documents.length > 0 ? 'uploaded' : 'pending';
    const latestDocument =
      documents.length > 0 ? documents[documents.length - 1] : undefined;

    const session: Session = {
      sessionId: sessionEntry.sessionId,
      token: sessionEntry.token,
      uploadUrl,
      ...(publicUploadUrl ? { publicUploadUrl } : {}),
      status,
      createdAt,
      lastActivityAt,
      ...(documents.length > 0 ? { documents } : {}),
      ...(latestDocument ? { document: latestDocument } : {}),
    };

    if (sessionEntry.ownerClientId) {
      session.ownerClientId = sessionEntry.ownerClientId;
    }
    if (sessionEntry.ownerClaimedAt) {
      session.ownerClaimedAt = this.parseRequiredDate(
        sessionEntry.ownerClaimedAt,
        'ownerClaimedAt',
        sessionEntry.sessionId,
      );
    }

    return session;
  }

  private fromStorageDocument(
    entry: WirelessSessionDocumentStorageEntry,
  ): UploadedDocument {
    const uploadedAt = this.parseRequiredDate(
      entry.uploadedAt,
      'uploadedAt',
      entry.sessionId,
    );

    const document: UploadedDocument = {
      documentId: entry.documentId,
      sessionId: entry.sessionId,
      filename: entry.filename,
      contentType: entry.contentType,
      sizeBytes: Math.max(0, Math.floor(entry.sizeBytes)),
      uploadedAt,
      filePath: entry.filePath,
      convertedPdfPath: entry.convertedPdfPath ?? undefined,
      contentHash: entry.contentHash ?? undefined,
      analysisStatus: entry.analysisStatus,
      analysisError: entry.analysisError,
      analysisVersion: entry.analysisVersion,
    };
    if (entry.analysisRequestedAt) {
      const parsedRequestedAt = new Date(entry.analysisRequestedAt);
      if (!Number.isNaN(parsedRequestedAt.getTime())) {
        document.analysisRequestedAt = parsedRequestedAt;
      }
    }
    if (entry.analysisJson) {
      document.analysis = this.parseDocumentAnalysis(
        entry.analysisJson,
        entry.sessionId,
        entry.documentId,
      );
      document.analysisStatus = 'completed';
      document.analysisError = null;
      document.analysisRequestedAt = document.analysisRequestedAt ?? uploadedAt;
    } else if (!document.analysisStatus) {
      document.analysisStatus = 'pending';
    }
    return document;
  }

  private parseRequiredDate(
    rawValue: string,
    fieldName: string,
    sessionId: string,
  ): Date {
    const parsed = new Date(rawValue);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `Invalid persisted ${fieldName} for session ${sessionId}: "${rawValue}"`,
      );
    }
    return parsed;
  }

  private parseDocumentAnalysis(
    analysisJson: string,
    sessionId: string,
    documentId: string,
  ): DocumentAnalysis {
    let parsed: unknown;
    try {
      parsed = JSON.parse(analysisJson) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid analysis JSON for ${sessionId}/${documentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(
        `Malformed analysis object for ${sessionId}/${documentId}`,
      );
    }
    const candidate = parsed as Record<string, unknown>;
    const analyzedAtRaw = candidate.analyzedAt;
    if (typeof analyzedAtRaw !== 'string') {
      throw new Error(
        `Missing analyzedAt string for persisted analysis ${sessionId}/${documentId}`,
      );
    }
    const analyzedAt = new Date(analyzedAtRaw);
    if (Number.isNaN(analyzedAt.getTime())) {
      throw new Error(
        `Invalid analyzedAt value for persisted analysis ${sessionId}/${documentId}`,
      );
    }

    if (
      typeof candidate.fileType !== 'string' ||
      typeof candidate.pageCount !== 'number' ||
      !Number.isFinite(candidate.pageCount) ||
      typeof candidate.colorPages !== 'number' ||
      !Number.isFinite(candidate.colorPages) ||
      typeof candidate.bwPages !== 'number' ||
      !Number.isFinite(candidate.bwPages) ||
      typeof candidate.totalPages !== 'number' ||
      !Number.isFinite(candidate.totalPages) ||
      !Array.isArray(candidate.pages)
    ) {
      throw new Error(
        `Malformed persisted analysis payload for ${sessionId}/${documentId}`,
      );
    }
    if (
      !DOCUMENT_ANALYSIS_FILE_TYPES.has(
        candidate.fileType as DocumentAnalysis['fileType'],
      )
    ) {
      throw new Error(
        `Invalid fileType in persisted analysis for ${sessionId}/${documentId}`,
      );
    }

    const pages = candidate.pages.map((page, index) => {
      if (typeof page !== 'object' || page === null) {
        throw new Error(
          `Malformed page analysis at index ${index} for ${sessionId}/${documentId}`,
        );
      }
      const pageCandidate = page as Record<string, unknown>;
      if (
        typeof pageCandidate.index !== 'number' ||
        !Number.isFinite(pageCandidate.index) ||
        typeof pageCandidate.isColor !== 'boolean'
      ) {
        throw new Error(
          `Malformed page analysis fields at index ${index} for ${sessionId}/${documentId}`,
        );
      }
      const fallbackReasonFlags = pageCandidate.fallbackReasonFlags;
      if (
        fallbackReasonFlags !== undefined &&
        (!Array.isArray(fallbackReasonFlags) ||
          fallbackReasonFlags.some((flag) => typeof flag !== 'string'))
      ) {
        throw new Error(
          `Malformed fallback reason flags at index ${index} for ${sessionId}/${documentId}`,
        );
      }
      const coverage =
        typeof pageCandidate.coverage === 'number' &&
        Number.isFinite(pageCandidate.coverage)
          ? Math.max(0, Math.min(1, pageCandidate.coverage))
          : 0;
      const colorCoverage =
        typeof pageCandidate.colorCoverage === 'number' &&
        Number.isFinite(pageCandidate.colorCoverage)
          ? Math.max(0, Math.min(1, pageCandidate.colorCoverage))
          : 0;
      const contentCoverage =
        typeof pageCandidate.contentCoverage === 'number' &&
        Number.isFinite(pageCandidate.contentCoverage)
          ? Math.max(0, Math.min(1, pageCandidate.contentCoverage))
          : coverage;
      const isBlank =
        typeof pageCandidate.isBlank === 'boolean'
          ? pageCandidate.isBlank
          : (contentCoverage ?? coverage) < 0.001;
      const isColor = pageCandidate.isColor === true;
      const coverageTier: CoverageTier =
        pageCandidate.coverageTier === 'low' ||
        pageCandidate.coverageTier === 'medium' ||
        pageCandidate.coverageTier === 'high' ||
        pageCandidate.coverageTier === 'very_high'
          ? pageCandidate.coverageTier
          : resolveCoverageTier(contentCoverage ?? coverage);
      const classification:
        | 'blank'
        | 'bw'
        | 'color'
        | 'partial'
        | 'full_color'
        | 'image' =
        pageCandidate.classification === 'blank' ||
        pageCandidate.classification === 'bw' ||
        pageCandidate.classification === 'color' ||
        pageCandidate.classification === 'partial' ||
        pageCandidate.classification === 'full_color' ||
        pageCandidate.classification === 'image'
          ? pageCandidate.classification
          : isBlank
            ? 'blank'
            : isColor
              ? 'color'
              : 'bw';
      const isImagePage =
        typeof pageCandidate.isImagePage === 'boolean'
          ? pageCandidate.isImagePage
          : undefined;
      return {
        index: Math.floor(pageCandidate.index),
        isColor,
        coverage,
        colorCoverage,
        coverageTier,
        classification,
        isBlank,
        ...(contentCoverage !== undefined ? { contentCoverage } : {}),
        ...(isImagePage !== undefined ? { isImagePage } : {}),
        ...(fallbackReasonFlags
          ? { fallbackReasonFlags: fallbackReasonFlags as string[] }
          : {}),
      };
    });

    const confidenceRaw = candidate.confidence;
    const confidence =
      confidenceRaw === 'high' ||
      confidenceRaw === 'medium' ||
      confidenceRaw === 'low'
        ? confidenceRaw
        : 'low';

    const analysisVersion =
      typeof candidate.analysisVersion === 'number' &&
      Number.isFinite(candidate.analysisVersion)
        ? Math.max(0, Math.floor(candidate.analysisVersion))
        : 0;

    return {
      fileType: candidate.fileType as DocumentAnalysis['fileType'],
      pageCount: Math.floor(candidate.pageCount),
      pages,
      colorPages: Math.floor(candidate.colorPages),
      bwPages: Math.floor(candidate.bwPages),
      totalPages: Math.floor(candidate.totalPages),
      confidence,
      analyzedAt,
      analysisVersion,
    };
  }

  private serializeDocumentAnalysis(analysis: DocumentAnalysis): string {
    return JSON.stringify({
      ...analysis,
      analyzedAt: analysis.analyzedAt.toISOString(),
    });
  }

  private async computeUploadContentHash(
    file: Express.Multer.File,
  ): Promise<string> {
    const content = file.buffer ?? (file.path ? await fs.promises.readFile(file.path) : null);
    if (!content) {
      throw new Error('Uploaded file is missing disk path and in-memory buffer.');
    }
    return createHash('sha256').update(content).digest('hex');
  }

  private async resolveDocumentContentHash(
    document: UploadedDocument,
  ): Promise<string | null> {
    if (document.contentHash) return document.contentHash;
    try {
      return createHash('sha256')
        .update(await fs.promises.readFile(document.filePath))
        .digest('hex');
    } catch {
      return null;
    }
  }

  private toStorageSession(session: Session): WirelessSessionStorageEntry {
    return {
      sessionId: session.sessionId,
      token: session.token,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      ownerClientId: session.ownerClientId ?? null,
      ownerClaimedAt: session.ownerClaimedAt?.toISOString() ?? null,
    };
  }

  private toStorageDocument(
    document: UploadedDocument,
  ): WirelessSessionDocumentStorageEntry {
    return {
      documentId: document.documentId,
      sessionId: document.sessionId,
      filename: document.filename,
      contentType: document.contentType,
      sizeBytes: document.sizeBytes,
      uploadedAt: document.uploadedAt.toISOString(),
      filePath: document.filePath,
      convertedPdfPath: document.convertedPdfPath ?? null,
      contentHash: document.contentHash ?? null,
      analysisJson: document.analysis
        ? this.serializeDocumentAnalysis(document.analysis)
        : null,
      analysisStatus:
        document.analysisStatus === 'completed'
          ? 'completed'
          : document.analysisStatus === 'failed'
            ? 'failed'
            : 'pending',
      analysisError:
        typeof document.analysisError === 'string' &&
        document.analysisError.trim()
          ? document.analysisError.trim()
          : null,
      analysisRequestedAt: document.analysisRequestedAt?.toISOString() ?? null,
      analysisVersion:
        typeof document.analysisVersion === 'number' &&
        Number.isFinite(document.analysisVersion)
          ? Math.max(0, Math.floor(document.analysisVersion))
          : typeof document.analysis?.analysisVersion === 'number' &&
              Number.isFinite(document.analysis.analysisVersion)
            ? Math.max(0, Math.floor(document.analysis.analysisVersion))
            : 0,
    };
  }

  private persistSessionSnapshot(session: Session): void {
    const documents =
      session.documents ?? (session.document ? [session.document] : []);

    try {
      wirelessSessionStore.saveSessionSnapshot({
        session: this.toStorageSession(session),
        documents: documents.map((document) =>
          this.toStorageDocument(document),
        ),
      });
    } catch (error) {
      const sqliteError = error as { code?: unknown; errno?: unknown };
      console.error(
        '[session-store] Failed to persist session snapshot (wireless_session_documents insert/upsert).',
        {
          sessionId: session.sessionId,
          token: session.token,
          status: session.status,
          documentCount: documents.length,
          error: error instanceof Error ? error.message : String(error),
          code:
            typeof sqliteError.code === 'string'
              ? sqliteError.code
              : (sqliteError.code ?? null),
          errno:
            typeof sqliteError.errno === 'number'
              ? sqliteError.errno
              : (sqliteError.errno ?? null),
        },
      );
      throw error;
    }
  }

  private withFreshUrl(session: Session, publicBaseUrl: URL): Session {
    const freshUrl = buildUploadUrl(publicBaseUrl, session.token);
    const freshPublicUrl = buildPublicUploadUrl(session.token);
    const ttlMetadata = this.expiryEnabled
      ? {
          expiresAt: new Date(this.getExpiryTimestamp(session)),
          remainingSeconds: this.getRemainingSeconds(session),
          ttlSeconds: Math.floor(SESSION_TTL_MS / 1000),
          warningThresholdSeconds: SESSION_WARNING_SECONDS,
        }
      : {};
    return {
      ...session,
      uploadUrl: freshUrl,
      ...(freshPublicUrl ? { publicUploadUrl: freshPublicUrl } : {}),
      ...ttlMetadata,
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
      void this.pruneExpiredSession(sessionId, session);
      return false;
    }
    session.lastActivityAt = new Date();
    try {
      wirelessSessionStore.touchSession(
        sessionId,
        session.lastActivityAt.toISOString(),
      );
    } catch (error) {
      console.error('[session-store] Failed to persist session touch.', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
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
      void this.pruneExpiredSession(sessionId, session);
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
        errorCode: 'INVALID_CLIENT_ID',
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
    this.persistSessionSnapshot(session);
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
  async cancelSession(sessionId: string): Promise<{
    success: boolean;
    deletedFileCount: number;
    errorCode?: 'SESSION_NOT_FOUND' | 'SESSION_PERSIST_FAILED';
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        success: false,
        deletedFileCount: 0,
        errorCode: 'SESSION_NOT_FOUND',
      };
    }

    const docs =
      session.documents ?? (session.document ? [session.document] : []);
    try {
      wirelessSessionStore.deleteSession(sessionId);
    } catch (error) {
      console.error('[session-store] Failed to persist session cancel.', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        deletedFileCount: 0,
        errorCode: 'SESSION_PERSIST_FAILED',
      };
    }

    // Remove session from in-memory maps after persistence succeeds.
    this.byToken.delete(session.token);
    this.sessions.delete(sessionId);

    // Delete uploaded files asynchronously to avoid blocking the event loop.
    const filePaths = [...new Set(docs.flatMap(getDocumentOwnedFilePaths))];
    const deletionResults = await Promise.allSettled(
      filePaths.map((filePath) => fs.promises.unlink(filePath)),
    );

    // Count successful deletions
    const deletedCount = deletionResults.filter(
      (result) => result.status === 'fulfilled',
    ).length;

    return { success: true, deletedFileCount: deletedCount };
  }

  /** Remove expired sessions and their uploaded files from disk. */
  private cleanupExpired(): void {
    if (!this.expiryEnabled) return;
    for (const [id, session] of this.sessions.entries()) {
      if (this.isSessionExpired(session)) {
        void this.pruneExpiredSession(id, session);
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

  private async pruneExpiredSession(
    sessionId: string,
    session: Session,
  ): Promise<void> {
    if (this.cleanupInFlight.has(sessionId)) return;
    this.cleanupInFlight.add(sessionId);

    const docs =
      session.documents ?? (session.document ? [session.document] : []);
    const filePaths = [...new Set(docs.flatMap(getDocumentOwnedFilePaths))];
    const deletionResults = await Promise.allSettled(
      filePaths.map((filePath) => fs.promises.unlink(filePath)),
    );
    const failedDeletes: {
      filePath: string | undefined;
      reason: unknown;
    }[] = [];
    deletionResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        if (isMissingFileError(result.reason)) {
          return;
        }

        failedDeletes.push({
          filePath: filePaths[index],
          reason: result.reason,
        });
      }
    });

    if (failedDeletes.length === 0) {
      try {
        wirelessSessionStore.deleteSession(sessionId);
        this.byToken.delete(session.token);
        this.sessions.delete(sessionId);
        this.cleanupAttempts.delete(sessionId);
        this.cleanupInFlight.delete(sessionId);
        return;
      } catch (error) {
        console.error(
          '[session-cleanup] Failed to persist expired-session deletion.',
          {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    for (const failed of failedDeletes) {
      const message =
        failed.reason instanceof Error
          ? failed.reason.message
          : String(failed.reason);
      console.error('[session-cleanup] Failed to delete expired upload file.', {
        sessionId,
        filePath: failed.filePath ?? 'unknown',
        error: message,
      });
    }

    const attempt = (this.cleanupAttempts.get(sessionId) ?? 0) + 1;
    this.cleanupAttempts.set(sessionId, attempt);
    this.cleanupInFlight.delete(sessionId);

    if (attempt >= MAX_CLEANUP_ATTEMPTS) {
      console.error(
        '[session-cleanup] Reached max retry attempts for expired session cleanup.',
        { sessionId, attempts: attempt },
      );
      return;
    }

    const retryDelayMs = CLEANUP_RETRY_DELAY_MS * attempt;
    const timerId = setTimeout(() => {
      this.retryTimers.delete(timerId);
      const latest = this.sessions.get(sessionId);
      if (!latest) return;
      if (!this.isSessionExpired(latest)) {
        this.cleanupAttempts.delete(sessionId);
        return;
      }
      void this.pruneExpiredSession(sessionId, latest);
    }, retryDelayMs);
    this.retryTimers.add(timerId);
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
  const protocol = req.protocol;
  const hostHeader = req.get('host') ?? '';
  const requestHost = hostHeader.split(':')[0];

  // Local kiosk IP should be preferred for QR/upload links in print flow.
  const preferredLocalHost = detectPreferredLocalKioskAddress(requestHost);
  if (preferredLocalHost) {
    return new URL(`http://${preferredLocalHost}:${PORT}`);
  }

  if (hostHeader && !isLoopbackHost(requestHost)) {
    return new URL(`${protocol}://${hostHeader}`);
  }

  if (PUBLIC_URL) return new URL(PUBLIC_URL);

  const host = hostHeader || 'localhost';
  return new URL(`${protocol}://${host}`);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '' ||
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

function isPrivateIpv4(host: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function detectPreferredLocalKioskAddress(requestHost: string): string | null {
  if (NETWORK_PROVIDER === 'esp32') {
    const esp32SubnetPrefix = deriveEsp32SubnetPrefix();
    if (ESP32_KIOSK_IP && requestHost === ESP32_KIOSK_IP) return requestHost;
    if (requestHost.startsWith(ESP32_KIOSK_SUBNET_PREFIX)) return requestHost;
    if (esp32SubnetPrefix && requestHost.startsWith(esp32SubnetPrefix)) {
      return requestHost;
    }
    const detectedEsp32 = detectEsp32KioskAddress();
    if (detectedEsp32) return detectedEsp32;
  }

  if (isPrivateIpv4(requestHost)) return requestHost;

  return detectHotspotAddress();
}

function detectHotspotAddress(): string | null {
  return getLocalIPv4();
}

function buildUploadUrl(baseUrl: URL, token: string): string {
  return new URL(`/upload/${encodeURIComponent(token)}`, baseUrl).toString();
}

function buildPublicUploadUrl(token: string): string | undefined {
  if (!PUBLIC_URL) return undefined;
  return buildUploadUrl(new URL(PUBLIC_URL), token);
}

function detectEsp32KioskAddress(): string | null {
  return detectEsp32KioskIp();
}

function deriveEsp32SubnetPrefix(): string | null {
  try {
    const hostname = new URL(ESP32_AP_BASE_URL).hostname.trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
    const octets = hostname.split('.').map(Number);
    if (
      octets.length !== 4 ||
      octets.some(
        (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
      )
    ) {
      return null;
    }
    return `${octets[0]}.${octets[1]}.${octets[2]}.`;
  } catch {
    return null;
  }
}
