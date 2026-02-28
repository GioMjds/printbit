import type { Express, Request, Response } from "express";
import type { Server } from "socket.io";
import { jobStore } from "../services/job-store";
import { printFile, type PrintJobOptions } from "../services/printer";
import { db } from "../services/db";
import { appendAdminLog, calculateJobAmount, incrementJobStats } from "../services/admin";
import path from "node:path";
import fs from "node:fs";

const VALID_COLOR_MODES = new Set(["colored", "grayscale"]);
const VALID_ORIENTATIONS = new Set(["portrait", "landscape"]);
const VALID_PAPER_SIZES = new Set(["A4", "Letter", "Legal"]);

export function registerCopyRoutes(app: Express, deps: { io: Server }): void {
  // ── POST /api/copy/jobs — Start a copy job (charge + print checked scan) ─
  app.post("/api/copy/jobs", async (req: Request, res: Response) => {
    const { copies, colorMode, orientation, paperSize, amount, previewPath } = req.body as {
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
    const safePreviewPath = typeof previewPath === "string" ? previewPath.trim() : "";

    if (!safePreviewPath) {
      return res.status(400).json({
        error: "Missing checked document. Please go back to /copy and tap Check for Document again.",
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
        error: "Checked document not found. Please go back to /copy and scan again.",
      });
    }

    const requiredAmount = calculateJobAmount("copy", safeColorMode, safeCopies);

    if ((db.data?.balance ?? 0) < requiredAmount) {
      void appendAdminLog("payment_failed", "Copy job failed: insufficient balance.", {
        balance: db.data?.balance ?? 0,
        requiredAmount,
      });
      return res.status(400).json({
        error: "Insufficient balance",
        balance: db.data?.balance ?? 0,
        requiredAmount,
      });
    }

    if (typeof amount === "number" && Number.isFinite(amount) && amount !== requiredAmount) {
      void appendAdminLog("payment_amount_mismatch", "Client amount differed from server pricing.", {
        amount,
        requiredAmount,
      });
    }

    // Deduct balance and record earnings
    db.data!.balance -= requiredAmount;
    db.data!.earnings += requiredAmount;
    await db.write();
    deps.io.emit("balance", db.data!.balance);

    const payment = {
      chargedAmount: requiredAmount,
      remainingBalance: db.data!.balance,
    };

    const settings = {
      copies: safeCopies,
      colorMode: safeColorMode,
      orientation: safeOrientation,
      paperSize: safePaperSize,
    };

    const job = jobStore.createCopyJob(settings, payment);

    void appendAdminLog("payment_confirmed", "Copy payment confirmed.", {
      jobId: job.id,
      amount: requiredAmount,
      copies: safeCopies,
      colorMode: safeColorMode,
      remainingBalance: db.data!.balance,
    });

    void appendAdminLog("copy_job_created", "Copy job created.", {
      jobId: job.id,
      copies: safeCopies,
      colorMode: safeColorMode,
      orientation: safeOrientation,
      paperSize: safePaperSize,
    });

    // Start copy asynchronously (print already-checked scan)
    void (async () => {
      jobStore.updateJobState(job.id, "running");
      try {
        // Print phase from the checked-scan file
        const printOptions: PrintJobOptions = {
          copies: safeCopies,
          colorMode: safeColorMode,
          orientation: safeOrientation,
          paperSize: safePaperSize,
        };
        const relPath = path.join("scans", previewFilename);
        await printFile(relPath, printOptions);

        jobStore.updateJobState(job.id, "succeeded");
        await incrementJobStats("copy");
        void appendAdminLog("copy_job_completed", "Copy job completed successfully.", {
          jobId: job.id,
        });
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
        void appendAdminLog("copy_job_failed", "Copy job failed.", {
          jobId: job.id,
          error: message,
        });
      }
    })();

    res.status(201).json(job);
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
      return res.status(409).json({ error: "Job is already in a terminal state" });
    }

    res.status(202).json({ ok: true, state: "cancel_requested" });
  });
}
