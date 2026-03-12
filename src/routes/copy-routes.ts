import type { Express, Request, Response } from 'express';
import type { Server } from 'socket.io';
import { jobStore } from '../services/job-store';
import { printFile, type PrintJobOptions } from '../services/printer';
import {
  db,
  acquireIdempotencyKey,
  storeIdempotencyKey,
  releaseIdempotencyKey,
} from '../services/db';
import { adminService } from '../services/admin';
import path from 'node:path';
import fs from 'node:fs';
import {
  getPrinterTelemetry,
  settlementService,
  watchJobForMalfunction,
} from '@/services';
import { BLOCKED_STATUSES } from '@/utils';

const VALID_COLOR_MODES = new Set(['colored', 'grayscale']);
const VALID_ORIENTATIONS = new Set(['portrait', 'landscape']);
const VALID_PAPER_SIZES = new Set(['A4', 'Letter', 'Legal']);

export function registerCopyRoutes(app: Express, deps: { io: Server }): void {
  // ── POST /api/copy/jobs — Start a copy job (print checked scan, then charge) ─
  app.post('/api/copy/jobs', async (req: Request, res: Response) => {
    // ── Idempotency guard ──────────────────────────────────────────────
    // The key is claimed (or waits) BEFORE any side effects so that two
    // simultaneous requests with the same key cannot both create jobs.
    const idempotencyKey = req.get('Idempotency-Key') ?? '';
    let idempotencyClaimed = false;
    if (idempotencyKey) {
      const slot = acquireIdempotencyKey(idempotencyKey, 'POST:/api/copy/jobs');
      if (slot.type === 'hit') {
        res.status(slot.entry.statusCode).json(slot.entry.response);
        return;
      }
      if (slot.type === 'inflight') {
        const entry = await slot.promise;
        if (entry) {
          res.status(entry.statusCode).json(entry.response);
        } else {
          res
            .status(503)
            .json({ error: 'Concurrent request failed. Please retry.' });
        }
        return;
      }
      // type === "claimed": this call owns the slot
      idempotencyClaimed = true;
    }

    const { copies, colorMode, orientation, paperSize, amount, previewPath } =
      req.body as {
        copies?: number;
        colorMode?: string;
        orientation?: string;
        paperSize?: string;
        amount?: number;
        previewPath?: string;
      };

    const safeCopies =
      typeof copies === 'number' && Number.isFinite(copies)
        ? Math.max(1, Math.floor(copies))
        : 1;
    const safeColorMode =
      colorMode && VALID_COLOR_MODES.has(colorMode)
        ? (colorMode as 'colored' | 'grayscale')
        : 'grayscale';
    const safeOrientation =
      orientation && VALID_ORIENTATIONS.has(orientation)
        ? (orientation as 'portrait' | 'landscape')
        : 'portrait';
    const safePaperSize =
      paperSize && VALID_PAPER_SIZES.has(paperSize)
        ? (paperSize as 'A4' | 'Letter' | 'Legal')
        : 'A4';
    const safePreviewPath =
      typeof previewPath === 'string' ? previewPath.trim() : '';

    if (!safePreviewPath) {
      const errorBody = {
        error:
          'Missing checked document. Please go back to /copy and tap Check for Document again.',
      };
      if (idempotencyClaimed)
        storeIdempotencyKey(
          idempotencyKey,
          'POST:/api/copy/jobs',
          400,
          errorBody,
        );
      return res.status(400).json(errorBody);
    }

    const previewFilename = path.basename(safePreviewPath);
    if (previewFilename !== safePreviewPath) {
      const errorBody = {
        error: 'Invalid preview path. Please check your document again.',
      };
      if (idempotencyClaimed)
        storeIdempotencyKey(
          idempotencyKey,
          'POST:/api/copy/jobs',
          400,
          errorBody,
        );
      return res.status(400).json(errorBody);
    }

    const previewAbsPath = path.resolve('uploads', 'scans', previewFilename);
    if (!fs.existsSync(previewAbsPath)) {
      const errorBody = {
        error:
          'Checked document not found. Please go back to /copy and scan again.',
      };
      if (idempotencyClaimed)
        storeIdempotencyKey(
          idempotencyKey,
          'POST:/api/copy/jobs',
          409,
          errorBody,
        );
      return res.status(409).json(errorBody);
    }

    const requiredAmount = adminService.calculateJobAmount(
      'copy',
      safeColorMode,
      safeCopies,
    );

    // Pre-check balance (will re-verify inside lock after print succeeds)
    if ((db.data?.balance ?? 0) < requiredAmount) {
      const errorBody = {
        error: 'Insufficient balance',
        balance: db.data?.balance ?? 0,
        requiredAmount,
      };
      void adminService.appendAdminLog(
        'payment_failed',
        'Copy job failed: insufficient balance.',
        {
          balance: db.data?.balance ?? 0,
          requiredAmount,
        },
      );
      // Release so the client can retry once more balance is inserted
      if (idempotencyClaimed)
        releaseIdempotencyKey(idempotencyKey, 'POST:/api/copy/jobs');
      return res.status(400).json(errorBody);
    }

    if (
      typeof amount === 'number' &&
      Number.isFinite(amount) &&
      amount !== requiredAmount
    ) {
      void adminService.appendAdminLog(
        'payment_amount_mismatch',
        'Client amount differed from server pricing.',
        {
          amount,
          requiredAmount,
        },
      );
    }

    const settings = {
      copies: safeCopies,
      colorMode: safeColorMode,
      orientation: safeOrientation,
      paperSize: safePaperSize,
    };

    // Create job with payment pending (charged after successful dispatch)
    const job = jobStore.createCopyJob(settings, null);

    void adminService.appendAdminLog('copy_job_created', 'Copy job created.', {
      jobId: job.id,
      copies: safeCopies,
      colorMode: safeColorMode,
      orientation: safeOrientation,
      paperSize: safePaperSize,
    });

    // Start copy asynchronously — charge AFTER successful print dispatch
    void (async () => {
      jobStore.updateJobState(job.id, 'running');
      try {
        // Preflight: verify printer is ready before dispatching the copy job
        const telemetry = getPrinterTelemetry();
        if (!telemetry.connected || BLOCKED_STATUSES.has(telemetry.status)) {
          void adminService.appendAdminLog(
            'copy_preflight_failed',
            'Copy job rejected: printer not ready.',
            {
              jobId: job.id,
              printerStatus: telemetry.status,
              printerConnected: telemetry.connected,
            },
          );
          jobStore.updateJobState(job.id, 'failed', {
            failure: {
              code: 'PRINTER_NOT_READY',
              message: `Printer is not ready: ${telemetry.status}. Please notify the operator.`,
              retryable: true,
              stage: 'precheck',
            },
          });
          return;
        }

        const printOptions: PrintJobOptions = {
          copies: safeCopies,
          colorMode: safeColorMode,
          orientation: safeOrientation,
          paperSize: safePaperSize,
        };
        const relPath = path.join('scans', previewFilename);
        await printFile(relPath, printOptions);

        // Start mid-job watchdog. Polls printer status every 3 s for 30 s
        // post-dispatch and emits printerMalfunction if the printer faults.
        // Fire-and-forget — does not block settlement.
        void watchJobForMalfunction(deps.io);

        const settlement = await settlementService.settle({
          requiredAmount,
          io: deps.io,
          jobContext: {
            mode: 'copy',
            jobId: job.id,
            copies: safeCopies,
            colorMode: safeColorMode,
          },
        });

        if (settlement.ok) {
          job.payment = {
            chargedAmount: settlement.chargedAmount,
            remainingBalance: settlement.remainingBalance,
          };
          jobStore.updateJobState(job.id, 'succeeded');
          await adminService.incrementJobStats('copy');
          void adminService.appendAdminLog(
            'copy_job_completed',
            'Copy job completed and charged.',
            {
              jobId: job.id,
              chargedAmount: settlement.chargedAmount,
              remainingBalance: settlement.remainingBalance,
              changeState: settlement.change.state,
              changeRequested: settlement.change.requested,
              changeDispensed: settlement.change.dispensed,
            },
          );
        } else {
          jobStore.updateJobState(job.id, 'failed', {
            failure: {
              code: 'COPY_ERROR',
              message:
                settlement.error ??
                'Balance drained before charge could complete.',
              retryable: false,
              stage: 'running',
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        jobStore.updateJobState(job.id, 'failed', {
          failure: {
            code: 'COPY_ERROR',
            message,
            retryable: true,
            stage: 'running',
          },
        });
        void adminService.appendAdminLog(
          'copy_job_failed',
          'Copy job failed — balance NOT charged.',
          {
            jobId: job.id,
            error: message,
          },
        );
      }
    })();

    // Deep-clone the response body so the cached idempotency entry is not
    // mutated by later jobStore state updates (e.g. state → "running"/"succeeded").
    const responseBody = JSON.parse(JSON.stringify(job)) as typeof job;
    if (idempotencyClaimed) {
      storeIdempotencyKey(
        idempotencyKey,
        'POST:/api/copy/jobs',
        201,
        responseBody,
      );
    }
    res.status(201).json(responseBody);
  });

  // ── GET /api/copy/jobs/:id — Get copy job status ───────────────────
  app.get('/api/copy/jobs/:id', (req: Request, res: Response) => {
    const job = jobStore.getJob(req.params.id as string);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  });

  // ── POST /api/copy/jobs/:id/cancel — Cancel a copy job ────────────
  app.post('/api/copy/jobs/:id/cancel', (req: Request, res: Response) => {
    const job = jobStore.getJob(req.params.id as string);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const cancelled = jobStore.requestCancel(job.id);
    if (!cancelled) {
      return res
        .status(409)
        .json({ error: 'Job is already in a terminal state' });
    }

    res.status(202).json({ ok: true, state: 'cancel_requested' });
  });
}
