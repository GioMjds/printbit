import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteStorage from '@/core/database/sqlite-storage';
import {
  reportIssueStore,
  REPORT_RESOLUTION_REASONS,
  type ReportResolutionReason,
} from '@/core/database/models/report-issue.model';
import { ReportService } from '@/modules/report/report.service';
import { ReportController } from '@/modules/report/report.controller';

jest.mock('@/middleware/admin-auth', () => ({
  requireAdminLocalAccess: (_req: any, _res: any, next: any) => next(),
  requireAdminPin: (_req: any, _res: any, next: any) => next(),
}));

describe('Report Resolution & Audit Logging API', () => {
  let db: DatabaseSync;
  let app: Express;
  let server: http.Server;
  let baseUrl: string;
  let reportService: ReportService;
  let reportController: ReportController;

  beforeAll(async () => {
    reportService = new ReportService();
    reportController = new ReportController(reportService, {
      resolvePublicBaseUrl: () => new URL('http://127.0.0.1:3000'),
    });

    app = express();
    app.use(express.json());
    app.use(reportController.router);

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    sqliteStorage.ensureSchema(db);
    jest.spyOn(sqliteStorage, 'getSqliteDb').mockReturnValue(db);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Submitting report with transactionRef', () => {
    it('persists transactionRef when submitting direct report issue via API', async () => {
      const response = await fetch(`${baseUrl}/api/report-issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Coin Hopper Jam',
          description: 'Coins did not dispense properly',
          category: 'payment',
          transactionRef: 'TXN-COIN-4567',
        }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as { ok: boolean; reportIssueId: string };
      expect(data.ok).toBe(true);
      expect(data.reportIssueId).toBeDefined();

      const saved = reportIssueStore.getReportIssueById(data.reportIssueId);
      expect(saved).not.toBeNull();
      expect(saved?.title).toBe('Coin Hopper Jam');
      expect(saved?.transactionRef).toBe('TXN-COIN-4567');
      expect(saved?.status).toBe('open');
      expect(saved?.resolutionReason).toBeNull();
    });

    it('persists transactionRef via query param fallback if not in body', async () => {
      const response = await fetch(
        `${baseUrl}/api/report-issues?transactionRef=TXN-QUERY-8899`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Network Timeout',
            description: 'Could not upload wireless document',
            category: 'network',
          }),
        },
      );

      expect(response.status).toBe(201);
      const data = (await response.json()) as { ok: boolean; reportIssueId: string };
      const saved = reportIssueStore.getReportIssueById(data.reportIssueId);
      expect(saved?.transactionRef).toBe('TXN-QUERY-8899');
    });

    it('persists transactionRef when submitting session report issue', async () => {
      const session = await reportService.createSession(new URL('http://127.0.0.1:3000'));

      const response = await fetch(
        `${baseUrl}/api/report-issues/sessions/${session.sessionId}/submit?token=${session.token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Paper Creased',
            description: 'Sheets came out crinkled',
            category: 'print',
            transactionRef: 'TXN-SESS-9900',
          }),
        },
      );

      expect(response.status).toBe(201);
      const data = (await response.json()) as { ok: boolean; reportIssueId: string };
      const saved = reportIssueStore.getReportIssueById(data.reportIssueId);
      expect(saved?.transactionRef).toBe('TXN-SESS-9900');
    });
  });

  describe('Resolving report resolutionReason enforcement', () => {
    it('returns 400 when resolving report without resolutionReason', async () => {
      const entry = await reportService.submitDirectReportIssue({
        title: 'Ink Streaks',
        description: 'Black horizontal lines on pages',
        category: 'print',
      });

      const response = await fetch(
        `${baseUrl}/api/admin/report-issues/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'resolved',
          }),
        },
      );

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe('resolutionReason is required when resolving a report.');

      const untouched = reportIssueStore.getReportIssueById(entry.id);
      expect(untouched?.status).toBe('open');
      expect(untouched?.resolvedAt).toBeNull();
    });

    it('returns 400 when resolving report with empty resolutionReason', async () => {
      const entry = await reportService.submitDirectReportIssue({
        title: 'Scanner Dirty',
        description: 'Dust particle on glass',
        category: 'scan',
      });

      const response = await fetch(
        `${baseUrl}/api/admin/report-issues/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'resolved',
            resolutionReason: '   ',
          }),
        },
      );

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe('resolutionReason is required when resolving a report.');
    });

    it('returns 400 when resolving with an invalid resolutionReason', async () => {
      const entry = await reportService.submitDirectReportIssue({
        title: 'Coin reject',
        description: '10 peso coin rejected twice',
        category: 'payment',
      });

      const response = await fetch(
        `${baseUrl}/api/admin/report-issues/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'resolved',
            resolutionReason: 'customer_appeased',
          }),
        },
      );

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe('Invalid resolutionReason.');
    });

    it('returns 400 when invalid status is provided', async () => {
      const entry = await reportService.submitDirectReportIssue({
        title: 'Touchscreen unresponsive',
        description: 'Bottom corner not clicking',
        category: 'hardware',
      });

      const response = await fetch(
        `${baseUrl}/api/admin/report-issues/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'in_progress',
          }),
        },
      );

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe('Valid status required: open | acknowledged | resolved');
    });
  });

  describe('Resolving report with valid resolutionReason and audit logging', () => {
    it.each(REPORT_RESOLUTION_REASONS)(
      'resolves report with valid reason "%s", returns 200, and logs to admin_logs',
      async (reason: ReportResolutionReason) => {
        const entry = await reportService.submitDirectReportIssue({
          title: `Test issue for reason ${reason}`,
          description: 'Detailed problem description here',
          category: 'software',
        });

        const resolutionNote = `Resolved with note for reason ${reason}`;
        const response = await fetch(
          `${baseUrl}/api/admin/report-issues/${entry.id}/status`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              status: 'resolved',
              resolutionReason: reason,
              resolutionNote,
            }),
          },
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          ok: boolean;
          entry: any;
          issue: any;
        };
        expect(body.ok).toBe(true);

        const updatedIssue = body.issue ?? body.entry;
        expect(updatedIssue.status).toBe('resolved');
        expect(updatedIssue.resolutionReason).toBe(reason);
        expect(updatedIssue.resolutionNote).toBe(resolutionNote);
        expect(updatedIssue.resolvedAt).toBeDefined();

        // Verify SQLite report_issue_entries
        const dbEntry = reportIssueStore.getReportIssueById(entry.id);
        expect(dbEntry?.status).toBe('resolved');
        expect(dbEntry?.resolutionReason).toBe(reason);
        expect(dbEntry?.resolutionNote).toBe(resolutionNote);

        // Verify audit log entry in admin_logs
        const logRow = db
          .prepare(
            `SELECT * FROM admin_logs
             WHERE type = 'report_resolved' AND message LIKE ?
             ORDER BY timestamp DESC LIMIT 1`,
          )
          .get(`%${entry.id}%`) as {
          id: string;
          type: string;
          message: string;
          meta_json: string;
          timestamp: string;
        } | undefined;

        expect(logRow).toBeDefined();
        expect(logRow?.type).toBe('report_resolved');
        expect(logRow?.message).toBe(
          `Report ${entry.id} status updated to resolved (${reason})`,
        );

        const parsedMeta = JSON.parse(logRow?.meta_json ?? '{}') as {
          reportId: string;
          status: string;
          resolutionReason: string;
          resolutionNote: string;
        };
        expect(parsedMeta.reportId).toBe(entry.id);
        expect(parsedMeta.status).toBe('resolved');
        expect(parsedMeta.resolutionReason).toBe(reason);
        expect(parsedMeta.resolutionNote).toBe(resolutionNote);
      },
    );

    it('logs report_acknowledged when setting status to acknowledged', async () => {
      const entry = await reportService.submitDirectReportIssue({
        title: 'Paper Low',
        description: 'Tray 1 almost empty',
        category: 'hardware',
      });

      const response = await fetch(
        `${baseUrl}/api/admin/report-issues/${entry.id}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'acknowledged',
          }),
        },
      );

      expect(response.status).toBe(200);

      const logRow = db
        .prepare(
          `SELECT * FROM admin_logs
           WHERE type = 'report_acknowledged' AND message LIKE ?
           ORDER BY timestamp DESC LIMIT 1`,
        )
        .get(`%${entry.id}%`) as {
        id: string;
        type: string;
        message: string;
        meta_json: string;
      } | undefined;

      expect(logRow).toBeDefined();
      expect(logRow?.type).toBe('report_acknowledged');
      expect(logRow?.message).toBe(`Report ${entry.id} status updated to acknowledged`);

      const parsedMeta = JSON.parse(logRow?.meta_json ?? '{}');
      expect(parsedMeta.reportId).toBe(entry.id);
      expect(parsedMeta.status).toBe('acknowledged');
      expect(parsedMeta.resolutionReason).toBeNull();
    });
  });
});
