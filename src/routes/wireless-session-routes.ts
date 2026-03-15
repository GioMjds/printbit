import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type { Server } from 'socket.io';
import { adminService } from '../services/admin';
import type { SessionStore } from '../services/session';
import { generateHtmlPreview, supportsHtmlPreview } from '../services/preview';
import { detectPdfColorContent } from '@/services/config';
import { analyzeDocument } from '@/services/document-analysis';
import {
  uploadMiddleware,
  handleMulterError,
  validateMagicBytes,
  scanForMalware,
} from '@/middleware/file-validation';

interface RegisterWirelessSessionRoutesDeps {
  io: Server;
  sessionStore: SessionStore;
  resolvePublicBaseUrl: (req: Request) => URL;
  convertToPdfPreview: (sourcePath: string) => Promise<string>;
}

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

// Only PPT/PPTX still go through LibreOffice; doc/docx use Word COM → PDF
const PDF_CONVERT_EXTENSIONS = new Set(['.doc', '.docx', '.ppt', '.pptx']);
const POWERPOINT_EXTENSIONS = new Set(['.ppt', '.pptx']);

export function registerWirelessSessionRoutes(
  app: Express,
  deps: RegisterWirelessSessionRoutesDeps,
) {
  const extractUploadToken = (req: Request): string => {
    const queryToken = req.query.token;
    if (typeof queryToken === 'string' && queryToken.trim().length > 0) {
      return queryToken;
    }

    const headerToken =
      req.header('x-session-token') ?? req.header('x-upload-token');
    if (headerToken && headerToken.trim().length > 0) {
      return headerToken;
    }

    const authorizationHeader = req.header('authorization');
    if (!authorizationHeader) return '';

    const bearerMatch = authorizationHeader.match(/^Bearer\s+(.+)$/i);
    return bearerMatch?.[1]?.trim() ?? '';
  };

  const verifyUploadTarget = (
    req: Request,
    res: Response,
    next: () => void,
  ) => {
    const { sessionId } = req.params as { sessionId?: string };
    const token = extractUploadToken(req);

    if (!sessionId || !token) {
      return res.status(401).json({ error: 'Missing session or token.' });
    }

    const publicBaseUrl = deps.resolvePublicBaseUrl(req);
    const session = deps.sessionStore.tryGetSession(sessionId, publicBaseUrl);

    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    if (session.token !== token) {
      return res.status(403).json({ error: 'Invalid token for session.' });
    }

    next();
  };

  const analyzeAndStoreDocument = async (
    req: Request,
    sessionId: string,
    documentId?: string,
  ) => {
    const publicBaseUrl = deps.resolvePublicBaseUrl(req);
    const session = deps.sessionStore.tryGetSession(sessionId, publicBaseUrl);
    if (!session) {
      return { error: 'Session not found.', status: 404 as const };
    }

    const docs =
      session.documents && session.documents.length > 0
        ? session.documents
        : session.document
          ? [session.document]
          : [];

    const fallbackDocumentId = session.document?.documentId;
    const targetDocumentId = documentId ?? fallbackDocumentId;
    const target = targetDocumentId
      ? docs.find((doc) => doc.documentId === targetDocumentId) ?? null
      : (docs[docs.length - 1] ?? null);

    if (!target) {
      return { error: 'Document not found.', status: 404 as const };
    }

    const targetExtension = path.extname(target.filename).toLowerCase();
    let analysisFilePath = target.filePath;
    let analysisContentType = target.contentType;
    let analysisFilename = target.filename;

    if (
      PDF_CONVERT_EXTENSIONS.has(targetExtension) &&
      POWERPOINT_EXTENSIONS.has(targetExtension)
    ) {
      try {
        analysisFilePath = await deps.convertToPdfPreview(
          path.resolve(target.filePath),
        );
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'Unknown conversion error';
        return {
          error: `PowerPoint conversion failed before analysis: ${reason}`,
          status: 422 as const,
        };
      }

      analysisContentType = 'application/pdf';
      analysisFilename = `${path.basename(target.filename, targetExtension)}.pdf`;
    }

    const analysis = await analyzeDocument({
      filePath: analysisFilePath,
      contentType: analysisContentType,
      filename: analysisFilename,
      convertToPdfPreview: deps.convertToPdfPreview,
    });

    const persisted = deps.sessionStore.setDocumentAnalysis(
      sessionId,
      target.documentId,
      analysis,
    );

    if (!persisted) {
      return {
        error: 'Failed to persist document analysis.',
        status: 500 as const,
      };
    }

    return {
      status: 200 as const,
      analysis: persisted,
      documentId: target.documentId,
      fileName: target.filename,
    };
  };

  app.get('/api/wireless/sessions', (req: Request, res: Response) => {
    const publicBaseUrl = deps.resolvePublicBaseUrl(req);
    const session = deps.sessionStore.createSession(publicBaseUrl);
    void adminService.appendAdminLog(
      'session_created',
      'Wireless upload session created.',
      {
        sessionId: session.sessionId,
      },
    );
    res.status(201).json(session);
  });

  // Specific sub-routes must be registered before "/:sessionId".
  app.get(
    '/api/wireless/sessions/by-token/:token',
    (req: Request, res: Response) => {
      const publicBaseUrl = deps.resolvePublicBaseUrl(req);
      const session = deps.sessionStore.tryGetSessionByToken(
        req.params.token as string,
        publicBaseUrl,
      );

      if (!session) {
        return res.status(404).json({ error: 'Session not found.' });
      }

      res.json(session);
    },
  );

  app.get(
    '/api/wireless/sessions/:sessionId/preview',
    async (req: Request, res: Response) => {
      const publicBaseUrl = deps.resolvePublicBaseUrl(req);
      const session = deps.sessionStore.tryGetSession(
        req.params.sessionId as string,
        publicBaseUrl,
      );

      const requestedFilename = req.query.filename as string;

      const allDocs =
        session?.documents && session.documents.length > 0
          ? session.documents
          : session?.document
            ? [session.document]
            : [];

      const target = requestedFilename
        ? allDocs.find((doc) => doc.filename === requestedFilename)
        : (session?.document ?? allDocs[0]);

      if (!target) {
        return requestedFilename
          ? res.status(404).json({ error: 'Document not found.' })
          : res
              .status(404)
              .json({ error: 'No documents available for preview.' });
      }

      const absolutePath = path.resolve(target.filePath);
      const extension = path.extname(absolutePath).toLowerCase();

      try {
        if (extension === '.pdf') {
          res.setHeader('Content-Type', 'application/pdf');
          return res.sendFile(absolutePath);
        }

        if (IMAGE_TYPES[extension]) {
          res.setHeader('Content-Type', IMAGE_TYPES[extension]);
          return res.sendFile(absolutePath);
        }

        if (supportsHtmlPreview(extension)) {
          const html = await generateHtmlPreview(absolutePath);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(html);
        }

        if (PDF_CONVERT_EXTENSIONS.has(extension)) {
          const pdfPreviewPath = await deps.convertToPdfPreview(absolutePath);
          res.setHeader('Content-Type', 'application/pdf');
          return res.sendFile(pdfPreviewPath);
        }

        return res.status(400).json({
          error: `Preview not supported for ${extension}.`,
          code: 'UNSUPPORTED_PREVIEW',
        });
      } catch (error) {
        console.error('Preview error:', error);
        const reason =
          error instanceof Error ? error.message : 'Unknown preview error';
        return res.status(500).json({
          error:
            'Preview conversion failed. Ensure Microsoft Word or LibreOffice is installed and available.',
          reason,
          code: 'PREVIEW_CONVERSION_FAILED',
        });
      }
    },
  );

  app.get(
    '/api/wireless/sessions/:sessionId/color-analysis',
    async (req: Request, res: Response) => {
      const publicBaseUrl = deps.resolvePublicBaseUrl(req);
      const session = deps.sessionStore.tryGetSession(
        req.params.sessionId as string,
        publicBaseUrl,
      );

      if (!session)
        return res.status(404).json({ error: 'Session not found.' });

      const requestedFilename = req.query.filename as string | undefined;
      const allDocs =
        session.documents && session.documents.length > 0
          ? session.documents
          : session.document
            ? [session.document]
            : [];

      const target = requestedFilename
        ? allDocs.find((doc) => doc.filename === requestedFilename)
        : (session.document ?? allDocs[0]);

      if (!target) {
        // No document — default to allowing color (non-fatal)
        return res.json({
          hasColor: true,
          isGrayscale: false,
          sampledPages: 0,
        });
      }

      const absolutePath = path.resolve(target.filePath);
      const extension = path.extname(absolutePath).toLowerCase();

      try {
        let pdfPath: string;

        if (extension === '.pdf') {
          pdfPath = absolutePath;
        } else if (['.doc', '.docx', '.ppt', '.pptx'].includes(extension)) {
          // Re-use the already-cached preview PDF — no double conversion
          pdfPath = await deps.convertToPdfPreview(absolutePath);
        } else {
          // Images and other types — skip detection, allow color selection
          return res.json({
            hasColor: true,
            isGrayscale: false,
            sampledPages: 0,
          });
        }

        const result = await detectPdfColorContent(pdfPath);
        return res.json({
          hasColor: result.hasColor,
          isGrayscale: result.isGrayscale,
          sampledPages: result.sampledPages,
        });
      } catch (err) {
        // Detection is non-fatal — if it fails, default to allowing color
        console.warn(
          '[color-analysis] Detection failed, defaulting to color:',
          err,
        );
        return res.json({
          hasColor: true,
          isGrayscale: false,
          sampledPages: 0,
        });
      }
    },
  );

  app.get(
    '/api/wireless/sessions/:sessionId',
    (req: Request, res: Response) => {
      const publicBaseUrl = deps.resolvePublicBaseUrl(req);
      const session = deps.sessionStore.tryGetSession(
        req.params.sessionId as string,
        publicBaseUrl,
      );

      if (!session) {
        return res.status(404).json({ error: 'Session not found.' });
      }

      res.json(session);
    },
  );

  app.post(
    '/api/wireless/sessions/:sessionId/upload',
    verifyUploadTarget,
    uploadMiddleware.single('file'),
    validateMagicBytes,
    scanForMalware,
    async (req: Request, res: Response) => {
      const { sessionId } = req.params as { sessionId: string };
      const token = extractUploadToken(req);
      const file = req.file;

      if (!file) {
        void adminService.appendAdminLog(
          'upload_failed',
          'Wireless upload failed: no file provided.',
          {
            sessionId,
          },
        );
        return res
          .status(400)
          .json({ code: 'no_file', error: 'No file provided.' });
      }

      deps.io
        .to(`session:${sessionId}`)
        .emit('UploadStarted', file.originalname);
      void adminService.appendAdminLog(
        'upload_started',
        'Wireless upload started.',
        {
          sessionId,
          filename: file.originalname,
          sizeBytes: file.size,
        },
      );

      const result = await deps.sessionStore.storeUpload(
        sessionId,
        token,
        file,
      );

      if (!result.isSuccess || !result.document) {
        deps.io.to(`session:${sessionId}`).emit('UploadFailed');
        await adminService.appendAdminLog(
          'upload_failed',
          'Wireless upload failed.',
          {
            sessionId,
            filename: file.originalname,
            errorCode: result.errorCode ?? null,
          },
        );
        return res.status(400).json({
          code: result.errorCode ?? 'UPLOAD_FAILED',
          error: result.errorMsg ?? 'Upload failed.',
        });
      }

      const doc = result.document;

      const docExtension = path.extname(doc.filename).toLowerCase();
      if (POWERPOINT_EXTENSIONS.has(docExtension)) {
        const analyzed = await analyzeAndStoreDocument(
          req,
          sessionId,
          doc.documentId,
        );
        if (!('analysis' in analyzed)) {
          deps.io.to(`session:${sessionId}`).emit('UploadFailed');
          await adminService.appendAdminLog(
            'upload_failed',
            'Wireless upload failed during required PowerPoint analysis.',
            {
              sessionId,
              filename: doc.filename,
              documentId: doc.documentId,
              reason: analyzed.error,
            },
          );
          return res.status(analyzed.status).json({
            code: 'ANALYSIS_FAILED',
            error: analyzed.error,
          });
        }
      } else {
        void analyzeAndStoreDocument(req, sessionId, doc.documentId).catch(
          (error) => {
            console.warn(
              '[analyze-document] Failed to analyze uploaded file:',
              error,
            );
          },
        );
      }

      deps.io.to(`session:${sessionId}`).emit('UploadCompleted', doc);
      await adminService.appendAdminLog(
        'upload_completed',
        'Wireless upload completed.',
        {
          sessionId,
          filename: doc.filename,
          documentId: doc.documentId,
          sizeBytes: doc.sizeBytes,
        },
      );

      res.status(200).json({
        documentId: doc.documentId,
        sessionId: doc.sessionId,
        fileName: doc.filename,
        contentType: doc.contentType,
        sizeBytes: doc.sizeBytes,
        uploadedAt: doc.uploadedAt,
      });
    },
  );

  app.delete(
    '/api/wireless/sessions/:sessionId/documents/:documentId',
    verifyUploadTarget,
    async (req: Request, res: Response) => {
      const { sessionId, documentId } = req.params as {
        sessionId: string;
        documentId: string;
      };

      const result = await deps.sessionStore.removeDocument(sessionId, documentId);
      if (!result.success) {
        const status =
          result.errorCode === 'DOCUMENT_NOT_FOUND'
            ? 404
            : result.errorCode === 'SESSION_EXPIRED'
              ? 410
              : 404;

        await adminService.appendAdminLog(
          'upload_delete_failed',
          'Failed to delete uploaded document from session.',
          {
            sessionId,
            documentId,
            errorCode: result.errorCode ?? null,
          },
        );
        return res.status(status).json({
          error:
            result.errorCode === 'DOCUMENT_NOT_FOUND'
              ? 'Document not found in session.'
              : result.errorCode === 'SESSION_EXPIRED'
                ? 'Session has expired.'
                : 'Session not found.',
        });
      }

      deps.io.to(`session:${sessionId}`).emit('UploadRemoved', {
        documentId: result.removedDocumentId,
        remainingCount: result.remainingCount,
      });

      await adminService.appendAdminLog(
        'upload_deleted',
        'Uploaded document removed from active wireless session.',
        {
          sessionId,
          documentId: result.removedDocumentId ?? documentId,
          remainingCount: result.remainingCount,
          deletedFile: result.deletedFile,
        },
      );

      return res.status(200).json({
        success: true,
        removedDocumentId: result.removedDocumentId,
        remainingCount: result.remainingCount,
        deletedFile: result.deletedFile,
      });
    },
  );

  app.delete(
    '/api/wireless/sessions/:sessionId/cancel',
    verifyUploadTarget,
    async (req: Request, res: Response) => {
      const { sessionId } = req.params as { sessionId: string };

      // Attempt to cancel the session
      const result = await deps.sessionStore.cancelSession(sessionId);

      if (!result.success) {
        await adminService.appendAdminLog(
          'session_cancel_failed',
          'Failed to cancel session: session not found or already expired.',
          {
            sessionId,
          },
        );
        return res.status(404).json({
          error: 'Session not found or already expired.',
          sessionId,
        });
      }

      await adminService.appendAdminLog(
        'session_abandoned',
        'User session abandoned and cleaned up.',
        {
          sessionId,
          deletedFileCount: result.deletedFileCount,
          reason: 'idle_timeout',
        },
      );

      res.status(200).json({
        success: true,
        message: 'Session cancelled and cleaned up.',
        deletedFileCount: result.deletedFileCount,
      });
    },
  );

  app.post(
    '/api/wireless/sessions/:sessionId/analyze',
    verifyUploadTarget,
    async (req: Request, res: Response) => {
      const { sessionId } = req.params as { sessionId: string };
      const { documentId } = (req.body ?? {}) as {
        documentId?: string;
      };

      try {
        const analyzed = await analyzeAndStoreDocument(
          req,
          sessionId,
          documentId,
        );
        if (!('analysis' in analyzed)) {
          return res.status(analyzed.status).json({ error: analyzed.error });
        }

        return res.status(200).json({
          documentId: analyzed.documentId,
          fileName: analyzed.fileName,
          ...analyzed.analysis,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error';
        return res
          .status(500)
          .json({ error: 'Document analysis failed.', reason });
      }
    },
  );

  app.use('/api/wireless/sessions/:sessionId/upload', handleMulterError);
}
