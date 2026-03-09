import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import {
  requireAdminLocalAccess,
  requireAdminPin,
} from "../middleware/admin-auth";
import {
  appendAdminLog,
  computeEarningsBuckets,
  getStorageUsage,
  logsToCsv,
} from "../services/admin";
import { db } from "../services/db";
import { getPrinterTelemetry } from "../services/printer-status";
import { getScannerStatus } from "../services/scanner";

interface RegisterAdminRoutesDeps {
  uploadDir: string;
  getSerialStatus: () => {
    connected: boolean;
    portPath: string | null;
    lastError: string | null;
  };
  getHopperStatus: () => {
    connected: boolean;
    pending: boolean;
    portPath: string | null;
    lastError: string | null;
    lastSuccessAt: string | null;
  };
  runHopperSelfTest: () => Promise<{
    ok: boolean;
    amount: number;
    message: string;
    attempts: number;
    owedChangeId?: string;
  }>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWholePeso(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function registerAdminRoutes(
  app: Express,
  deps: RegisterAdminRoutesDeps,
) {
  app.post(
    "/api/admin/auth",
    requireAdminLocalAccess,
    (req: Request, res: Response) => {
      const pin = typeof req.body?.pin === "string" ? req.body.pin : "";
      if (!pin || pin !== db.data!.settings.adminPin) {
        return res.status(401).json({ ok: false, error: "Invalid admin PIN." });
      }

      return res.json({ ok: true });
    },
  );

  app.get(
    "/api/admin/summary",
    requireAdminLocalAccess,
    requireAdminPin,
    (req: Request, res: Response) => {
      const storage = getStorageUsage(deps.uploadDir);
      const host = req.get("host") ?? "unknown";
      const wifiActive =
        !host.startsWith("localhost") && !host.startsWith("127.0.0.1");
      const printer = getPrinterTelemetry();
      const scanner = getScannerStatus();
      res.json({
        balance: db.data!.balance,
        earnings: computeEarningsBuckets(),
        coinStats: db.data!.coinStats,
        jobStats: db.data!.jobStats,
        hopperStats: db.data!.hopperStats,
        owedChangeOpenCount: db.data!.owedChanges.filter((entry) => entry.status === "open").length,
        storage,
        status: {
          serverRunning: true,
          uptimeSeconds: Math.floor(process.uptime()),
          serial: deps.getSerialStatus(),
          hopper: deps.getHopperStatus(),
          printer,
          scanner,
          host,
          wifiActive,
        },
      });
    },
  );

  app.get(
    "/api/admin/status",
    requireAdminLocalAccess,
    requireAdminPin,
    (req: Request, res: Response) => {
      const storage = getStorageUsage(deps.uploadDir);
      const host = req.get("host") ?? "unknown";
      const wifiActive =
        !host.startsWith("localhost") && !host.startsWith("127.0.0.1");
      const printer = getPrinterTelemetry();
      const scanner = getScannerStatus();
      res.json({
        serverRunning: true,
        uptimeSeconds: Math.floor(process.uptime()),
        serial: deps.getSerialStatus(),
        hopper: deps.getHopperStatus(),
        printer,
        scanner,
        storage,
        host,
        wifiActive,
      });
    },
  );

  app.post(
    "/api/admin/hopper/self-test",
    requireAdminLocalAccess,
    requireAdminPin,
    async (_req: Request, res: Response) => {
      const result = await deps.runHopperSelfTest();
      res.status(result.ok ? 200 : 503).json(result);
    },
  );

  app.get(
    "/api/admin/settings",
    requireAdminLocalAccess,
    requireAdminPin,
    (_req: Request, res: Response) => {
      res.json(db.data!.settings);
    },
  );

  app.put(
    "/api/admin/settings",
    requireAdminLocalAccess,
    requireAdminPin,
    async (req: Request, res: Response) => {
      const body = req.body as {
        pricing?: {
          printPerPage?: number;
          copyPerPage?: number;
          scanDocument?: number;
          colorSurcharge?: number;
        };
        idleTimeoutSeconds?: number;
        adminPin?: string;
        adminLocalOnly?: boolean;
      };

      const printPerPage = body.pricing?.printPerPage;
      const copyPerPage = body.pricing?.copyPerPage;
      const scanDocument = body.pricing?.scanDocument;
      const colorSurcharge = body.pricing?.colorSurcharge;

      if (
        printPerPage !== undefined &&
        (!isFiniteNumber(printPerPage) || !isWholePeso(printPerPage))
      ) {
        return res.status(400).json({ error: "printPerPage must be a whole peso value (no decimals)." });
      }
      if (
        copyPerPage !== undefined &&
        (!isFiniteNumber(copyPerPage) || !isWholePeso(copyPerPage))
      ) {
        return res.status(400).json({ error: "copyPerPage must be a whole peso value (no decimals)." });
      }
      if (
        scanDocument !== undefined &&
        (!isFiniteNumber(scanDocument) || !isWholePeso(scanDocument))
      ) {
        return res.status(400).json({ error: "scanDocument must be a whole peso value (no decimals)." });
      }
      if (
        colorSurcharge !== undefined &&
        (!isFiniteNumber(colorSurcharge) || !isWholePeso(colorSurcharge))
      ) {
        return res.status(400).json({ error: "colorSurcharge must be a whole peso value (no decimals)." });
      }

      if (
        body.idleTimeoutSeconds !== undefined &&
        (!isFiniteNumber(body.idleTimeoutSeconds) ||
          body.idleTimeoutSeconds < 15)
      ) {
        return res
          .status(400)
          .json({ error: "Invalid idleTimeoutSeconds value." });
      }

      if (
        body.adminPin !== undefined &&
        (typeof body.adminPin !== "string" || body.adminPin.trim().length < 4)
      ) {
        return res
          .status(400)
          .json({ error: "Admin PIN must be at least 4 characters." });
      }

      if (body.pricing) {
        if (printPerPage !== undefined)
          db.data!.settings.pricing.printPerPage = printPerPage;
        if (copyPerPage !== undefined)
          db.data!.settings.pricing.copyPerPage = copyPerPage;
        if (scanDocument !== undefined) 
          db.data!.settings.pricing.scanDocument = scanDocument;
        if (colorSurcharge !== undefined)
          db.data!.settings.pricing.colorSurcharge = colorSurcharge;
      }

      if (body.idleTimeoutSeconds !== undefined) {
        db.data!.settings.idleTimeoutSeconds = Math.floor(
          body.idleTimeoutSeconds,
        );
      }

      if (body.adminPin !== undefined) {
        db.data!.settings.adminPin = body.adminPin.trim();
      }

      if (body.adminLocalOnly !== undefined) {
        db.data!.settings.adminLocalOnly = Boolean(body.adminLocalOnly);
      }

      await db.write();
      await appendAdminLog("admin_settings_updated", "Admin settings updated.");

      res.json(db.data!.settings);
    },
  );

  app.get(
    "/api/admin/logs",
    requireAdminLocalAccess,
    requireAdminPin,
    (req: Request, res: Response) => {
      const rawLimit = Number(req.query.limit ?? 200);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(1000, Math.floor(rawLimit)))
        : 200;
      res.json({ logs: db.data!.logs.slice(0, limit) });
    },
  );

  app.get(
    "/api/admin/logs/export.csv",
    requireAdminLocalAccess,
    requireAdminPin,
    (_req: Request, res: Response) => {
      const csv = logsToCsv(db.data!.logs);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="printbit-admin-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(csv);
    },
  );

  app.delete(
    "/api/admin/logs",
    requireAdminLocalAccess,
    requireAdminPin,
    async (_req: Request, res: Response) => {
      db.data!.logs = [];
      await db.write();
      res.json({ ok: true });
    },
  );

  app.post(
    "/api/admin/balance/reset",
    requireAdminLocalAccess,
    requireAdminPin,
    async (_req: Request, res: Response) => {
      const previousBalance = db.data!.balance;
      db.data!.balance = 0;
      await db.write();
      await appendAdminLog(
        "admin_balance_reset",
        "Admin reset machine balance.",
        {
          previousBalance,
          newBalance: 0,
        },
      );

      res.json({
        ok: true,
        balance: db.data!.balance,
        earnings: db.data!.earnings,
      });
    },
  );

  app.post(
    "/api/admin/storage/clear",
    requireAdminLocalAccess,
    requireAdminPin,
    async (_req: Request, res: Response) => {
      const uploadDir = path.resolve(deps.uploadDir);
      if (!fs.existsSync(uploadDir)) {
        return res.json({ ok: true, removedFiles: 0 });
      }

      let removedFiles = 0;
      const entries = fs.readdirSync(uploadDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = path.join(uploadDir, entry.name);
        fs.unlinkSync(fullPath);
        removedFiles += 1;
      }

      await appendAdminLog(
        "admin_storage_cleared",
        "Admin cleared upload storage.",
        {
          removedFiles,
        },
      );
      res.json({ ok: true, removedFiles });
    },
  );

  // ── Owed change management ─────────────────────────────────────────────────

  app.get(
    "/api/admin/owed-changes",
    requireAdminLocalAccess,
    requireAdminPin,
    (_req: Request, res: Response) => {
      const entries = db.data!.owedChanges ?? [];
      const open = entries.filter((e) => e.status === "open");
      const resolved = entries.filter((e) => e.status === "resolved");
      res.json({
        total: entries.length,
        openCount: open.length,
        resolvedCount: resolved.length,
        entries,
      });
    },
  );

  app.post(
    "/api/admin/owed-changes/:id/resolve",
    requireAdminLocalAccess,
    requireAdminPin,
    async (req: Request, res: Response) => {
      const entryId = req.params.id as string;
      const entry = db.data!.owedChanges.find((e) => e.id === entryId);
      if (!entry) {
        return res.status(404).json({ error: "Owed change entry not found." });
      }
      if (entry.status === "resolved") {
        return res.status(409).json({ error: "Already resolved." });
      }

      entry.status = "resolved";
      await db.write();

      await appendAdminLog(
        "owed_change_resolved",
        `Owed change ₱${entry.amount} resolved by admin.`,
        { entryId, amount: entry.amount, reason: entry.reason },
      );

      res.json({ ok: true, entry });
    },
  );

  app.post(
    "/api/admin/owed-changes/resolve-all",
    requireAdminLocalAccess,
    requireAdminPin,
    async (_req: Request, res: Response) => {
      let count = 0;
      for (const entry of db.data!.owedChanges) {
        if (entry.status === "open") {
          entry.status = "resolved";
          count += 1;
        }
      }
      await db.write();

      if (count > 0) {
        await appendAdminLog(
          "owed_changes_bulk_resolved",
          `Admin resolved ${count} owed change entries.`,
          { count },
        );
      }

      res.json({ ok: true, resolvedCount: count });
    },
  );
}
