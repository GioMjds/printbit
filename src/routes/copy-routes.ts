import type { Express, Request, Response } from "express";
import type { Server } from "socket.io";
import { jobStore } from "../services/job-store";
import { printFile, type PrintJobOptions } from "../services/printer";
import {
  db,
  withBalanceLock,
  checkIdempotencyKey,
  markIdempotencyKeyInFlight,
  storeIdempotencyKey,
} from "../services/db";
import {
  appendAdminLog,
  calculateJobAmount,
  incrementJobStats,
} from "../services/admin";
import path from "node:path";
import fs from "node:fs";

const VALID_COLOR_MODES = new Set(["colored", "grayscale"]);
const VALID_ORIENTATIONS = new Set(["portrait", "landscape"]);
const VALID_PAPER_SIZES = new Set(["A4", "Letter", "Legal"]);

const COPY_IDEMPOTENCY_NS = "POST:/api/copy/jobs";

export function registerCopyRoutes(app: Express, deps: { io: Server }): void {
  // ── POST /api/copy/jobs — Start a copy job (print checked scan, then charge) ─
  app.post("/api/copy/jobs", async (req: Request, res: Response) => {
    // ── Idempotency guard ──────────────────────────────────────────────
    const idempotencyKey = req.get("Idempotency-Key") ?? "";
    if (idempotencyKey) {
      const cached = checkIdempotencyKey(idempotencyKey, COPY_IDEMPOTENCY_NS);
      if (cached) {
        if (cached.inFlight) {
          res.status(409).json({ error: "A request with this Idempotency-Key is already in progress" });
          return;
        }
        res.status(cached.statusCode).json(cached.response);
        return;
      }
      // Reserve the slot synchronously before any await so concurrent
      // duplicates see "in-flight" and receive 409 instead of racing.
      markIdempotencyKeyInFlight(idempotencyKey, COPY_IDEMPOTENCY_NS);
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
      typeof copies === "number" && Number.isFinite(copies)
        ? Math.max(1, Math.floor(copies))
        : 1;
    const safeColorMode =
      colorMode && VALID_COLOR_MODES.has(colorMode)
        ? (colorMode as "colored" | "grayscale")
        : "grayscale";
    const safeOrientation =
      orientation && VALID_ORIENTATIONS.has(orientation)
        ? (orientation as "portrait" | "landscape")
        : "portrait";
    const safePaperSize =
      paperSize && VALID_PAPER_SIZES.has(paperSize)
        ? (paperSize as "A4" | "Letter" | "Legal")
        : "A4";
    const safePreviewPath =
      typeof previewPath === "string" ? previewPath.trim() : "";

    if (!safePreviewPath) {
      return res.status(400).json({
        error:
          "Missing checked document. Please go back to /copy and tap Check for Document again.",
      });
    }

    const previewFilename = path.basename(safePreviewPath);
    if (previewFilename !== safePreviewPath) {
      return res.status(400).json({
        error: "Invalid preview path. Please check your document again.",
      });
    }

    const previewAbsPath = path.resolve("uploads", "scans", previewFilename);
    if (!fs.existsSync(previewAbsPath)) {
      return res.status(409).json({
        error:
          "Checked document not found. Please go back to /copy and scan again.",
      });
    }

    const requiredAmount = calculateJobAmount(
      "copy",
      safeColorMode,
      safeCopies,
    );

    // Pre-check balance (will re-verify inside lock after print succeeds)
    if ((db.data?.balance ?? 0) < requiredAmount) {
      void appendAdminLog(
        "payment_failed",
        "Copy job failed: insufficient balance.",
        {
          balance: db.data?.balance ?? 0,
          requiredAmount,
        },
      );
      return res.status(400).json({
        error: "Insufficient balance",
        balance: db.data?.balance ?? 0,
        requiredAmount,
      });
    }

    if (
      typeof amount === "number" &&
      Number.isFinite(amount) &&
      amount !== requiredAmount
    ) {
      void appendAdminLog(
        "payment_amount_mismatch",
        "Client amount differed from server pricing.",
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

    void appendAdminLog("copy_job_created", "Copy job created.", {
      jobId: job.id,
      copies: safeCopies,
      colorMode: safeColorMode,
      orientation: safeOrientation,
      paperSize: safePaperSize,
    });

    // Start copy asynchronously — charge AFTER successful print dispatch
    void (async () => {
      jobStore.updateJobState(job.id, "running");
      try {
        const printOptions: PrintJobOptions = {
          copies: safeCopies,
          colorMode: safeColorMode,
          orientation: safeOrientation,
          paperSize: safePaperSize,
        };
        const relPath = path.join("scans", previewFilename);
        await printFile(relPath, printOptions);

        // Print succeeded — charge balance inside the lock
        const newBalance = await withBalanceLock(async () => {
          if ((db.data?.balance ?? 0) < requiredAmount) {
            // Rare edge: balance was spent between pre-check and print completion
            void appendAdminLog(
              "payment_failed",
              "Copy charge failed post-print: balance drained.",
              {
                jobId: job.id,
                balance: db.data?.balance ?? 0,
                requiredAmount,
              },
            );
            return null;
          }
          db.data!.balance -= requiredAmount;
          db.data!.earnings += requiredAmount;
          await db.write();
          deps.io.emit("balance", db.data!.balance);
          return db.data!.balance;
        });

        job.payment = {
          chargedAmount: requiredAmount,
          remainingBalance: newBalance ?? db.data!.balance,
        };

        jobStore.updateJobState(job.id, "succeeded");
        await incrementJobStats("copy");
        void appendAdminLog(
          "copy_job_completed",
          "Copy job completed and charged.",
          {
            jobId: job.id,
            chargedAmount: requiredAmount,
            remainingBalance: newBalance ?? db.data!.balance,
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        jobStore.updateJobState(job.id, "failed", {
          failure: {
            code: "COPY_ERROR",
            message,
            retryable: true,
            stage: "running",
          },
        });
        void appendAdminLog(
          "copy_job_failed",
          "Copy job failed — balance NOT charged.",
          {
            jobId: job.id,
            error: message,
          },
        );
      }
    })();

    const responseBody = JSON.parse(JSON.stringify(job)) as unknown;
    if (idempotencyKey) {
      storeIdempotencyKey(idempotencyKey, COPY_IDEMPOTENCY_NS, 201, responseBody);
    }
    res.status(201).json(responseBody);
  });

  // ── GET /api/copy/jobs/:id — Get copy job status ───────────────────
  app.get("/api/copy/jobs/:id", (req: Request, res: Response) => {
    const job = jobStore.getJob(req.params.id as string);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  // ── POST /api/copy/jobs/:id/cancel — Cancel a copy job ────────────
  app.post("/api/copy/jobs/:id/cancel", (req: Request, res: Response) => {
    const job = jobStore.getJob(req.params.id as string);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const cancelled = jobStore.requestCancel(job.id);
    if (!cancelled) {
      return res
        .status(409)
        .json({ error: "Job is already in a terminal state" });
    }

    res.status(202).json({ ok: true, state: "cancel_requested" });
  });
}
