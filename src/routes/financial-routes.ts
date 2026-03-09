import type { Express, Request, RequestHandler, Response } from "express";
import path from "node:path";
import type { Server } from "socket.io";
import { db, acquireIdempotencyKey, storeIdempotencyKey, releaseIdempotencyKey } from "../services/db";
import {
  appendAdminLog,
  calculateJobAmount,
  getPricingSettings,
  incrementJobStats,
} from "../services/admin";
import { settlePayment } from "../services/settlement";
import { printFile, type PrintJobOptions } from "../services/printer";
import type { SessionStore } from "../services/session";

interface RegisterFinancialRoutesDeps {
  io: Server;
  sessionStore: SessionStore;
  uploadSingle: RequestHandler;
  resolvePublicBaseUrl: (req: Request) => URL;
}

type PageRangeSelectionPayload =
  | { type: "all" }
  | { type: "custom"; range?: unknown }
  | { type: "single"; page?: unknown };

function normalizeRangeString(raw: string): string | null {
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return null;
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(compact)) return null;

  const chunks = compact.split(",");
  for (const chunk of chunks) {
    if (chunk.includes("-")) {
      const [startRaw, endRaw] = chunk.split("-");
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
      if (start < 1 || end < 1 || start > end) return null;
      continue;
    }

    const page = Number(chunk);
    if (!Number.isInteger(page) || page < 1) return null;
  }

  return compact;
}

function parsePageRange(raw: unknown): { value?: string; error?: string } {
  if (raw == null) return {};

  if (typeof raw === "string") {
    const normalized = normalizeRangeString(raw);
    if (!normalized) {
      return { error: "Invalid page range format" };
    }
    return { value: normalized };
  }

  if (typeof raw !== "object") {
    return { error: "Invalid page range payload" };
  }

  const payload = raw as PageRangeSelectionPayload;
  if (payload.type === "all") return {};

  if (payload.type === "single") {
    const pageRaw = payload.page;
    const page =
      typeof pageRaw === "number" && Number.isFinite(pageRaw)
        ? Math.floor(pageRaw)
        : Number(pageRaw);
    if (!Number.isInteger(page) || page < 1) {
      return { error: "Invalid single page selection" };
    }
    return { value: String(page) };
  }

  if (payload.type === "custom") {
    const normalized = normalizeRangeString(String(payload.range ?? ""));
    if (!normalized) {
      return { error: "Invalid custom page range" };
    }
    return { value: normalized };
  }

  return { error: "Invalid page range payload" };
}

export function registerFinancialRoutes(
  app: Express,
  deps: RegisterFinancialRoutesDeps,
) {
  app.get("/api/balance", (_req: Request, res: Response) => {
    res.json({
      balance: db.data?.balance ?? 0,
      earnings: db.data?.earnings ?? 0,
    });
  });

  app.get("/api/pricing", (_req: Request, res: Response) => {
    res.json(getPricingSettings());
  });

  app.post("/api/balance/reset", async (_req: Request, res: Response) => {
    const previousBalance = db.data!.balance;
    db.data!.balance = 0;
    await db.write();
    deps.io.emit("balance", 0);
    await appendAdminLog("balance_reset", "Balance reset from admin/testing.", {
      previousBalance,
      newBalance: 0,
    });

    res.json({
      ok: true,
      balance: db.data!.balance,
      earnings: db.data!.earnings,
    });
  });

  const ACCEPTED_TEST_COINS = new Set([1, 5, 10, 20]);

  // This route is for testing/demo purposes only, allowing insertion of test coins without real payment processing.
  app.post("/api/balance/add-test-coin", async (req: Request, res: Response) => {
    const { value } = req.body as { value?: unknown };
    const coinValue = typeof value === "number" && Number.isFinite(value) ? value : null;

    if (coinValue === null || !ACCEPTED_TEST_COINS.has(coinValue)) {
      return res.status(400).json({ error: "Invalid coin value. Accepted: 1, 5, 10, 20" });
    }

    db.data!.balance += coinValue;
    await db.write();

    await appendAdminLog("coin_accepted", `Test coin inserted: ${coinValue}`, {
      coinValue,
      balance: db.data!.balance,
      source: "test-ui",
    });

    deps.io.emit("balance", db.data!.balance);
    deps.io.emit("coinAccepted", { value: coinValue, balance: db.data!.balance });

    res.json({
      ok: true,
      coinValue,
      balance: db.data!.balance,
    });
  });


  app.post("/upload", deps.uploadSingle, (req: Request, res: Response) => {
    if (!req.file) {
      void appendAdminLog("upload_failed", "Upload failed: no file provided.");
      return res.status(400).json({ error: "No file uploaded" });
    }

    void appendAdminLog("upload_completed", "Upload completed via /upload.", {
      filename: req.file.originalname,
      storedFilename: req.file.filename,
      sizeBytes: req.file.size,
    });
    res.status(200).json({ filename: req.file.filename });
  });

  app.post("/print", async (req: Request, res: Response) => {
    const { filename } = req.body as { filename?: string };

    if (!filename) {
      void appendAdminLog("print_failed", "Legacy print failed: filename missing.");
      return res.status(400).json({ error: "Filename is required" });
    }

    const minimumAmount = calculateJobAmount("print", "grayscale", 1);
    if ((db.data?.balance ?? 0) < minimumAmount) {
      void appendAdminLog(
        "print_failed",
        "Legacy print failed: insufficient balance.",
        { balance: db.data?.balance ?? 0, required: minimumAmount },
      );
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const defaultOptions: PrintJobOptions = {
      copies: 1,
      colorMode: "grayscale",
      orientation: "portrait",
      paperSize: "A4",
    };

    try {
      await printFile(filename, defaultOptions);
    } catch (err) {
      void appendAdminLog("print_failed", "Legacy print failed: printer error.", {
        filename,
        error: err instanceof Error ? err.message : "Unknown error",
      });
      return res.status(500).json({ error: "Print failed" });
    }

    const chargedAmount = db.data!.balance;
    db.data!.earnings += chargedAmount;
    db.data!.balance = 0;
    await db.write();
    await appendAdminLog("print_completed", "Legacy print completed and charged.", {
      filename,
      chargedAmount,
    });
    await incrementJobStats("print");

    deps.io.emit("balance", 0);
    res.sendStatus(200);
  });

  app.post("/api/confirm-payment", async (req: Request, res: Response) => {
    // ── Idempotency guard ──────────────────────────────────────────────
    // The slot is claimed synchronously BEFORE any side effects so that two
    // concurrent requests with the same key cannot both proceed.
    const idempotencyKey = req.get("Idempotency-Key") ?? "";
    let idempotencyClaimed = false;
    if (idempotencyKey) {
      const slot = acquireIdempotencyKey(idempotencyKey, "POST:/api/confirm-payment");
      if (slot.type === "hit") {
        res.status(slot.entry.statusCode).json(slot.entry.response);
        return;
      }
      if (slot.type === "inflight") {
        const entry = await slot.promise;
        if (entry) {
          res.status(entry.statusCode).json(entry.response);
        } else {
          res.status(503).json({ error: "Concurrent request failed. Please retry." });
        }
        return;
      }
      idempotencyClaimed = true;
    }

    // Helper: send response and update the idempotency slot.
    // Errors < 500 are cached (permanent validation failures); 5xx release the
    // slot so the client can retry with the same key.
    const sendResponse = (status: number, body: unknown): void => {
      if (idempotencyClaimed) {
        if (status < 500) {
          storeIdempotencyKey(idempotencyKey, "POST:/api/confirm-payment", status, body);
        } else {
          releaseIdempotencyKey(idempotencyKey, "POST:/api/confirm-payment");
        }
      }
      res.status(status).json(body);
    };

    const { amount, mode, sessionId, filename } = req.body as {
      amount?: number;
      mode?: "print" | "copy";
      sessionId?: string;
      filename?: string;
      copies?: number;
      colorMode?: "colored" | "grayscale";
      orientation?: "portrait" | "landscape";
      paperSize?: "A4" | "Letter" | "Legal";
      pageRange?: unknown;
    };

    if (mode !== "print" && mode !== "copy") {
      void appendAdminLog("payment_failed", "Confirm payment failed: invalid mode.", {
        mode: mode ?? null,
      });
      return sendResponse(400, { error: "Invalid mode" });
    }

    const copies =
      typeof req.body?.copies === "number" && Number.isFinite(req.body.copies)
        ? Math.max(1, Math.floor(req.body.copies))
        : 1;
    const colorMode =
      req.body?.colorMode === "colored" || req.body?.colorMode === "grayscale"
        ? req.body.colorMode
        : "grayscale";
    const orientation =
      req.body?.orientation === "portrait" || req.body?.orientation === "landscape"
        ? req.body.orientation
        : "portrait";
    const paperSize =
      req.body?.paperSize === "A4" || req.body?.paperSize === "Letter" || req.body?.paperSize === "Legal"
        ? req.body.paperSize
        : "A4";
    const requiredAmount = calculateJobAmount(mode, colorMode, copies);

    if (typeof amount === "number" && Number.isFinite(amount) && amount !== requiredAmount) {
      void appendAdminLog("payment_amount_mismatch", "Client amount differed from server pricing.", {
        amount,
        requiredAmount,
      });
    }

    // ── Resolve the file to print (for "print" mode) — outside the lock ──────
    // Validation and file lookup happen before acquiring the balance lock so the
    // lock is held only for the minimal balance/earnings mutation + db.write().
    let serverFilename: string | null = null;
    let printOptions: PrintJobOptions | null = null;

    if (mode === "print") {
      if (!sessionId) {
        void appendAdminLog(
          "payment_failed",
          "Confirm payment failed: missing print session.",
        );
        return sendResponse(400, { error: "Print session is required" });
      }

      const session = deps.sessionStore.tryGetSession(
        sessionId,
        deps.resolvePublicBaseUrl(req),
      );
      if (!session) {
        void appendAdminLog(
          "payment_failed",
          "Confirm payment failed: session not found.",
          { sessionId },
        );
        return sendResponse(404, { error: "Session not found" });
      }

      const allDocs =
        session.documents && session.documents.length > 0
          ? session.documents
          : session.document
            ? [session.document]
            : [];

      if (allDocs.length === 0) {
        void appendAdminLog(
          "payment_failed",
          "Confirm payment failed: no uploaded document in session.",
          { sessionId },
        );
        return sendResponse(400, { error: "No uploaded document found for this session" });
      }

      const target = filename
        ? allDocs.find((d) => d.filename === filename)
        : allDocs[allDocs.length - 1];

      if (!target) {
        void appendAdminLog(
          "payment_failed",
          "Confirm payment failed: target document not found.",
          { sessionId, filename: filename ?? null },
        );
        return sendResponse(400, { error: `Document "${filename}" not found in session` });
      }

      const parsedPageRange = parsePageRange(req.body?.pageRange);
      if (parsedPageRange.error) {
        void appendAdminLog(
          "payment_failed",
          "Confirm payment failed: invalid page range.",
          {
            sessionId,
            pageRange: req.body?.pageRange ?? null,
            error: parsedPageRange.error,
          },
        );
        return sendResponse(400, { error: parsedPageRange.error });
      }

      serverFilename = path.basename(target.filePath);
      printOptions = {
        copies,
        colorMode,
        orientation,
        paperSize,
        pageRange: parsedPageRange.value,
      };
    }

    // ── Pre-check balance (will re-verify inside lock) ────────────────────────
    if ((db.data?.balance ?? 0) < requiredAmount) {
      void appendAdminLog(
        "payment_failed",
        "Confirm payment failed: insufficient balance.",
        { balance: db.data?.balance ?? 0, requiredAmount },
      );
      // Release so the client can retry once more balance has been inserted
      if (idempotencyClaimed) releaseIdempotencyKey(idempotencyKey, "POST:/api/confirm-payment");
      return res.status(400).json({
        error: "Insufficient balance",
        balance: db.data?.balance ?? 0,
        requiredAmount,
      });
    }

    // ── Print (outside the lock — keeps the critical section minimal) ─────────
    if (mode === "print" && serverFilename && printOptions) {
      try {
        await printFile(serverFilename, printOptions);
      } catch (err) {
        void appendAdminLog("print_failed", "Print failed: printer error.", {
          sessionId: sessionId ?? null,
          filename: serverFilename,
          error: err instanceof Error ? err.message : "Unknown error",
        });
        return sendResponse(500, { error: "Print failed. Please try again." });
      }
    }

    // ── Settlement: charge balance + dispense change via shared logic ───────
    const settlement = await settlePayment({
      requiredAmount,
      io: deps.io,
      jobContext: {
        mode,
        copies,
        colorMode,
        sessionId: sessionId ?? null,
        filename: filename ?? null,
      },
    });

    if (!settlement.ok) {
      sendResponse(400, {
        error: settlement.error ?? "Insufficient balance",
        balance: settlement.remainingBalance,
        requiredAmount,
      });
      return;
    }

    // Logging and stats updates happen outside the lock
    await incrementJobStats(mode);

    await appendAdminLog("payment_confirmed", "Payment confirmed.", {
      mode,
      amount: requiredAmount,
      copies,
      colorMode,
      pageRange: printOptions?.pageRange ?? null,
      sessionId: sessionId ?? null,
      filename: filename ?? null,
      remainingBalance: settlement.remainingBalance,
      changeState: settlement.change.state,
      changeRequested: settlement.change.requested,
      changeDispensed: settlement.change.dispensed,
    });

    if (settlement.change.state === "dispensed") {
      await appendAdminLog("hopper_dispense_succeeded", "Coin change dispensed.", {
        requested: settlement.change.requested,
        dispensed: settlement.change.dispensed,
        attempts: settlement.change.attempts ?? 0,
      });
    }

    if (settlement.change.state === "failed") {
      await appendAdminLog("hopper_dispense_failed", "Coin change dispense failed.", {
        requested: settlement.change.requested,
        dispensed: settlement.change.dispensed,
        attempts: settlement.change.attempts ?? 0,
        owedChangeId: settlement.change.owedChangeId ?? null,
        message: settlement.change.message ?? null,
      });
    }

    sendResponse(200, {
      ok: true,
      chargedAmount: settlement.chargedAmount,
      balance: settlement.remainingBalance,
      earnings: settlement.earnings,
      change: settlement.change,
    });
  });
}
