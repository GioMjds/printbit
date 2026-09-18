import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Namespace, Server } from 'socket.io';
import { kioskAccessService } from '@/middleware/kiosk-access';
import { adminService } from '@/services/admin';
import { db, withBalanceLock } from '@/services/db';
import type {
  DocumentAnalysis,
  SessionStore,
  UploadedDocument,
} from '@/services/session';
import { detectPdfColorContent } from '@/services/color-detection';
import {
  ANALYSIS_ALGORITHM_VERSION,
  analyzeDocument,
  resolveFileType,
} from '@/services/document-analysis';
import {
  enqueuePricingAnalysisJob,
  getPricingAnalysisJobStatus,
  setPricingAnalysisJobProcessor,
  startPricingAnalysisWorker,
  type PricingAnalysisJobData,
} from '@/services/pricing-analysis-queue';
import { PORT } from '@/config/http.config';
import { pricingAnalysisCacheStore } from '@/core/database/sqlite-storage';
import {
  powerSafetyService,
  type PowerSafetyService,
} from '@/services/power-safety';

export interface WirelessSessionServiceDeps {
  io: Server;
  sessionIo: Namespace;
  sessionStore: SessionStore;
  resolvePublicBaseUrl: (req: Request) => URL;
  convertToPdfArtifact: (
    sourcePath: string,
    artifactPath: string,
  ) => Promise<string>;
  powerSafetyService?: PowerSafetyService;
}

const BEARER_SCHEME = 'bearer';

function isWhitespaceCharacter(value: string): boolean {
  return value.trim().length === 0;
}

export class WirelessSessionService {
  private static pricingAnalysisWorkerInitialized = false;
  private readonly powerSafety: PowerSafetyService;

  constructor(private readonly deps: WirelessSessionServiceDeps) {
    this.powerSafety = deps.powerSafetyService ?? powerSafetyService;
    this.ensurePricingAnalysisWorkerStarted();
  }

  extractUploadToken(req: Request): string {
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

    if (authorizationHeader.length <= BEARER_SCHEME.length) return '';
    if (
      authorizationHeader.slice(0, BEARER_SCHEME.length).toLowerCase() !==
      BEARER_SCHEME
    ) {
      return '';
    }

    let tokenStartIndex = BEARER_SCHEME.length;
    if (!isWhitespaceCharacter(authorizationHeader[tokenStartIndex])) return '';
    while (
      tokenStartIndex < authorizationHeader.length &&
      isWhitespaceCharacter(authorizationHeader[tokenStartIndex])
    ) {
      tokenStartIndex += 1;
    }

    return authorizationHeader.slice(tokenStartIndex).trim();
  }

  extractUploadClientId(req: Request): string {
    const queryClient = req.query.clientId;
    if (typeof queryClient === 'string' && queryClient.trim().length > 0) {
      return queryClient.trim();
    }

    const headerClientId =
      req.header('x-upload-client-id') ?? req.header('x-session-client-id');
    if (headerClientId && headerClientId.trim().length > 0) {
      return headerClientId.trim();
    }

    return '';
  }

  verifyUploadTarget: RequestHandler<{ sessionId: string }> = (
    req,
    res,
    next,
  ) => {
    const { sessionId } = req.params;
    const token = this.extractUploadToken(req);

    if (!sessionId || !token) {
      res.status(401).json({ error: 'Missing session or token.' });
      return;
    }

    const sessionState = this.deps.sessionStore.getSessionState(sessionId);
    if (sessionState === 'expired') {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }
    if (sessionState === 'missing') {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

    const publicBaseUrl = this.deps.resolvePublicBaseUrl(req);
    const session = this.deps.sessionStore.tryGetSession(
      sessionId,
      publicBaseUrl,
    );
    if (!session) {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }

    if (session.token !== token) {
      res.status(403).json({ error: 'Invalid token for session.' });
      return;
    }

    next();
  };

  verifyOwnedUploadTarget: RequestHandler<{ sessionId: string }> = (
    req,
    res,
    next,
  ) => {
    this.verifyUploadTarget(req, res, () => {
      const { sessionId } = req.params;
      const token = this.extractUploadToken(req);
      const clientId = this.extractUploadClientId(req);
      if (!clientId) {
        res.status(400).json({
          code: 'INVALID_CLIENT_ID',
          error: 'Invalid upload client identifier.',
        });
        return;
      }

      const claim = this.deps.sessionStore.claimOwner(
        sessionId,
        token,
        clientId,
      );
      if (!claim.ok && claim.errorCode) {
        res.status(this.statusForClaimError(claim.errorCode)).json({
          code: claim.errorCode,
          error: claim.errorMsg ?? 'Unable to validate session ownership.',
        });
        return;
      }

      next();
    });
  };

  verifyKioskOrOwnedUploadTarget: RequestHandler<{ sessionId: string }> = (
    req,
    res,
    next,
  ) => {
    if (kioskAccessService.isKioskRequest(req)) {
      const { sessionId } = req.params;
      const sessionState = this.deps.sessionStore.getSessionState(sessionId);
      if (sessionState === 'expired') {
        res.status(410).json({
          code: 'SESSION_EXPIRED',
          error: 'Session has expired. Please start a new session.',
        });
        return;
      }
      if (sessionState === 'missing') {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }

      const token = this.extractUploadToken(req);
      if (token) {
        const publicBaseUrl = this.deps.resolvePublicBaseUrl(req);
        const session = this.deps.sessionStore.tryGetSession(
          sessionId,
          publicBaseUrl,
        );
        if (session && session.token !== token) {
          res.status(403).json({ error: 'Invalid token for session.' });
          return;
        }
      }

      next();
      return;
    }
    this.verifyOwnedUploadTarget(req, res, next);
  };

  verifyAnalyzeJobTarget: RequestHandler = (req, res, next) => {
    const payload =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const sessionId =
      typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    const token = this.extractUploadToken(req);

    if (!sessionId || !token) {
      res.status(401).json({ error: 'Missing session or token.' });
      return;
    }

    const sessionState = this.deps.sessionStore.getSessionState(sessionId);
    if (sessionState === 'expired') {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }
    if (sessionState === 'missing') {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

    const publicBaseUrl = this.deps.resolvePublicBaseUrl(req);
    const session = this.deps.sessionStore.tryGetSession(
      sessionId,
      publicBaseUrl,
    );
    if (!session) {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }

    if (session.token !== token) {
      res.status(403).json({ error: 'Invalid token for session.' });
      return;
    }

    payload.sessionId = sessionId;
    req.body = payload;
    next();
  };

  verifyKioskOrOwnedAnalyzeJobTarget: RequestHandler = (req, res, next) => {
    this.verifyAnalyzeJobTarget(req, res, () => {
      if (kioskAccessService.isKioskRequest(req)) {
        next();
        return;
      }

      const payload = req.body as { sessionId: string };
      const claim = this.deps.sessionStore.claimOwner(
        payload.sessionId,
        this.extractUploadToken(req),
        this.extractUploadClientId(req),
      );
      if (!claim.ok && claim.errorCode) {
        res.status(this.statusForClaimError(claim.errorCode)).json({
          code: claim.errorCode,
          error: claim.errorMsg ?? 'Unable to validate session ownership.',
        });
        return;
      }

      next();
    });
  };

  createSession: RequestHandler = async (req, res) => {
    if (!this.powerSafety.canAcceptCustomerWork()) {
      res.status(503).json({
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      });
      return;
    }

    try {
      const previousBalance = await withBalanceLock(async () => {
        const currentBalance = db.data?.balance ?? 0;
        if (currentBalance <= 0) return 0;
        db.data!.balance = 0;
        await db.write();
        return currentBalance;
      });

      this.deps.io.emit('balance', 0);

      const publicBaseUrl = this.deps.resolvePublicBaseUrl(req);
      const session = this.deps.sessionStore.createSession(publicBaseUrl);
      void adminService.appendAdminLog(
        'session_created',
        'Wireless upload session created.',
        {
          sessionId: session.sessionId,
          previousBalance,
          newBalance: 0,
          balanceReset: previousBalance > 0,
        },
      );
      res.status(201).json(session);
    } catch (error) {
      console.error('[wireless-session] Failed to create session.', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'Failed to create wireless session.',
      });
    }
  };

  getSessionByToken: RequestHandler<{ token: string }> = (req, res) => {
    const { token } = req.params;
    const clientId = this.extractUploadClientId(req);
    if (!clientId) {
      res.status(400).json({
        code: 'MISSING_CLIENT_ID',
        error: 'Missing upload client identifier.',
      });
      return;
    }

    const tokenState = this.deps.sessionStore.getTokenState(token);
    if (tokenState === 'expired') {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }
    if (tokenState === 'missing') {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

    const claim = this.deps.sessionStore.claimOwnerByToken(token, clientId);
    if (!claim.ok && claim.errorCode) {
      res.status(this.statusForClaimError(claim.errorCode)).json({
        code: claim.errorCode,
        error: claim.errorMsg ?? 'Unable to validate session ownership.',
      });
      return;
    }

    const publicBaseUrl = this.deps.resolvePublicBaseUrl(req);
    const session = this.deps.sessionStore.tryGetSessionByToken(
      token,
      publicBaseUrl,
    );

    if (!session) {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }

    const pipelineSettings = adminService.getPipelineSettings();
    const documentConversionEnabled =
      typeof pipelineSettings?.documentConversionEnabled === 'boolean'
        ? pipelineSettings.documentConversionEnabled
        : true;

    res.json({
      ...session,
      documentConversionEnabled,
    });
  };

  getSessionPreview: RequestHandler<{ sessionId: string }> = async (
    req,
    res,
  ) => {
    const { sessionId } = req.params;
    const publicBaseUrl = this.deps.resolvePublicBaseUrl(req);
    const session = this.deps.sessionStore.tryGetSession(
      sessionId,
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
      if (requestedFilename) {
        res.status(404).json({ error: 'Document not found.' });
      } else {
        res.status(404).json({ error: 'No documents available for preview.' });
      }
      return;
    }

    if (!this.deps.sessionStore.touchSession(sessionId)) {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }

    const startedAt = Date.now();

    try {
      const absolutePath = await this.resolveCanonicalPdfPath(sessionId, target);
      const extension = path.extname(absolutePath).toLowerCase();
      console.log('[preview] request', {
        sessionId,
        filename: target.filename,
        extension,
      });
      if (extension === '.pdf') {
        res.setHeader('Content-Type', 'application/pdf');
        console.log('[preview] serving pdf file', {
          path: absolutePath,
          tookMs: Date.now() - startedAt,
        });
        res.sendFile(absolutePath);
        return;
      }

      console.warn('[preview] unsupported extension', {
        extension,
        filename: target.filename,
        tookMs: Date.now() - startedAt,
      });
      res.status(400).json({
        error: `Preview not supported for ${extension}.`,
        code: 'UNSUPPORTED_PREVIEW',
      });
    } catch (error) {
      console.error('[preview] route error:', error);
      const reason =
        error instanceof Error ? error.message : 'Unknown preview error';
      res.status(500).json({
        error:
          'Preview conversion failed. Ensure the PrintBit Worker and LibreOffice are installed and available.',
        reason,
        code: 'PREVIEW_CONVERSION_FAILED',
      });
    }
  };

  getSessionColorAnalysis: RequestHandler<{ sessionId: string }> = async (
    req,
    res,
  ) => {
    const { sessionId } = req.params;
    const publicBaseUrl = this.deps.resolvePublicBaseUrl(req);
    const session = this.deps.sessionStore.tryGetSession(
      sessionId,
      publicBaseUrl,
    );

    if (!session) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

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
      res.json({
        hasColor: true,
        isGrayscale: false,
        sampledPages: 0,
      });
      return;
    }

    if (!this.deps.sessionStore.touchSession(sessionId)) {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }

    const pipeline = adminService.getPipelineSettings();
    if (!pipeline.colorDetectionEnabled) {
      res.json({
        hasColor: false,
        isGrayscale: true,
        sampledPages: 0,
      });
      return;
    }

    try {
      const pdfPath = await this.resolveCanonicalPdfPath(sessionId, target);

      const result = await detectPdfColorContent(pdfPath);
      res.json({
        hasColor: result.hasColor,
        isGrayscale: result.isGrayscale,
        sampledPages: result.sampledPages,
      });
    } catch (err) {
      console.warn(
        '[color-analysis] Detection failed, defaulting to color:',
        err,
      );
      res.json({
        hasColor: true,
        isGrayscale: false,
        sampledPages: 0,
      });
    }
  };

  getSessionDocumentAnalysis: RequestHandler<{
    sessionId: string;
    documentId: string;
  }> = (req, res) => {
    const { sessionId, documentId } = req.params;
    const publicBaseUrl = this.deps.resolvePublicBaseUrl(req);
    const session = this.deps.sessionStore.tryGetSession(
      sessionId,
      publicBaseUrl,
    );

    if (!session) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

    if (!this.deps.sessionStore.touchSession(sessionId)) {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }

    const allDocs =
      session.documents && session.documents.length > 0
        ? session.documents
        : session.document
          ? [session.document]
          : [];

    const target = allDocs.find((doc) => doc.documentId === documentId);
    if (!target || !target.analysis) {
      res.status(404).json({
        error: 'Document analysis not found.',
      });
      return;
    }

    res.json(target.analysis);
  };

  getSessionById: RequestHandler<{ sessionId: string }> = (req, res) => {
    const { sessionId } = req.params;
    const sessionState = this.deps.sessionStore.getSessionState(sessionId);
    if (sessionState === 'expired') {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }
    if (sessionState === 'missing') {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

    const publicBaseUrl = this.deps.resolvePublicBaseUrl(req);
    const session = this.deps.sessionStore.tryGetSession(
      sessionId,
      publicBaseUrl,
    );
    if (!session) {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }

    // Keep kiosk sessions alive while the print page is actively polling this
    // endpoint. Without this, active kiosk flows can expire even when users
    // are still interacting with the same session.
    if (!this.deps.sessionStore.touchSession(sessionId)) {
      res.status(410).json({
        code: 'SESSION_EXPIRED',
        error: 'Session has expired. Please start a new session.',
      });
      return;
    }

    res.json(session);
  };

  uploadToSession: RequestHandler<{ sessionId: string }> = async (req, res) => {
    const { sessionId } = req.params;
    const token = this.extractUploadToken(req);
    const file = req.file;

    if (!file) {
      void adminService.appendAdminLog(
        'upload_failed',
        'Wireless upload failed: no file provided.',
        {
          sessionId,
        },
      );
      res.status(400).json({ code: 'no_file', error: 'No file provided.' });
      return;
    }

    this.emitToSession(sessionId, 'UploadStarted', file.originalname);
    void adminService.appendAdminLog(
      'upload_started',
      'Wireless upload started.',
      {
        sessionId,
        filename: file.originalname,
        sizeBytes: file.size,
      },
    );

    const result = await this.deps.sessionStore.storeUpload(
      sessionId,
      token,
      file,
    );
    if (!result.isSuccess || !result.document) {
      this.emitToSession(sessionId, 'UploadFailed');
      await adminService.appendAdminLog(
        'upload_failed',
        'Wireless upload failed.',
        {
          sessionId,
          filename: file.originalname,
          errorCode: result.errorCode ?? null,
        },
      );
      const statusCode =
        result.errorCode === 'SESSION_PERSIST_FAILED' ? 500 : 400;
      res.status(statusCode).json({
        code: result.errorCode ?? 'UPLOAD_FAILED',
        error: result.errorMsg ?? 'Upload failed.',
      });
      return;
    }

    const doc = result.document;
    this.emitToSession(sessionId, 'UploadCompleted', doc);
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

    const queued = await this.enqueueAnalysisJob(
      sessionId,
      doc.documentId,
      'upload',
      false,
      req,
    );

    if (!queued.ok) {
      await adminService.appendAdminLog(
        'analysis_queue_failed',
        'Failed to queue pricing analysis for uploaded document.',
        {
          sessionId,
          documentId: doc.documentId,
          filename: doc.filename,
          reason: queued.error,
        },
      );
    }

    res.status(200).json({
      documentId: doc.documentId,
      sessionId: doc.sessionId,
      fileName: doc.filename,
      contentType: doc.contentType,
      sizeBytes: doc.sizeBytes,
      uploadedAt: doc.uploadedAt,
      analysisJobId: queued.ok ? queued.jobId : null,
      analysisStatus: queued.ok ? queued.status : 'failed',
    });
  };

  removeSessionDocument: RequestHandler<{
    sessionId: string;
    documentId: string;
  }> = async (req, res) => {
    const { sessionId, documentId } = req.params;
    const result = await this.deps.sessionStore.removeDocument(
      sessionId,
      documentId,
    );
    if (!result.success) {
      const status =
        result.errorCode === 'DOCUMENT_NOT_FOUND'
          ? 404
          : result.errorCode === 'SESSION_EXPIRED'
            ? 410
            : result.errorCode === 'SESSION_PERSIST_FAILED'
              ? 500
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
      res.status(status).json({
        error:
          result.errorCode === 'DOCUMENT_NOT_FOUND'
            ? 'Document not found in session.'
            : result.errorCode === 'SESSION_EXPIRED'
              ? 'Session has expired.'
              : result.errorCode === 'SESSION_PERSIST_FAILED'
                ? 'Failed to persist session changes while deleting document.'
                : 'Session not found.',
      });
      return;
    }

    this.emitToSession(sessionId, 'UploadRemoved', {
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

    res.status(200).json({
      success: true,
      removedDocumentId: result.removedDocumentId,
      remainingCount: result.remainingCount,
      deletedFile: result.deletedFile,
    });
  };

  cancelSession: RequestHandler<{ sessionId: string }> = async (req, res) => {
    const { sessionId } = req.params;
    const result = await this.deps.sessionStore.cancelSession(sessionId);
    if (!result.success) {
      await adminService.appendAdminLog(
        'session_cancel_failed',
        'Failed to cancel session: session not found or already expired.',
        {
          sessionId,
          errorCode: result.errorCode ?? null,
        },
      );
      const status = result.errorCode === 'SESSION_PERSIST_FAILED' ? 500 : 404;
      res.status(status).json({
        error:
          result.errorCode === 'SESSION_PERSIST_FAILED'
            ? 'Failed to persist session cancellation.'
            : 'Session not found or already expired.',
        sessionId,
      });
      return;
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
  };

  analyzeJob: RequestHandler = async (req, res) => {
    const payload =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const sessionId =
      typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    const jobIdRaw =
      typeof payload.jobId === 'string' ? payload.jobId.trim() : '';
    const documentIdRaw =
      typeof payload.documentId === 'string' ? payload.documentId.trim() : '';
    const forceReanalyze = payload.forceReanalyze === true;

    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required.' });
      return;
    }

    if (jobIdRaw) {
      if (!jobIdRaw.startsWith(`${sessionId}:`)) {
        res.status(403).json({
          error: 'jobId does not belong to the provided session.',
        });
        return;
      }

      try {
        const status = await getPricingAnalysisJobStatus(jobIdRaw);
        res.status(200).json({
          ok: true,
          jobId: status.jobId,
          status: status.status,
          ...(status.failedReason ? { failedReason: status.failedReason } : {}),
        });
      } catch (error) {
        res.status(503).json({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to retrieve analysis job status.',
        });
      }
      return;
    }

    const queued = await this.enqueueAnalysisJob(
      sessionId,
      documentIdRaw || undefined,
      'manual',
      forceReanalyze,
      req,
    );
    if (!queued.ok) {
      res.status(queued.status).json({ ok: false, error: queued.error });
      return;
    }

    res.status(202).json({
      ok: true,
      jobId: queued.jobId,
      status: queued.status,
    });
  };

  analyzeSessionDocument: RequestHandler<{ sessionId: string }> = async (
    req,
    res,
  ) => {
    const { sessionId } = req.params;
    const { documentId, forceReanalyze } = (req.body ?? {}) as {
      documentId?: string;
      forceReanalyze?: boolean;
    };
    const queued = await this.enqueueAnalysisJob(
      sessionId,
      documentId,
      'manual',
      forceReanalyze === true,
      req,
    );
    if (!queued.ok) {
      res.status(queued.status).json({ ok: false, error: queued.error });
      return;
    }

    res.status(202).json({
      ok: true,
      jobId: queued.jobId,
      status: queued.status,
    });
  };

  private statusForClaimError(
    code:
      | 'SESSION_NOT_FOUND'
      | 'SESSION_EXPIRED'
      | 'INVALID_TOKEN'
      | 'INVALID_CLIENT_ID'
      | 'SESSION_OWNED'
      | 'SESSION_PERSIST_FAILED',
  ): number {
    if (code === 'SESSION_EXPIRED') return 410;
    if (code === 'SESSION_OWNED') return 409;
    if (code === 'INVALID_TOKEN') return 403;
    if (code === 'INVALID_CLIENT_ID') return 400;
    if (code === 'SESSION_PERSIST_FAILED') return 500;
    return 404;
  }

  /**
   * Session events are delivered only to the authenticated kiosk/control
   * namespace and the authenticated external-session namespace. Re-checking
   * state here prevents a socket that outlives its session from receiving a
   * late upload or analysis event.
   */
  private emitToSession(
    sessionId: string,
    event: string,
    payload?: unknown,
  ): void {
    if (this.deps.sessionStore.getSessionState(sessionId) !== 'active') {
      return;
    }

    const room = `session:${sessionId}`;
    if (payload === undefined) {
      this.deps.io.to(room).emit(event);
      this.deps.sessionIo.to(room).emit(event);
      return;
    }

    this.deps.io.to(room).emit(event, payload);
    this.deps.sessionIo.to(room).emit(event, payload);
  }

  private ensurePricingAnalysisWorkerStarted(): void {
    if (WirelessSessionService.pricingAnalysisWorkerInitialized) return;

    setPricingAnalysisJobProcessor(async (data) => {
      await this.processQueuedAnalysisJob(data);
    });
    startPricingAnalysisWorker();
    WirelessSessionService.pricingAnalysisWorkerInitialized = true;
  }

  private async enqueueAnalysisJob(
    sessionId: string,
    documentId: string | undefined,
    source: 'upload' | 'manual',
    forceReanalyze: boolean,
    req?: Request,
  ): Promise<
    | {
        ok: true;
        jobId: string;
        status:
          | 'waiting'
          | 'active'
          | 'completed'
          | 'failed'
          | 'delayed'
          | 'unknown';
      }
    | { ok: false; status: 404 | 503; error: string }
  > {
    const targetLookup = this.resolveAnalysisTargetDocument(
      sessionId,
      req ? this.deps.resolvePublicBaseUrl(req) : this.buildInternalBaseUrl(),
      documentId,
    );
    if (!('target' in targetLookup)) {
      return {
        ok: false,
        status: targetLookup.status,
        error: targetLookup.error,
      };
    }

    const markedPending = this.deps.sessionStore.markDocumentAnalysisPending(
      sessionId,
      targetLookup.target.documentId,
    );
    if (!markedPending) {
      return {
        ok: false,
        status: 404,
        error: 'Document not found.',
      };
    }

    this.emitToSession(sessionId, 'AnalysisStarted', {
      documentId: targetLookup.target.documentId,
      filename: targetLookup.target.filename,
    });

    try {
      this.ensurePricingAnalysisWorkerStarted();

      const enqueuePromise = enqueuePricingAnalysisJob({
        sessionId,
        documentId: targetLookup.target.documentId,
        source,
        forceReanalyze,
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Queue timeout')), 2000),
      );

      const queued = await Promise.race([enqueuePromise, timeoutPromise]);

      return {
        ok: true,
        jobId: queued.jobId,
        status: queued.status,
      };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Failed to enqueue analysis.';

      console.warn(
        `[wireless-session] Analysis enqueuing failed or timed out. Falling back to fire-and-forget local analysis. Reason: ${reason}`,
      );

      void (async () => {
        try {
          await this.processQueuedAnalysisJob({
            sessionId,
            documentId: targetLookup.target.documentId,
            source,
            forceReanalyze,
            requestedAt: new Date().toISOString(),
          });
        } catch (innerError) {
          console.error(
            '[wireless-session] Local analysis fallback failed.',
            innerError,
          );
        }
      })();

      return {
        ok: true,
        jobId: `local:${targetLookup.target.documentId}:${Date.now()}`,
        status: 'active',
      };
    }
  }

  private async processQueuedAnalysisJob(
    job: PricingAnalysisJobData,
  ): Promise<void> {
    try {
      const analyzed = await this.analyzeAndStoreDocument(
        job.sessionId,
        job.documentId,
        this.buildInternalBaseUrl(),
        { forceReanalyze: job.forceReanalyze },
      );
      if (!('analysis' in analyzed)) {
        throw new Error(analyzed.error);
      }

      this.emitToSession(job.sessionId, 'AnalysisCompleted', {
        documentId: analyzed.documentId,
        filename: analyzed.fileName,
        analysis: analyzed.analysis,
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Document analysis failed.';
      this.deps.sessionStore.markDocumentAnalysisFailure(
        job.sessionId,
        job.documentId,
        reason,
      );
      this.emitToSession(job.sessionId, 'AnalysisFailed', {
        documentId: job.documentId,
        filename: job.documentId,
        error: reason,
      });
      throw error instanceof Error ? error : new Error(reason);
    }
  }

  private resolveAnalysisTargetDocument(
    sessionId: string,
    publicBaseUrl: URL,
    documentId?: string,
  ): { target: UploadedDocument } | { error: string; status: 404 } {
    const session = this.deps.sessionStore.tryGetSession(
      sessionId,
      publicBaseUrl,
    );
    if (!session) {
      return { error: 'Session not found.', status: 404 };
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
      ? (docs.find((doc) => doc.documentId === targetDocumentId) ?? null)
      : (docs[docs.length - 1] ?? null);

    if (!target) {
      return { error: 'Document not found.', status: 404 };
    }

    return { target };
  }

  private buildInternalBaseUrl(): URL {
    return new URL(`http://127.0.0.1:${PORT}`);
  }

  private buildPricingConfigFingerprint(): string {
    const pricingEngine = db.data?.settings?.pricingEngine ?? null;
    return createHash('sha256')
      .update(JSON.stringify(pricingEngine))
      .digest('hex');
  }

  private async computeFileHash(filePath: string): Promise<string> {
    const fileBuffer = await fs.promises.readFile(filePath);
    return createHash('sha256').update(fileBuffer).digest('hex');
  }

  private normalizeAnalysisPayload(
    candidate: unknown,
  ): Omit<DocumentAnalysis, 'analyzedAt'> | null {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const value = candidate as Record<string, unknown>;

    const fileType = value.fileType;
    if (
      fileType !== 'pdf' &&
      fileType !== 'docx' &&
      fileType !== 'doc' &&
      fileType !== 'xlsx' &&
      fileType !== 'xls' &&
      fileType !== 'pptx' &&
      fileType !== 'ppt' &&
      fileType !== 'image' &&
      fileType !== 'unknown'
    ) {
      return null;
    }

    if (
      typeof value.pageCount !== 'number' ||
      !Number.isFinite(value.pageCount) ||
      typeof value.colorPages !== 'number' ||
      !Number.isFinite(value.colorPages) ||
      typeof value.bwPages !== 'number' ||
      !Number.isFinite(value.bwPages) ||
      typeof value.totalPages !== 'number' ||
      !Number.isFinite(value.totalPages) ||
      !Array.isArray(value.pages)
    ) {
      return null;
    }

    const pages: Array<DocumentAnalysis['pages'][number]> = [];
    for (const page of value.pages) {
      if (typeof page !== 'object' || page === null) {
        return null;
      }
      const pageValue = page as Record<string, unknown>;
      if (
        typeof pageValue.index !== 'number' ||
        !Number.isFinite(pageValue.index) ||
        typeof pageValue.isColor !== 'boolean'
      ) {
        return null;
      }

      const coverage =
        typeof pageValue.coverage === 'number' &&
        Number.isFinite(pageValue.coverage)
          ? Math.max(0, Math.min(1, pageValue.coverage))
          : undefined;
      const classificationRaw = pageValue.classification;
      const classification:
        | 'blank'
        | 'bw'
        | 'partial'
        | 'full_color'
        | 'image'
        | undefined =
        classificationRaw === 'blank' ||
        classificationRaw === 'bw' ||
        classificationRaw === 'partial' ||
        classificationRaw === 'full_color' ||
        classificationRaw === 'image'
          ? classificationRaw
          : undefined;
      const isImagePage =
        typeof pageValue.isImagePage === 'boolean'
          ? pageValue.isImagePage
          : undefined;
      const isBlank =
        typeof pageValue.isBlank === 'boolean' ? pageValue.isBlank : undefined;
      const fallbackReasonFlags = Array.isArray(pageValue.fallbackReasonFlags)
        ? pageValue.fallbackReasonFlags.filter(
            (flag): flag is string => typeof flag === 'string',
          )
        : undefined;

      pages.push({
        index: Math.floor(pageValue.index),
        isColor: pageValue.isColor,
        ...(coverage !== undefined ? { coverage } : {}),
        ...(classification ? { classification } : {}),
        ...(isImagePage !== undefined ? { isImagePage } : {}),
        ...(isBlank !== undefined ? { isBlank } : {}),
        ...(fallbackReasonFlags && fallbackReasonFlags.length > 0
          ? { fallbackReasonFlags }
          : {}),
      });
    }

    const confidenceRaw = value.confidence;
    const confidence =
      confidenceRaw === 'high' ||
      confidenceRaw === 'medium' ||
      confidenceRaw === 'low'
        ? confidenceRaw
        : 'medium';

    return {
      fileType,
      pageCount: Math.max(0, Math.floor(value.pageCount)),
      pages,
      colorPages: Math.max(0, Math.floor(value.colorPages)),
      bwPages: Math.max(0, Math.floor(value.bwPages)),
      totalPages: Math.max(0, Math.floor(value.totalPages)),
      confidence,
    };
  }

  private async analyzeAndStoreDocument(
    sessionId: string,
    documentId: string | undefined,
    publicBaseUrl: URL,
    options?: { forceReanalyze?: boolean },
  ): Promise<
    | { error: string; status: 404 | 422 | 500 }
    | {
        status: 200;
        analysis: DocumentAnalysis;
        documentId: string;
        fileName: string;
      }
  > {
    const targetLookup = this.resolveAnalysisTargetDocument(
      sessionId,
      publicBaseUrl,
      documentId,
    );
    if (!('target' in targetLookup)) {
      return targetLookup;
    }
    const target = targetLookup.target;
    const absoluteFilePath = path.resolve(target.filePath);
    let analysisFilePath: string;
    try {
      analysisFilePath = await this.resolveCanonicalPdfPath(sessionId, target);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Unknown conversion error';
      return {
        error: `Document conversion failed before analysis: ${reason}`,
        status: 422,
      };
    }
    const configFingerprint = this.buildPricingConfigFingerprint();
    const fileHash = await this.computeFileHash(absoluteFilePath);

    if (!options?.forceReanalyze) {
      const cached = pricingAnalysisCacheStore.getByHash(
        fileHash,
        configFingerprint,
        ANALYSIS_ALGORITHM_VERSION,
      );
      if (cached) {
        try {
          const cachedAnalysis = this.normalizeAnalysisPayload(
            JSON.parse(cached.analysisJson),
          );
          if (cachedAnalysis) {
            const persistedFromCache =
              this.deps.sessionStore.setDocumentAnalysis(
                sessionId,
                target.documentId,
                cachedAnalysis,
              );
            if (persistedFromCache) {
              return {
                status: 200,
                analysis: persistedFromCache,
                documentId: target.documentId,
                fileName: target.filename,
              };
            }
          }
        } catch (error) {
          console.warn(
            '[pricing-analysis] Failed to parse cached analysis payload.',
            {
              sessionId,
              documentId: target.documentId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }

    const isOriginalImage =
      target.contentType.startsWith('image/') ||
      ['.jpg', '.jpeg', '.png'].includes(
        path.extname(target.filename).toLowerCase(),
      );
    const originalFileType = isOriginalImage
      ? 'image'
      : resolveFileType(target.contentType, target.filename);

    const analysis = await analyzeDocument({
      filePath: analysisFilePath,
      contentType: 'application/pdf',
      filename: `${path.basename(target.filename, path.extname(target.filename))}.pdf`,
      originalFileType,
    });

    const analysisForStore = this.normalizeAnalysisPayload({
      ...analysis,
      confidence: analysis.confidence ?? 'medium',
    });
    if (!analysisForStore) {
      return {
        error: 'Invalid analysis payload.',
        status: 500,
      };
    }

    const persisted = this.deps.sessionStore.setDocumentAnalysis(
      sessionId,
      target.documentId,
      analysisForStore,
    );

    if (!persisted) {
      return {
        error: 'Failed to persist document analysis.',
        status: 500,
      };
    }

    const nowIso = new Date().toISOString();
    try {
      pricingAnalysisCacheStore.upsert({
        fileHash,
        configFingerprint,
        contentType: target.contentType,
        pageCount: analysisForStore.pageCount,
        analysisJson: JSON.stringify(analysisForStore),
        createdAt: nowIso,
        updatedAt: nowIso,
        algorithmVersion: ANALYSIS_ALGORITHM_VERSION,
      });
    } catch (error) {
      console.error(
        '[pricing-analysis] Failed to persist analysis cache row.',
        {
          sessionId,
          documentId: target.documentId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    return {
      status: 200,
      analysis: persisted,
      documentId: target.documentId,
      fileName: target.filename,
    };
  }

  private async resolveCanonicalPdfPath(
    sessionId: string,
    target: UploadedDocument,
  ): Promise<string> {
    const sourcePath = path.resolve(target.filePath);
    if (path.extname(sourcePath).toLowerCase() === '.pdf') return sourcePath;

    const artifactPath = path.join(
      path.dirname(sourcePath),
      `${path.basename(target.documentId)}.pdf`,
    );
    if (
      target.convertedPdfPath &&
      path.resolve(target.convertedPdfPath) === artifactPath &&
      fs.existsSync(artifactPath)
    ) {
      return artifactPath;
    }

    const convertedPdfPath = await this.deps.convertToPdfArtifact(
      sourcePath,
      artifactPath,
    );
    if (path.resolve(convertedPdfPath) !== artifactPath) {
      throw new Error('Document conversion returned an unexpected artifact path.');
    }
    if (
      !this.deps.sessionStore.setDocumentConvertedPdfPath(
        sessionId,
        target.documentId,
        artifactPath,
      )
    ) {
      throw new Error('Failed to persist converted PDF artifact.');
    }
    return artifactPath;
  }
}
