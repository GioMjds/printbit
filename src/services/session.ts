import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { Request } from "express";

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
  status: "pending" | "uploaded";
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
  ["application/pdf", ".pdf"],
  ["application/msword", ".doc"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docx",
  ],
  ["application/vnd.ms-excel", ".xls"],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsx",
  ],
  ["application/vnd.ms-powerpoint", ".ppt"],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pptx",
  ],
]);

const MAX_BYTES = 25 * 1024 * 1024; // 25MB

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  private readonly byToken = new Map<string, string>();
  private readonly uploadDir: string;

  constructor(uploadDir = "uploads") {
    this.uploadDir = uploadDir;
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  createSession(baseUrl: URL): Session {
    const sessionId = randomUUID();
    const token = randomUUID();
    const uploadUrl = new URL(`/upload/${token}`, baseUrl).toString();

    const session: Session = {
      sessionId,
      token,
      uploadUrl,
      status: "pending",
      createdAt: new Date(),
    };

    this.sessions.set(sessionId, session);
    this.byToken.set(token, sessionId);
    return session;
  }

  tryGetSession(sessionId: string, publicBaseUrl: URL): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
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
        errorMsg: "Session not found",
        errorCode: "SESSION_NOT_FOUND",
      };
    }

    if (session.token !== token) {
      return {
        isSuccess: false,
        errorMsg: "Invalid token for session",
        errorCode: "INVALID_TOKEN",
      };
    }

    if (file.size > MAX_BYTES) {
      return {
        isSuccess: false,
        errorMsg: `File size exceeds limit of ${MAX_BYTES} bytes`,
        errorCode: "FILE_TOO_LARGE",
      };
    }

    const allowedExt = ALLOWED_TYPES.get(file.mimetype);
    if (!allowedExt) {
      return {
        isSuccess: false,
        errorMsg: `Unsupported file type: ${file.mimetype}. Use PDF, Word, Excel, or PowerPoint documents.`,
        errorCode: "UNSUPPORTED_TYPE",
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
    session.status = "uploaded";
    session.document = documents[0];

    return { isSuccess: true, document, errorCode: "", errorMsg: "" };
  }

  private withFreshUrl(session: Session, publicBaseUrl: URL): Session {
    const freshUrl = new URL(`/upload/${encodeURIComponent(session.token)}`, publicBaseUrl).toString();
    return { ...session, uploadUrl: freshUrl };
  }
}

export function renderUploadPortal(token: string, portalHtmlPath: string) {
  if (!fs.existsSync(portalHtmlPath)) {
    throw new Error(`Upload portal HTML not found at: ${portalHtmlPath}`);
  }

  let template = fs.readFileSync(portalHtmlPath, "utf-8");

  // Inject <base href> so relative asset URLs resolve under /upload/{token}/
  const safeToken = encodeURIComponent(token);
  const assetBase = `/upload/${safeToken}/`;
  template = template.replace(
    "<head>",
    `<head>\n  <base href="${assetBase}">`,
  );

  // Inject token into the placeholder used by app.ts
  template = template.replace("{{token}}", token.replace(/"/g, "&quot;"));

  return template;
}

export function resolvePublicBaseUrl(req: Request): URL {
  const protocol = req.protocol;
  const host = req.get("host") ?? "localhost";

  return new URL(`${protocol}://${host}`);
}
