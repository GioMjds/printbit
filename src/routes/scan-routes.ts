import type { Express, Request, Response } from "express";
import { jobStore } from "../services/job-store";
import { getAdapter } from "../services/scanner";
import { appendAdminLog } from "../services/admin";
import path from "node:path";
import fs from "node:fs";

const VALID_SOURCES = new Set(["adf", "flatbed"]);
const VALID_DPI = new Set([150, 300, 600]);
const VALID_COLOR_MODES = new Set(["colored", "grayscale"]);
const VALID_FORMATS = new Set(["pdf", "jpg", "png"]);

const FORMAT_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  png: "image/png",
};

export function registerScanRoutes(app: Express): void {
  // ── POST /api/scan/jobs — Start a scan job ─────────────────────────
  app.post("/api/scan/jobs", async (req: Request, res: Response) => {
    const { source, dpi, colorMode, duplex, format } = req.body as {
      source?: string;
      dpi?: number;
      colorMode?: string;
      duplex?: boolean;
      format?: string;
    };

    if (!source || !VALID_SOURCES.has(source)) {
      return res
        .status(400)
        .json({ error: 'Invalid source. Accepted: "adf", "flatbed"' });
    }
    if (typeof dpi !== "number" || !VALID_DPI.has(dpi)) {
      return res
        .status(400)
        .json({ error: "Invalid dpi. Accepted: 150, 300, 600" });
    }
    if (!colorMode || !VALID_COLOR_MODES.has(colorMode)) {
      return res
        .status(400)
        .json({ error: 'Invalid colorMode. Accepted: "colored", "grayscale"' });
    }
    if (typeof duplex !== "boolean") {
      return res.status(400).json({ error: "duplex must be a boolean" });
    }
    if (!format || !VALID_FORMATS.has(format)) {
      return res
        .status(400)
        .json({ error: 'Invalid format. Accepted: "pdf", "jpg", "png"' });
    }

    const settings = {
      source: source as "adf" | "flatbed",
      dpi,
      colorMode: colorMode as "colored" | "grayscale",
      duplex,
      format: format as "pdf" | "jpg" | "png",
    };

    const job = jobStore.createScanJob(settings);

    void appendAdminLog("scan_job_created", "Scan job created.", {
      jobId: job.id,
      source,
      dpi,
      colorMode,
      format,
    });

    // Start scan asynchronously
    void (async () => {
      jobStore.updateJobState(job.id, "running");
      try {
        const result = await getAdapter().scan(settings, "uploads/scans");
        jobStore.updateJobState(job.id, "succeeded", {
          resultPath: result.outputPath,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        jobStore.updateJobState(job.id, "failed", {
          failure: {
            code: "SCAN_ERROR",
            message,
            retryable: true,
            stage: "running",
          },
        });
      }
    })();

    res.status(201).json(job);
  });

  // ── GET /api/scan/jobs/:id — Get scan job status ───────────────────
  app.get("/api/scan/jobs/:id", (req: Request, res: Response) => {
    const job = jobStore.getJob(req.params.id as string);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  // ── GET /api/scan/jobs/:id/result — Download scan result ───────────
  app.get("/api/scan/jobs/:id/result", (req: Request, res: Response) => {
    const job = jobStore.getJob(req.params.id as string);
    if (!job || job.type !== "scan") {
      return res.status(404).json({ error: "Job not found" });
    }

    if (job.state !== "succeeded" || !job.resultPath) {
      return res.status(409).json({ error: "Scan result is not ready" });
    }

    const absPath = path.resolve(job.resultPath);
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: "Result file not found on disk" });
    }

    const contentType =
      FORMAT_CONTENT_TYPES[job.settings.format] ?? "application/octet-stream";
    const filename = path.basename(absPath);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    fs.createReadStream(absPath).pipe(res);
  });

  // ── POST /api/scan/preview — Quick preview scan for document detection ──
  app.post("/api/scan/preview", async (_req: Request, res: Response) => {
    console.log("[SCAN-PREVIEW] Starting copy pre-scan (300 DPI color)…");

    const previewSettings = {
      source: "flatbed" as const,
      dpi: 300,
      colorMode: "colored" as const,
      duplex: false,
      format: "pdf" as const,
    };

    try {
      const result = await getAdapter().scan(previewSettings, "uploads/scans");

      // Check the output file has meaningful content (> 1 KB suggests a real scan)
      const absPath = path.resolve(result.outputPath);
      const stat = fs.statSync(absPath);
      console.log(
        `[SCAN-PREVIEW] ✓ Preview scan complete: ${absPath} (${stat.size} bytes)`,
      );

      const filename = path.basename(result.outputPath);
      res.json({
        detected: true,
        previewPath: filename,
        pageCount: result.pageCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[SCAN-PREVIEW] ✗ Preview scan failed: ${message}`);

      void appendAdminLog("scan_preview_failed", "Preview scan failed.", {
        error: message,
      });
      res.json({
        detected: false,
        error:
          "No document detected. Place your document face-down on the scanner glass and try again.",
      });
    }
  });

  // ── GET /api/scan/preview/:filename — Serve preview scan files ─────
  app.get("/api/scan/preview/:filename", (req: Request, res: Response) => {
    const filename = path.basename(req.params.filename as string);
    const absPath = path.resolve("uploads", "scans", filename);

    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: "Preview file not found" });
    }

    const ext = path.extname(filename).toLowerCase().replace(".", "");
    const contentType = FORMAT_CONTENT_TYPES[ext] ?? "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    fs.createReadStream(absPath).pipe(res);
  });

  // ── POST /api/scan/jobs/:id/cancel — Cancel a scan job ────────────
  app.post("/api/scan/jobs/:id/cancel", (req: Request, res: Response) => {
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

    getAdapter().cancel();
    res.status(202).json({ ok: true, state: "cancel_requested" });
  });
}
