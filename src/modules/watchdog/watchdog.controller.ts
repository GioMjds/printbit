import { Router, Request, Response } from 'express';
import { WatchdogService } from './watchdog.service';
import { isLoopbackRequest } from '@/utils/network';
import { WATCHDOG_ALERT_THRESHOLD } from '@/config/watchdog.config';
import { adminService } from '@/services/admin';
import { anomalyService } from '@/services/anomaly';
import { buildAnomalyFingerprint } from '@/services/anomaly';

export interface WatchdogControllerDeps {
  watchdogService: WatchdogService;
}

export class WatchdogController {
  public readonly router: Router;
  private readonly watchdogService: WatchdogService;
  private watchdogFailureEscalated = false;

  constructor(deps: WatchdogControllerDeps) {
    this.watchdogService = deps.watchdogService;
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.get('/health', this.handleGetHealth);
    this.router.post('/report', this.handlePostReport);
    this.router.get('/report', this.handleGetReport);
  }

  /**
   * GET /health - Returns the watchdog health snapshot.
   * Loopback-only endpoint.
   */
  private handleGetHealth = (_req: Request, res: Response): void => {
    const remoteIp =
      _req.ip || _req.socket.remoteAddress || _req.connection?.remoteAddress || '';
    if (!isLoopbackRequest(remoteIp)) {
      res.status(403).json({ error: 'Watchdog health is loopback-only.' });
      return;
    }

    const snapshot = this.watchdogService.getHealthSnapshot();
    const statusCode = snapshot.status === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json(snapshot);
  };

  /**
   * POST /report - Receives watchdog report updates.
   * Loopback-only endpoint with alert escalation logic.
   */
  private handlePostReport = (req: Request, res: Response): void => {
    const remoteIp = req.ip || req.socket.remoteAddress || '';
    if (!isLoopbackRequest(remoteIp)) {
      res.status(403).json({ error: 'Watchdog report is loopback-only.' });
      return;
    }

    const raw = req.body as Record<string, unknown>;

    const toFiniteInt = (value: unknown): number | null => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return Math.floor(value);
    };

    const toOptionalString = (value: unknown): string | null => {
      if (value === null) return null;
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const currentState = this.watchdogService.getExternalState();
    const payload = {
      running:
        typeof raw.running === 'boolean' ? raw.running : currentState.running,
      watchdogPid:
        raw.watchdogPid === null
          ? null
          : (toFiniteInt(raw.watchdogPid) ?? currentState.watchdogPid),
      consecutiveFailures:
        toFiniteInt(raw.consecutiveFailures) ?? currentState.consecutiveFailures,
      recoveryAttempts:
        toFiniteInt(raw.recoveryAttempts) ?? currentState.recoveryAttempts,
      backoffDelayMs:
        toFiniteInt(raw.backoffDelayMs) ?? currentState.backoffDelayMs,
      nextRecoveryAt:
        raw.nextRecoveryAt === null
          ? null
          : (toOptionalString(raw.nextRecoveryAt) ?? currentState.nextRecoveryAt),
      lastAction:
        toOptionalString(raw.lastAction) ?? currentState.lastAction,
      lastError:
        raw.lastError === null
          ? null
          : (toOptionalString(raw.lastError) ?? currentState.lastError),
    };

    const state = this.watchdogService.updateExternalState(payload);

    // Handle escalation when threshold is reached
    if (
      state.consecutiveFailures >= WATCHDOG_ALERT_THRESHOLD &&
      !this.watchdogFailureEscalated
    ) {
      this.watchdogFailureEscalated = true;
      void adminService
        .appendAdminLog(
          'watchdog_recovery_escalated',
          `Watchdog reached ${state.consecutiveFailures} consecutive failures.`,
          {
            threshold: WATCHDOG_ALERT_THRESHOLD,
            recoveryAttempts: state.recoveryAttempts,
            backoffDelayMs: state.backoffDelayMs,
            lastAction: state.lastAction,
            lastError: state.lastError,
          },
        )
        .catch((error) => {
          console.error('[WATCHDOG] Failed to append escalation admin log.', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      void anomalyService
        .report({
          type: 'watchdog_recovery_escalated',
          source: 'external-watchdog',
          category: 'network',
          severity: 'critical',
          message: `Watchdog failed to recover the kiosk after ${state.consecutiveFailures} consecutive attempts.`,
          fingerprint: buildAnomalyFingerprint([
            'watchdog',
            'external',
            'escalated',
          ]),
          context: {
            threshold: WATCHDOG_ALERT_THRESHOLD,
            consecutiveFailures: state.consecutiveFailures,
            recoveryAttempts: state.recoveryAttempts,
            backoffDelayMs: state.backoffDelayMs,
          },
        })
        .catch((error) => {
          console.error('[WATCHDOG] Failed to report escalation anomaly.', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    // Handle recovery when failure streak clears
    if (state.consecutiveFailures === 0 && this.watchdogFailureEscalated) {
      this.watchdogFailureEscalated = false;
      void adminService
        .appendAdminLog(
          'watchdog_recovery_restored',
          'Watchdog recovery failure streak cleared.',
          {
            recoveryAttempts: state.recoveryAttempts,
            lastAction: state.lastAction,
          },
        )
        .catch((error) => {
          console.error('[WATCHDOG] Failed to append restore admin log.', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      void anomalyService
        .report({
          type: 'watchdog_recovery_restored',
          source: 'external-watchdog',
          category: 'network',
          severity: 'warning',
          message:
            'Watchdog recovery failures have cleared and the kiosk is stable again.',
          fingerprint: buildAnomalyFingerprint([
            'watchdog',
            'external',
            'restored',
          ]),
          context: {
            recoveryAttempts: state.recoveryAttempts,
          },
        })
        .catch((error) => {
          console.error('[WATCHDOG] Failed to report restore anomaly.', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    res.json(state);
  };

  /**
   * GET /report - Returns the current external watchdog state.
   * Loopback-only endpoint.
   */
  private handleGetReport = (_req: Request, res: Response): void => {
    const remoteIp =
      _req.ip || _req.socket.remoteAddress || _req.connection?.remoteAddress || '';
    if (!isLoopbackRequest(remoteIp)) {
      res.status(403).json({ error: 'Watchdog report is loopback-only.' });
      return;
    }
    res.json(this.watchdogService.getExternalState());
  };
}
