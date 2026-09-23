import { getSqliteDb, withTransaction } from '../sqlite-storage';

export interface WirelessSessionStorageEntry {
  sessionId: string;
  token: string;
  status: 'pending' | 'uploaded';
  createdAt: string;
  lastActivityAt: string;
  ownerClientId: string | null;
  ownerClaimedAt: string | null;
}

export interface WirelessSessionDocumentStorageEntry {
  documentId: string;
  sessionId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  filePath: string;
  convertedPdfPath: string | null;
  contentHash: string | null;
  analysisJson: string | null;
  analysisStatus: 'pending' | 'completed' | 'failed';
  analysisError: string | null;
  analysisRequestedAt: string | null;
  analysisVersion: number;
}

export interface WirelessSessionSnapshotStorageEntry {
  session: WirelessSessionStorageEntry;
  documents: WirelessSessionDocumentStorageEntry[];
}

export class WirelessSessionSqliteStore {
  listSessionSnapshots(): WirelessSessionSnapshotStorageEntry[] {
    const db = getSqliteDb();
    const sessionRows = db
      .prepare(
        `SELECT
        session_id,
        token,
        status,
        created_at,
        last_activity_at,
        owner_client_id,
        owner_claimed_at
       FROM wireless_sessions
       ORDER BY created_at DESC`,
      )
      .all() as Record<string, unknown>[];

    if (sessionRows.length === 0) return [];

    const documentRows = db
      .prepare(
        `SELECT
        document_id,
        session_id,
        filename,
        content_type,
        size_bytes,
        uploaded_at,
        file_path,
        converted_pdf_path,
        content_hash,
        analysis_json,
        analysis_status,
        analysis_error,
        analysis_requested_at,
        analysis_version
       FROM wireless_session_documents
       ORDER BY uploaded_at ASC`,
      )
      .all() as Record<string, unknown>[];

    const documentsBySessionId = new Map<
      string,
      WirelessSessionDocumentStorageEntry[]
    >();
    for (const row of documentRows) {
      const parsed = this.toDocumentEntry(row);
      const bucket = documentsBySessionId.get(parsed.sessionId);
      if (bucket) {
        bucket.push(parsed);
      } else {
        documentsBySessionId.set(parsed.sessionId, [parsed]);
      }
    }

    return sessionRows.map((row) => {
      const parsedSession = this.toSessionEntry(row);
      return {
        session: parsedSession,
        documents: documentsBySessionId.get(parsedSession.sessionId) ?? [],
      };
    });
  }

  saveSessionSnapshot(snapshot: WirelessSessionSnapshotStorageEntry): void {
    try {
      withTransaction(() => {
        const db = getSqliteDb();
        this.upsertSession(snapshot.session);
        db.prepare(
          `DELETE FROM wireless_session_documents
           WHERE session_id = ?`,
        ).run(snapshot.session.sessionId);

        if (snapshot.documents.length === 0) return;
        const insertDocument = db.prepare(
          `INSERT INTO wireless_session_documents (
          document_id,
          session_id,
          filename,
          content_type,
          size_bytes,
          uploaded_at,
          file_path,
          converted_pdf_path,
          content_hash,
          analysis_json,
          analysis_status,
          analysis_error,
          analysis_requested_at,
          analysis_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const doc of snapshot.documents) {
          insertDocument.run(
            doc.documentId,
            doc.sessionId,
            doc.filename,
            doc.contentType,
            Math.max(0, Math.floor(doc.sizeBytes)),
            doc.uploadedAt,
            doc.filePath,
            doc.convertedPdfPath,
            doc.contentHash,
            doc.analysisJson,
            doc.analysisStatus,
            doc.analysisError,
            doc.analysisRequestedAt,
            doc.analysisVersion,
          );
        }
      });
    } catch (error) {
      const sqliteError = error as { code?: unknown; errno?: unknown };
      console.error(
        '[SQLITE] Failed to save wireless session document snapshot.',
        {
          sessionId: snapshot.session.sessionId,
          documentCount: snapshot.documents.length,
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

  upsertSession(entry: WirelessSessionStorageEntry): void {
    getSqliteDb()
      .prepare(
        `INSERT INTO wireless_sessions (
          session_id,
          token,
          status,
          created_at,
          last_activity_at,
          owner_client_id,
          owner_claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          token = excluded.token,
          status = excluded.status,
          created_at = excluded.created_at,
          last_activity_at = excluded.last_activity_at,
          owner_client_id = excluded.owner_client_id,
          owner_claimed_at = excluded.owner_claimed_at`,
      )
      .run(
        entry.sessionId,
        entry.token,
        entry.status,
        entry.createdAt,
        entry.lastActivityAt,
        entry.ownerClientId,
        entry.ownerClaimedAt,
      );
  }

  touchSession(sessionId: string, lastActivityAt: string): void {
    getSqliteDb()
      .prepare(
        `UPDATE wireless_sessions
         SET last_activity_at = ?
         WHERE session_id = ?`,
      )
      .run(lastActivityAt, sessionId);
  }

  deleteSession(sessionId: string): void {
    withTransaction(() => {
      const db = getSqliteDb();
      db.prepare(
        `DELETE FROM wireless_session_documents
         WHERE session_id = ?`,
      ).run(sessionId);
      db.prepare(
        `DELETE FROM wireless_sessions
         WHERE session_id = ?`,
      ).run(sessionId);
    });
  }

  private toSessionEntry(
    row: Record<string, unknown>,
  ): WirelessSessionStorageEntry {
    const status = row.status === 'uploaded' ? 'uploaded' : 'pending';
    return {
      sessionId: String(row.session_id ?? ''),
      token: String(row.token ?? ''),
      status,
      createdAt: String(row.created_at ?? ''),
      lastActivityAt: String(row.last_activity_at ?? ''),
      ownerClientId:
        typeof row.owner_client_id === 'string' ? row.owner_client_id : null,
      ownerClaimedAt:
        typeof row.owner_claimed_at === 'string' ? row.owner_claimed_at : null,
    };
  }

  private toDocumentEntry(
    row: Record<string, unknown>,
  ): WirelessSessionDocumentStorageEntry {
    return {
      documentId: String(row.document_id ?? ''),
      sessionId: String(row.session_id ?? ''),
      filename: String(row.filename ?? ''),
      contentType: String(row.content_type ?? ''),
      sizeBytes:
        typeof row.size_bytes === 'number' && Number.isFinite(row.size_bytes)
          ? Math.max(0, Math.floor(row.size_bytes))
          : 0,
      uploadedAt: String(row.uploaded_at ?? ''),
      filePath: String(row.file_path ?? ''),
      convertedPdfPath:
        typeof row.converted_pdf_path === 'string'
          ? row.converted_pdf_path
          : null,
      contentHash:
        typeof row.content_hash === 'string' ? row.content_hash : null,
      analysisJson:
        typeof row.analysis_json === 'string' ? row.analysis_json : null,
      analysisStatus:
        row.analysis_status === 'failed'
          ? 'failed'
          : row.analysis_status === 'completed'
            ? 'completed'
            : 'pending',
      analysisError:
        typeof row.analysis_error === 'string' ? row.analysis_error : null,
      analysisRequestedAt:
        typeof row.analysis_requested_at === 'string'
          ? row.analysis_requested_at
          : null,
      analysisVersion:
        typeof row.analysis_version === 'number' &&
        Number.isFinite(row.analysis_version)
          ? Math.max(0, Math.floor(row.analysis_version))
          : 0,
    };
  }
}

export const wirelessSessionStore = new WirelessSessionSqliteStore();
