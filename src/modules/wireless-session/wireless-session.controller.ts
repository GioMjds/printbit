import { Router } from 'express';
import {
  uploadMiddleware,
  handleMulterError,
  validateMagicBytes,
  scanForMalware,
} from '@/middleware/file-validation';
import { createRateLimit } from '@/middleware/rate-limit';
import { createKioskAccessMiddleware } from '@/middleware/kiosk-access';
import {
  powerSafetyService,
  type PowerSafetyService,
} from '@/services/power-safety';
import type { WirelessSessionService } from './wireless-session.service';

const wirelessPreviewRateLimit = createRateLimit({
  keyPrefix: 'wireless-session-preview',
  windowMs: 60_000,
  max: 30,
});

const wirelessUploadRateLimit = createRateLimit({
  keyPrefix: 'wireless-session-upload',
  windowMs: 60_000,
  max: 10,
});

export class WirelessSessionController {
  public readonly router: Router;
  private readonly powerSafety: PowerSafetyService;

  constructor(
    private readonly wirelessSessionService: WirelessSessionService,
    powerSafety: PowerSafetyService = powerSafetyService,
  ) {
    this.powerSafety = powerSafety;
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.get(
      '/api/wireless/sessions',
      createKioskAccessMiddleware(),
      (req, res, next) => {
        if (!this.powerSafety.canAcceptCustomerWork()) {
          res.status(503).json({
            code: 'POWER_EMERGENCY',
            message: 'Power emergency active; customer work suspended',
          });
          return;
        }
        return this.wirelessSessionService.createSession(req, res, next);
      },
    );
    this.router.get(
      '/api/wireless/sessions/by-token/:token',
      this.wirelessSessionService.getSessionByToken,
    );
    this.router.get(
      '/api/wireless/sessions/:sessionId/preview',
      this.wirelessSessionService.verifyKioskOrOwnedUploadTarget,
      wirelessPreviewRateLimit,
      this.wirelessSessionService.getSessionPreview,
    );
    this.router.get(
      '/api/wireless/sessions/:sessionId/color-analysis',
      this.wirelessSessionService.verifyKioskOrOwnedUploadTarget,
      this.wirelessSessionService.getSessionColorAnalysis,
    );
    this.router.get(
      '/api/wireless/sessions/:sessionId/analysis/:documentId',
      this.wirelessSessionService.verifyKioskOrOwnedUploadTarget,
      this.wirelessSessionService.getSessionDocumentAnalysis,
    );
    this.router.get(
      '/api/wireless/sessions/:sessionId',
      this.wirelessSessionService.verifyKioskOrOwnedUploadTarget,
      this.wirelessSessionService.getSessionById,
    );
    this.router.post(
      '/api/wireless/sessions/:sessionId/touch',
      this.wirelessSessionService.verifyKioskOrOwnedUploadTarget,
      this.wirelessSessionService.touchSession,
    );
    this.router.post(
      '/api/wireless/sessions/:sessionId/upload',
      wirelessUploadRateLimit,
      this.wirelessSessionService.verifyKioskOrOwnedUploadTarget,
      uploadMiddleware.single('file'),
      validateMagicBytes,
      scanForMalware,
      this.wirelessSessionService.uploadToSession,
    );
    this.router.delete(
      '/api/wireless/sessions/:sessionId/documents/:documentId',
      this.wirelessSessionService.verifyKioskOrOwnedUploadTarget,
      this.wirelessSessionService.removeSessionDocument,
    );
    this.router.delete(
      '/api/wireless/sessions/:sessionId/cancel',
      this.wirelessSessionService.verifyKioskOrOwnedUploadTarget,
      this.wirelessSessionService.cancelSession,
    );
    this.router.post(
      '/api/wireless/sessions/:sessionId/analyze',
      this.wirelessSessionService.verifyKioskOrOwnedUploadTarget,
      this.wirelessSessionService.analyzeSessionDocument,
    );
    this.router.post(
      '/api/analyze-job',
      this.wirelessSessionService.verifyKioskOrOwnedAnalyzeJobTarget,
      this.wirelessSessionService.analyzeJob,
    );
    this.router.use(
      '/api/wireless/sessions/:sessionId/upload',
      handleMulterError,
    );
  }
}
