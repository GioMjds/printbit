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
  installSocketAccessMiddleware,
  type SocketPrincipal,
} from '@/middleware/socket-access';
import { registerAppModules } from '@/app.module';
import { getJobProcessor } from '@/modules/print-queue';
import { initDB } from '@/core/database/db';
import { transactionReconciliationService } from '@/services/transaction-reconciliation';
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
import { db, type LogMeta } from '@/services/db';
import { registerControlSocketHandlers } from '@/services/control-socket';
import { isHotspotRunning, startHotspot } from '@/services/hotspot';
import { SessionStore, resolvePublicBaseUrl } from '@/services/session';
import { scannerService } from '@/services/scanner';
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
  type WorkerPrintEvent,
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

export const STARTUP_T0 = performance.now();

export function markStartup(label: string): void {
  const elapsed = Math.round(performance.now() - STARTUP_T0);
  console.log(`[STARTUP +${elapsed}ms] ${label}`);
}

markStartup('Express application and socket servers initialized');

type StartupPhase = 'booting' | 'ready' | 'failed';

export interface SubsystemStatuses {
  webServer: 'ready';
  database: 'ready' | 'initializing' | 'failed';
  worker: 'ready' | 'connecting' | 'failed';
  printer: 'ready' | 'initializing' | 'offline';
  scanner: 'ready' | 'initializing' | 'unavailable';
  esp32: 'ready' | 'connecting' | 'failed';
  trustedTime: 'synced' | 'unsynced' | 'verifying';
}

interface StartupReadinessState {
  phase: StartupPhase;
  startedAt: string;
  readyAt: string | null;
  failedAt: string | null;
  message: string | null;
  subsystems: SubsystemStatuses;
}

const STARTUP_POLL_INTERVAL_MS = 1_500;

const startupReadinessState: StartupReadinessState = {
  phase: 'booting',
  startedAt: new Date().toISOString(),
  readyAt: null,
  failedAt: null,
  message: 'Starting PrintBit services…',
  subsystems: {
    webServer: 'ready',
    database: 'initializing',
    worker: 'connecting',
    printer: 'initializing',
    scanner: 'initializing',
    esp32: 'connecting',
    trustedTime: 'verifying',
  },
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
    subsystems: { ...startupReadinessState.subsystems },
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

function logWorkerEventToAdmin(evt: WorkerPrintEvent): void {
  const meta: LogMeta = {
    source: 'Worker',
    transactionId: evt.transactionId ?? null,
    spoolerJobId: evt.spoolerJobId ?? null,
    spoolerCorrelationKey: evt.spoolerCorrelationKey ?? null,
    printerName: evt.printerName ?? null,
    failureStage: evt.failureStage ?? null,
    errorCode: evt.errorCode ?? null,
  };

  switch (evt.type) {
    case 'PrinterOffline':
      void adminService.appendAdminLog(
        'printer_offline',
        evt.message ?? `Printer "${evt.printerName ?? 'Default'}" went offline.`,
        meta,
      );
      break;
    case 'PrinterOnline':
      void adminService.appendAdminLog(
        'printer_online',
        evt.message ?? `Printer "${evt.printerName ?? 'Default'}" is online.`,
        meta,
      );
      break;
    case 'PrinterError':
      void adminService.appendAdminLog(
        'printer_error',
        evt.errorMessage ?? evt.message ?? 'Printer hardware error detected.',
        meta,
      );
      break;
    case 'PrintStarted':
      void adminService.appendAdminLog(
        'worker_print_started',
        evt.message ?? `Print job started for file "${evt.fileName ?? 'unknown'}".`,
        meta,
      );
      break;
    case 'PrintSucceeded':
      void adminService.appendAdminLog(
        'worker_print_succeeded',
        evt.message ?? `Print job completed successfully (${evt.pagesPrinted ?? evt.totalPages ?? 0} pages).`,
        meta,
      );
      break;
    case 'PrintFailed':
      void adminService.appendAdminLog(
        'worker_print_failed',
        evt.errorMessage ?? evt.message ?? `Print job failed at stage ${evt.failureStage ?? 'unknown'}.`,
        meta,
      );
      break;
    case 'JobPaused':
      void adminService.appendAdminLog(
        'worker_job_paused',
        evt.message ?? 'Print job was paused in spooler.',
        meta,
      );
      break;
    case 'JobResumed':
      void adminService.appendAdminLog(
        'worker_job_resumed',
        evt.message ?? 'Print job was resumed in spooler.',
        meta,
      );
      break;
    case 'HardwareStatus':
      void adminService.appendAdminLog(
        'hardware_status',
        evt.message ?? 'Worker hardware status update.',
        meta,
      );
      break;
  }
}

async function connectWorkerPaymentLockWithRetry(
  maxAttempts = 15,
  delayMs = 1_000,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const acknowledged =
        await hardwareStateProjection.initializeCustomerPaymentLock();
      if (acknowledged) {
        startupReadinessState.subsystems.worker = 'ready';
        markStartup(`Worker payment lock acknowledged (attempt ${attempt})`);
        return true;
      }
    } catch {
      // Worker IPC not ready yet; retry
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  startupReadinessState.subsystems.worker = 'failed';
  markStartup(
    'Worker payment lock not acknowledged within startup window; continuing in background',
  );
  return false;
}

async function initializeBackgroundSubsystems(): Promise<void> {
  markStartup('Starting background subsystem initialization');

  // 1. Worker connection and payment lock (non-blocking retry)
  void connectWorkerPaymentLockWithRetry();

  // 2. Hardware probes and network concurrently
  void Promise.allSettled([
    (async () => {
      markStartup('Probing default printer');
      await detectDefaultPrinter();
      const telemetry = getPrinterTelemetry();
      startupReadinessState.subsystems.printer = telemetry.connected
        ? 'ready'
        : 'offline';
      markStartup(`Printer probe complete (connected: ${telemetry.connected})`);
    })(),
    (async () => {
      markStartup('Probing scanner via C# worker');
      await detectScanner();
      const status = scannerService.getStatus();
      startupReadinessState.subsystems.scanner = status.connected
        ? 'ready'
        : 'unavailable';
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
      markStartup(`Scanner probe complete (connected: ${status.connected})`);
    })(),
    (async () => {
      markStartup('Initializing serial and running hopper self-test');
      await initSerial(io);
      await runHopperSelfTest();
      markStartup('Serial and hopper self-test complete');
    })(),
    (async () => {
      markStartup('Starting ESP32 hotspot service');
      await startHotspot();
      startupReadinessState.subsystems.esp32 = isHotspotRunning()
        ? 'ready'
        : 'failed';
      markStartup(`ESP32 hotspot service started (running: ${isHotspotRunning()})`);
    })(),
  ]).then(() => {
    markStartup('All background hardware and network probes completed');
  });

  // 3. Watchdog monitor setup
  startWatchdogHealthMonitor({
    getSerialStatus,
    getPrinterTelemetry,
    isHotspotRunning,
  });
  anomalyService.setSocketIo(io);
  adminService.setSocketIo(io);

  // 4. Trusted time check and monitor (non-blocking background sync)
  void (async () => {
    try {
      markStartup('Verifying trusted clock sync in background');
      const startupTrustedTime = await verifyTrustedClockSync();
      startupReadinessState.subsystems.trustedTime = startupTrustedTime.synced
        ? 'synced'
        : 'unsynced';
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
        .catch(() => {});

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
          .catch(() => {});
      }

      markStartup(
        `Trusted time check complete (synced: ${startupTrustedTime.synced}, offset: ${startupTrustedTime.offsetMs}ms)`,
      );

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
    } catch (error) {
      console.error('[TIME] Background trusted-time verification error.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

async function initializePrintBit(): Promise<void> {
  markStartup('Beginning PrintBit core initialization');
  try {
    markStartup('Initializing SQLite database');
    await initDB();
    startupReadinessState.subsystems.database = 'ready';
    markStartup('SQLite database initialized');

    markStartup('Reconciling transactions and historical data');
    try {
      await transactionReconciliationService.reconcileAll();
      markStartup('Transaction reconciliation completed');
    } catch (reconcileError) {
      console.error('[SERVER] Transaction reconciliation encountered an error:', reconcileError);
    }

    markStartup('Starting worker return pipe server');
    const workerReturnPipe = startWorkerReturnPipeServer({
      pipeName: WORKER_RETURN_PIPE_NAME,
      maxBytes: WORKER_RETURN_MAX_BYTES,
      onEvent: (evt) => {
        logWorkerEventToAdmin(evt);
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
          startupReadinessState.subsystems.printer = 'offline';
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
          startupReadinessState.subsystems.printer = 'ready';
          io.emit('printerStatusRestored', {
            printerName: evt.printerName ?? null,
            timestamp: evt.timestampUtc,
          });
        }

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

    await workerReturnPipe.ready;
    markStartup('Worker return pipe listening');

    markStartup('Reconciling startup recovery state');
    const startupMarker = await markRecoveryStartup('server_start');
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

    markStartup('Initializing job processor');
    const jobProcessor = getJobProcessor();
    jobProcessor.setIo(io);
    await jobProcessor.init();
    markStartup('Job processor ready');

    // Mark kiosk ready now: HTTP, DB, IPC pipe, and job queue are operational.
    markStartupReady();
    markStartup('Core kiosk server is READY (UI accessible)');

    // Launch non-blocking background initialization for worker, hardware, and network subsystems
    void initializeBackgroundSubsystems();
  } catch (error) {
    const startupErrorMessage =
      error instanceof Error ? error.message : String(error);
    console.error('[SERVER] Startup initialization failed.', {
      error: startupErrorMessage,
    });
    markStartupFailed(
      'Startup initialization failed. Waiting for automatic recovery.',
    );
    // Automatic retry after 5s instead of hanging permanently
    setTimeout(() => {
      console.log('[SERVER] Retrying startup initialization...');
      void initializePrintBit();
    }, 5_000);
  }
}

async function start(): Promise<void> {
  markStartup('Starting HTTP listener');
  await startHttpServer();
  markStartup(`HTTP listener online on port ${PORT}`);
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
