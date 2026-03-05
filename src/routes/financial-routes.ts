import type { Express, Request, RequestHandler, Response } from "express";
import path from "node:path";
import type { Server } from "socket.io";
import { db, withBalanceLock, checkIdempotencyKey, markIdempotencyKeyInFlight, storeIdempotencyKey } from "../services/db";
import {
  appendAdminLog,
  calculateJobAmount,
  getPricingSettings,
  incrementJobStats,
} from "../services/admin";
import { printFile, type PrintJobOptions } from "../services/printer";
import type { SessionStore } from "../services/session";

interface RegisterFinancialRoutesDeps {
  io: Server;
  sessionStore: SessionStore;
  uploadSingle: RequestHandler;
  resolvePublicBaseUrl: (req: Request) => URL;
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

  const PAYMENT_NS = "POST:/api/confirm-payment";

  app.post("/api/confirm-payment", async (req: Request, res: Response) => {
    // ── Idempotency guard ──────────────────────────────────────────────
    const idempotencyKey = req.get("Idempotency-Key") ?? "";
    if (idempotencyKey) {
      const cached = checkIdempotencyKey(idempotencyKey, PAYMENT_NS);
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
      markIdempotencyKeyInFlight(idempotencyKey, PAYMENT_NS);
    }

    const { amount, mode, sessionId, filename } = req.body as {
      amount?: number;
      mode?: "print" | "copy";
      sessionId?: string;
      filename?: string;
      copies?: number;
      colorMode?: "colored" | "grayscale";
      orientation?: "portrait" | "landscape";
      paperSize?: "A4" | "Letter" | "Legal";
    };

    if (mode !== "print" && mode !== "copy") {
      void appendAdminLog("payment_failed", "Confirm payment failed: invalid mode.", {
        mode: mode ?? null,
      });
      const body = { error: "Invalid mode" };
      if (idempotencyKey) storeIdempotencyKey(idempotencyKey, PAYMENT_NS, 400, body);
      return res.status(400).json(body);
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

    // ── Pre-check balance ──────────────────────────────────────────────
    if ((db.data?.balance ?? 0) < requiredAmount) {
      void appendAdminLog(
        "payment_failed",
        "Confirm payment failed: insufficient balance.",
        { balance: db.data?.balance ?? 0, requiredAmount },
      );
      const body = {
        error: "Insufficient balance",
        balance: db.data?.balance ?? 0,
        requiredAmount,
      };
      if (idempotencyKey) storeIdempotencyKey(idempotencyKey, PAYMENT_NS, 400, body);
      return res.status(400).json(body);
    }

    if (typeof amount === "number" && Number.isFinite(amount) && amount !== requiredAmount) {
      void appendAdminLog("payment_amount_mismatch", "Client amount differed from server pricing.", {
        amount,
        requiredAmount,
      });
    }

    // ── Validate session and resolve print file (outside lock) ─────────
    let serverFilename: string | undefined;
    let printOptions: PrintJobOptions | undefined;

    if (mode === "print") {
      if (!sessionId) {
        void appendAdminLog(
          "payment_failed",
          "Confirm payment failed: missing print session.",
        );
        const body = { error: "Print session is required" };
        if (idempotencyKey) storeIdempotencyKey(idempotencyKey, PAYMENT_NS, 400, body);
        return res.status(400).json(body);
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
        const body = { error: "Session not found" };
        if (idempotencyKey) storeIdempotencyKey(idempotencyKey, PAYMENT_NS, 404, body);
        return res.status(404).json(body);
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
        const body = { error: "No uploaded document found for this session" };
        if (idempotencyKey) storeIdempotencyKey(idempotencyKey, PAYMENT_NS, 400, body);
        return res.status(400).json(body);
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
        const body = { error: `Document "${filename}" not found in session` };
        if (idempotencyKey) storeIdempotencyKey(idempotencyKey, PAYMENT_NS, 400, body);
        return res.status(400).json(body);
      }

      serverFilename = path.basename(target.filePath);
      printOptions = { copies, colorMode, orientation, paperSize };
    }

    // ── Dispatch print OUTSIDE the lock to keep critical section small ─
    if (mode === "print" && serverFilename && printOptions) {
      try {
        await printFile(serverFilename, printOptions);
      } catch (err) {
        void appendAdminLog("print_failed", "Print failed: printer error.", {
          sessionId: sessionId ?? null,
          filename: serverFilename,
          error: err instanceof Error ? err.message : "Unknown error",
        });
        const body = { error: "Print failed. Please try again." };
        if (idempotencyKey) storeIdempotencyKey(idempotencyKey, PAYMENT_NS, 500, body);
        return res.status(500).json(body);
      }
    }

    // ── Balance lock: only wraps the balance/earnings mutation ─────────
    const result = await withBalanceLock(async () => {
      if ((db.data?.balance ?? 0) < requiredAmount) {
        void appendAdminLog(
          "payment_failed",
          "Confirm payment failed: insufficient balance after print.",
          { balance: db.data?.balance ?? 0, requiredAmount },
        );
        return {
          status: 400,
          body: {
            error: "Insufficient balance",
            balance: db.data?.balance ?? 0,
            requiredAmount,
          },
        };
      }

      db.data!.balance -= requiredAmount;
      db.data!.earnings += requiredAmount;
      await db.write();
      deps.io.emit("balance", db.data!.balance);

      return {
        status: 200,
        body: {
          ok: true,
          chargedAmount: requiredAmount,
          balance: db.data!.balance,
          earnings: db.data!.earnings,
        },
      };
    });

    // ── Post-lock: stats and admin log ────────────────────────────────
    if (result.status === 200) {
      await incrementJobStats(mode);
      await appendAdminLog("payment_confirmed", "Payment confirmed.", {
        mode,
        amount: requiredAmount,
        copies,
        colorMode,
        sessionId: sessionId ?? null,
        filename: filename ?? null,
        remainingBalance: (result.body as { balance: number }).balance,
      });
    }

    if (idempotencyKey) {
      storeIdempotencyKey(idempotencyKey, PAYMENT_NS, result.status, result.body);
    }
    res.status(result.status).json(result.body);
  });
}
