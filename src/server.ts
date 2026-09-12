import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'node:path';
import { Server } from 'socket.io';
import cookieParser from 'cookie-parser';
import {
  PORT,
  PUBLIC_DIR,
  UPLOAD_DIR,
  CAPTIVE_PORTAL_ENABLED,
  SESSION_EXPIRY_ENABLED,
  WORKER_RETURN_PIPE_NAME,
  WORKER_RETURN_MAX_BYTES,
} from '@/config';
import {
  createCaptivePortalMiddleware,
  createCsrfProtectionMiddleware,
} from '@/middleware';
import { kioskAccessService } from '@/middleware/kiosk-access';
import {
  canControlCoinSlot,
  canJoinSessionRoom,
  installSocketAccessMiddleware,
  type SocketPrincipal,
} from '@/middleware/socket-access';
import { registerAppModules } from '@/app.module';
import { getJobProcessor } from '@/modules/print-queue';
import { initDB } from '@/core/database/db';
import { detectDefaultPrinter } from '@/services/printer';
import { detectScanner } from '@/services/scanner';
import { startScanStorageCleanup } from '@/services/scan-storage';
import { cleanupTransientFilesOnStartup } from '@/services/transient-file-cleanup';
import { convertToPdfArtifact } from '@/services/preview';
import {
  getHopperStatus,
  getSerialStatus,
  initSerial,
  hardwareStateProjection,
} from '@/services/hardware-state-projection';
import { PaymentAcceptorGate } from '@/services/payment-acceptor-gate';
import { BLOCKED_STATUSES } from '@/utils';
import { db } from '@/services/db';
import { registerControlSocketHandlers } from '@/services/control-socket';
import { isHotspotRunning, startHotspot } from '@/services/hotspot';
import { SessionStore, resolvePublicBaseUrl } from '@/services/session';
import { runHopperSelfTest } from '@/services/hopper';
import { anomalyService } from '@/services/anomaly';
import { adminService } from '@/services/admin';
import {
  startTrustedTimeMonitor,
  stopTrustedTimeMonitor,
  verifyTrustedClockSync,
} from '@/services/time-source';
import { getPrinterTelemetry } from '@/services/printer-state-projection';
import {
  startWatchdogHealthMonitor,
  stopWatchdogHealthMonitor,
} from '@/services/watchdog-health';
import {
  markRecoveryShutdown,
  markRecoveryStartup,
  reconcileRecoverySessionsOnStartup,
  getRecoveryStatusSnapshot,
} from '@/services/recovery';
import { buildAnomalyFingerprint } from '@/services/anomaly';
import {
  startWorkerReturnPipeServer,
  mapWorkerEventToSocket,
} from '@/infrastructure/worker';
import { handleWorkerReturnPrintEvent } from '@/services/worker-print-lifecycle';
import { translateHardwarePrinterError } from '@/services/printer-error-translation';
import {
  powerSafetyService,
  type WorkerPowerEvent,
} from '@/services/power-safety';
import { getLocalIPv4 } from '@/utils/network';
import { validateAdminSession } from '@/utils/admin-session';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const sessionIo = io.of('/session');

type StartupPhase = 'booting' | 'ready' | 'failed';

interface StartupReadinessState {
  phase: StartupPhase;
  startedAt: string;
  readyAt: string | null;
  failedAt: string | null;
  message: string | null;
}

const STARTUP_POLL_INTERVAL_MS = 1_500;

const startupReadinessState: StartupReadinessState = {
  phase: 'booting',
  startedAt: new Date().toISOString(),
  readyAt: null,
  failedAt: null,
  message: 'Starting PrintBit services…',
};

function markStartupReady(): void {
  startupReadinessState.phase = 'ready';
  startupReadinessState.readyAt = new Date().toISOString();
  startupReadinessState.failedAt = null;
  startupReadinessState.message = null;
}

function markStartupFailed(message: string): void {
  startupReadinessState.phase = 'failed';
  startupReadinessState.failedAt = new Date().toISOString();
  startupReadinessState.message = message;
}

function getStartupReadinessSnapshot() {
  return {
    ready: startupReadinessState.phase === 'ready',
    phase: startupReadinessState.phase,
    startedAt: startupReadinessState.startedAt,
    readyAt: startupReadinessState.readyAt,
    failedAt: startupReadinessState.failedAt,
    message: startupReadinessState.message,
    retryAfterMs:
      startupReadinessState.phase === 'failed'
        ? Math.max(STARTUP_POLL_INTERVAL_MS, 5_000)
        : STARTUP_POLL_INTERVAL_MS,
  };
}

app.get('/loading', (_req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.resolve(PUBLIC_DIR, 'loading', 'index.html'));
});

app.get('/api/startup/ready', (_req, res) => {
  const snapshot = getStartupReadinessSnapshot();
  const statusCode = snapshot.ready ? 200 : 503;
  res.status(statusCode).json(snapshot);
});

app.get('/api/power-safety/status', (_req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  res.json(powerSafetyService.getEffectiveEvent());
});

app.use(cookieParser());

const sessionStore = new SessionStore(UPLOAD_DIR, {
  expiryEnabled: SESSION_EXPIRY_ENABLED,
});

installSocketAccessMiddleware(io, sessionIo, {
  isKioskCredential: (credential) =>
    kioskAccessService.isKioskCredential(credential),
  isLoopbackAddress: (address) => {
    if (!address) return false;
    const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
    return (
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip === 'localhost'
    );
  },
  isAdminSession: validateAdminSession,
  claimSessionOwner: (sessionId, token, clientId) =>
    sessionStore.claimOwner(sessionId, token, clientId).ok,
});

sessionIo.on('connection', (socket) => {
  const principal = socket.data.principal as SocketPrincipal | undefined;
  if (principal?.kind !== 'session') {
    socket.disconnect(true);
    return;
  }

  socket.join(`session:${principal.sessionId}`);
});

app.use(express.json());
app.use(createCsrfProtectionMiddleware());

// Captive-portal middleware — fallback for direct captive probes on port 3000
if (CAPTIVE_PORTAL_ENABLED) {
  app.use(createCaptivePortalMiddleware());
}

const paymentAcceptorGate = new PaymentAcceptorGate({
  armCustomerPayment: () => hardwareStateProjection.armCustomerPayment(),
  disarmCustomerPayment: (reason) =>
    hardwareStateProjection.disarmCustomerPayment(reason),
  canAcceptCustomerWork: () => powerSafetyService.canAcceptCustomerWork(),
  isPrinterReady: () => {
    const telemetry = getPrinterTelemetry();
    return telemetry.connected && !BLOCKED_STATUSES.has(telemetry.status);
  },
  isSerialConnected: () => getSerialStatus().connected,
  getBalance: () => db.data?.balance ?? 0,
});

registerAppModules(app, {
  io,
  sessionIo,
  sessionStore,
  uploadDir: UPLOAD_DIR,
  getSerialStatus,
  getHopperStatus,
  runHopperSelfTest: async () => {
    const result = await runHopperSelfTest();
    return {
      ...result,
      amount: result.dispensedCoins,
    };
  },
  resolvePublicBaseUrl,
  convertToPdfArtifact,
  paymentAcceptorGate,
});

io.on('connection', (socket) => {
  registerControlSocketHandlers(socket, {
    io,
    sessionStore,
    powerSafetyService,
  });
});

async function startHttpServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.listen(PORT, '0.0.0.0', () => {
      const localIP = getLocalIPv4();
      if (localIP) {
        console.log(`[BOOT] HTTP server ready: http://${localIP}:${PORT}`);
      } else {
        console.log(`[BOOT] HTTP server ready on port ${PORT}`);
      }
      resolve();
    });
    server.once('error', reject);
  });
}

async function initializePrintBit(): Promise<void> {
  try {
    await initDB();

    // Capture the handle so we can await readiness before continuing startup.
    // This guarantees the named pipe is open and accepting connections from
    // the C# worker before any downstream service tries to use it.
    const workerReturnPipe = startWorkerReturnPipeServer({
      pipeName: WORKER_RETURN_PIPE_NAME,
      maxBytes: WORKER_RETURN_MAX_BYTES,
      onEvent: (evt) => {
        if (
          evt.type === 'PowerStatusChanged' ||
          evt.type === 'PowerStatusSnapshot'
        ) {
          powerSafetyService.applyWorkerPowerEvent(evt as WorkerPowerEvent);
        }

        const mapped = mapWorkerEventToSocket(evt);
        if (mapped.event === 'workerPowerStatusChanged') {
          io.emit(
            'workerPowerStatusChanged',
            powerSafetyService.getEffectiveEvent(),
          );
        } else {
          io.emit(mapped.event, mapped.payload);
        }

        if (evt.type === 'PrinterOffline') {
          void paymentAcceptorGate.disarmForSafety('printer_unavailable');
          io.emit('printerMalfunction', {
            printError: {
              code: 'PRINTER_OFFLINE',
              severity: 'fatal',
              userMessage:
                'The printer is offline. Please check the connection.',
              hint: evt.message ?? null,
              canRetry: false,
              canDismiss: false,
            },
          });
        }

        if (evt.type === 'PrinterOnline') {
          io.emit('printerStatusRestored', {
            printerName: evt.printerName ?? null,
            timestamp: evt.timestampUtc,
          });
        }

        // Hardware errors are distinct from offline/online transitions: the
        // printer is reachable but WMI reports a non-zero DetectedErrorState
        // (paper jam, ink empty, door open, etc.).  Emit a dedicated
        // printerMalfunction so the UI can surface the right message.
        //
        // We translate the worker's generic `PrinterError` message into a
        // more specific code/severity so the confirm page can offer
        // Pause/Resume for paper-related conditions (the kiosk's primary
        // recovery action) instead of always showing a fatal-staff-help
        // modal. The worker formats the message as:
        //   "Printer hardware error detected (<Description>, code <N>). ..."
        if (evt.type === 'PrinterError') {
          void paymentAcceptorGate.disarmForSafety('printer_unavailable');
          const translated = translateHardwarePrinterError({
            message: evt.errorMessage ?? evt.message ?? null,
            errorCode: evt.errorCode ?? null,
          });
          io.emit('printerMalfunction', {
            printError: {
              code: translated.code,
              severity: translated.severity,
              userMessage: translated.userMessage,
              hint: evt.errorMessage ?? evt.message ?? null,
              canRetry: translated.canRetry,
              canDismiss: translated.canDismiss,
              spoolerCorrelationKey: evt.spoolerCorrelationKey ?? null,
            },
            transactionId: evt.transactionId ?? null,
            spoolerCorrelationKey: evt.spoolerCorrelationKey ?? null,
          });
        }

        void handleWorkerReturnPrintEvent({
          evt,
          io,
          sessionStore,
        }).catch((error) => {
          console.error(
            '[WORKER_RETURN_PIPE] Failed to process worker event.',
            {
              error: error instanceof Error ? error.message : String(error),
              eventType: evt.type,
              transactionId: evt.transactionId ?? null,
            },
          );
        });
      },
    });

    // Block until the named pipe is listening.  If the bind fails (e.g. the
    // pipe is already held by a stale process) this throws and startup is
    // marked failed — preventing the kiosk from running without a working IPC
    // channel to the C# hardware service.
    await workerReturnPipe.ready;
    await hardwareStateProjection.initializeCustomerPaymentLock();

    const startupMarker = await markRecoveryStartup('server_start');
    const startupTrustedTime = await verifyTrustedClockSync();
    const recoverySummary = await reconcileRecoverySessionsOnStartup();
    const recoveryStatus = getRecoveryStatusSnapshot();
    if (
      startupMarker.unexpectedRestart ||
      recoverySummary.processedSessions > 0
    ) {
      void adminService
        .appendAdminLog(
          startupMarker.unexpectedRestart
            ? 'unexpected_restart_detected'
            : 'startup_reconciliation_completed',
          startupMarker.unexpectedRestart
            ? 'Unplanned restart detected during startup; recovery reconciliation executed.'
            : 'Startup recovery reconciliation executed.',
          {
            unexpectedRestart: startupMarker.unexpectedRestart,
            processedSessions: recoverySummary.processedSessions,
            resolvedSessions: recoverySummary.resolvedSessions,
            unresolvedSessions: recoverySummary.unresolvedSessions,
            autoRefundedSessions: recoverySummary.autoRefundedSessions,
            pendingAdminReviewSessions:
              recoverySummary.pendingAdminReviewSessions,
            trustedTimeBlockedSessions:
              recoverySummary.trustedTimeBlockedSessions,
            bootCount: recoveryStatus.lifecycle.bootCount,
            unexpectedRestartCount:
              recoveryStatus.lifecycle.unexpectedRestartCount,
          },
        )
        .catch((error) => {
          console.error(
            '[RECOVERY] Failed to append startup recovery admin log.',
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
        });
    }
    if (startupMarker.unexpectedRestart) {
      void anomalyService
        .report({
          type: 'unexpected_restart_detected',
          source: 'recovery',
          category: 'security',
          severity: 'critical',
          message:
            'Unplanned restart detected. Startup recovery reconciliation has been executed.',
          fingerprint: buildAnomalyFingerprint([
            'recovery',
            'unexpected-restart',
          ]),
          context: {
            processedSessions: recoverySummary.processedSessions,
            unresolvedSessions: recoverySummary.unresolvedSessions,
            autoRefundedSessions: recoverySummary.autoRefundedSessions,
            pendingAdminReviewSessions:
              recoverySummary.pendingAdminReviewSessions,
          },
        })
        .catch((error) => {
          console.error(
            '[RECOVERY] Failed to report unexpected restart anomaly.',
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
        });
    }
    const startupBlocked =
      startupTrustedTime.enforceForFinancial &&
      (!startupTrustedTime.synced ||
        startupTrustedTime.offsetMs === null ||
        startupTrustedTime.driftExceeded);
    void adminService
      .appendAdminLog(
        startupBlocked ? 'trusted_time_unsynced' : 'trusted_time_synced',
        startupBlocked
          ? 'Trusted time unavailable at startup. Financial operations are blocked until synchronization recovers.'
          : 'Trusted time verified at startup.',
        {
          synced: startupTrustedTime.synced,
          offsetMs: startupTrustedTime.offsetMs,
          driftExceeded: startupTrustedTime.driftExceeded,
          maxDriftMs: startupTrustedTime.maxDriftMs,
          source: startupTrustedTime.source,
          enforceForFinancial: startupTrustedTime.enforceForFinancial,
          detail: startupTrustedTime.detail,
          ntpSource: startupTrustedTime.ntpSource,
        },
      )
      .catch((error) => {
        console.error(
          '[TIME] Failed to append startup trusted-time admin log.',
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    if (startupBlocked) {
      void anomalyService
        .report({
          type: 'trusted_time_unsynced',
          source: 'time-sync',
          category: 'network',
          severity: 'critical',
          message:
            'Trusted time verification failed. Financial operations are blocked until synchronization recovers.',
          fingerprint: buildAnomalyFingerprint([
            'time-sync',
            'trusted-time-unsynced',
          ]),
          context: {
            offsetMs: startupTrustedTime.offsetMs,
            driftExceeded: startupTrustedTime.driftExceeded,
            maxDriftMs: startupTrustedTime.maxDriftMs,
            detail: startupTrustedTime.detail,
          },
        })
        .catch((error) => {
          console.error(
            '[TIME] Failed to report startup trusted-time anomaly.',
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
        });
    }
    const jobProcessor = getJobProcessor();
    jobProcessor.setIo(io);
    await jobProcessor.init();

    // Run independent hardware and network subsystem probes concurrently to minimize startup latency
    await Promise.allSettled([
      (async () => {
        await detectDefaultPrinter();
      })(),
      (async () => {
        await detectScanner();
        await cleanupTransientFilesOnStartup(UPLOAD_DIR).catch((error) => {
          console.error(
            '[STARTUP] Failed to clean up transient files on startup.',
            {
              uploadDir: UPLOAD_DIR,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        });
        startScanStorageCleanup();
      })(),
      (async () => {
        await initSerial(io);
        await runHopperSelfTest();
      })(),
      startHotspot(),
    ]);

    startWatchdogHealthMonitor({
      getSerialStatus,
      getPrinterTelemetry,
      isHotspotRunning,
    });
    anomalyService.setSocketIo(io);
    let trustedTimeBlocked = startupBlocked;
    startTrustedTimeMonitor(async (status) => {
      const blocked =
        status.enforceForFinancial &&
        (!status.synced || status.offsetMs === null || status.driftExceeded);
      if (blocked === trustedTimeBlocked) return;
      try {
        if (blocked) {
          await adminService.appendAdminLog(
            'trusted_time_unsynced',
            'Trusted time lost during runtime. Financial operations are now blocked.',
            {
              synced: status.synced,
              offsetMs: status.offsetMs,
              driftExceeded: status.driftExceeded,
              maxDriftMs: status.maxDriftMs,
              source: status.source,
              detail: status.detail,
              ntpSource: status.ntpSource,
            },
          );
          await anomalyService.report({
            type: 'trusted_time_unsynced',
            source: 'time-sync',
            category: 'network',
            severity: 'critical',
            message:
              'Trusted time synchronization is unavailable. Financial operations are blocked.',
            fingerprint: buildAnomalyFingerprint([
              'time-sync',
              'trusted-time-unsynced',
            ]),
            context: {
              offsetMs: status.offsetMs,
              driftExceeded: status.driftExceeded,
              maxDriftMs: status.maxDriftMs,
              detail: status.detail,
            },
          });
          trustedTimeBlocked = blocked;
          return;
        }

        await adminService.appendAdminLog(
          'trusted_time_restored',
          'Trusted time synchronization restored. Financial operations are unblocked.',
          {
            synced: status.synced,
            offsetMs: status.offsetMs,
            driftExceeded: status.driftExceeded,
            maxDriftMs: status.maxDriftMs,
            source: status.source,
            detail: status.detail,
            ntpSource: status.ntpSource,
          },
        );
        await anomalyService.report({
          type: 'trusted_time_restored',
          source: 'time-sync',
          category: 'network',
          severity: 'warning',
          message:
            'Trusted time synchronization has been restored. Financial operations are available again.',
          fingerprint: buildAnomalyFingerprint([
            'time-sync',
            'trusted-time-restored',
          ]),
          context: {
            offsetMs: status.offsetMs,
            driftExceeded: status.driftExceeded,
            maxDriftMs: status.maxDriftMs,
            detail: status.detail,
          },
        });
        trustedTimeBlocked = blocked;
      } catch (error) {
        console.error('[TIME] Failed to publish trusted-time transition.', {
          targetState: blocked ? 'blocked' : 'restored',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    await startHotspot();
    markStartupReady();
  } catch (error) {
    const startupErrorMessage =
      error instanceof Error ? error.message : String(error);
    console.error('[SERVER] Startup initialization failed.', {
      error: startupErrorMessage,
    });
    markStartupFailed(
      'Startup initialization failed. Waiting for automatic recovery.',
    );
  }
}

async function start(): Promise<void> {
  await startHttpServer();
  console.log(
    '[BOOT] Express HTTP server listening; /loading and /api/startup/ready are available.',
  );
  void initializePrintBit();
}

let shuttingDown = false;

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SERVER] Received ${signal}. Shutting down gracefully...`);
  stopTrustedTimeMonitor();
  stopWatchdogHealthMonitor();
  try {
    await paymentAcceptorGate.shutdown();
  } catch (error) {
    console.error(
      '[SERVER] Error while shutting down payment acceptor gate.',
      error,
    );
  }
  void markRecoveryShutdown(signal)
    .catch((error) => {
      console.error('[RECOVERY] Failed to write shutdown marker.', {
        error: error instanceof Error ? error.message : String(error),
        signal,
      });
    })
    .finally(() => {
      server.close((error) => {
        if (error) {
          console.error('[SERVER] Error while closing HTTP server.', {
            error: error.message,
          });
          process.exit(1);
        }
        process.exit(0);
      });
    });
}

process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

if (process.env.NODE_ENV !== 'test') {
  void start().catch((error) => {
    const startupErrorMessage =
      error instanceof Error ? error.message : String(error);
    console.error('[SERVER] Fatal startup error.', {
      error: startupErrorMessage,
    });
    markStartupFailed('Server failed to bind. Check startup logs.');
    process.exit(1);
  });
}
