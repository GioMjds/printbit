import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { db } from '@/services/db';
import { adminLogStore } from '@/core/database/sqlite-storage';
import { AdminController } from '@/modules/admin/admin.controller';
import { AdminService } from '@/modules/admin/admin.service';
import { ConsumablesService } from '@/modules/admin/consumables.service';

jest.mock('@/middleware/admin-auth', () => ({
  requireAdminLocalAccess: (_req: any, _res: any, next: any) => next(),
  requireAdminPin: (_req: any, _res: any, next: any) => next(),
}));

describe('Admin Page Output Summary API', () => {
  let app: Express;
  let server: http.Server;
  let baseUrl: string;
  let adminController: AdminController;

  beforeAll(async () => {
    const adminService = new AdminService();
    const consumablesService = new ConsumablesService();
    adminController = new AdminController(adminService, consumablesService, {
      io: { emit: jest.fn() } as any,
      uploadDir: 'tmp',
      getSerialStatus: () => ({ connected: false, portPath: null, lastError: null }),
      getHopperStatus: () => ({ connected: false, pending: false, portPath: null, lastError: null, lastSuccessAt: null }),
      runHopperSelfTest: async () => ({ ok: true, amount: 0, message: '', attempts: 0 }),
    } as any);

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminController.router);

    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  beforeEach(() => {
    try {
      adminLogStore.clear();
    } catch {
      // ignore
    }
    db.data = {
      balance: 100,
      earnings: 500,
      financialLedger: [],
      owedChanges: [],
      adminLogs: [],
      logs: [],
      pendingRefunds: [],
      recovery: { sessions: [] },
      receiptRecords: [],
    } as any;
  });

  it('aggregates requested vs printed pages, refunds, and owed change correctly', async () => {
    db.data = {
      financialLedger: [
        {
          id: '1',
          eventType: 'payment_received',
          amount: 100,
          referenceId: 'tx-1',
          timestamp: '2026-10-07T10:00:00Z',
        },
        {
          id: '2',
          eventType: 'refund_issued',
          amount: 20,
          referenceId: 'tx-1',
          timestamp: '2026-10-07T10:10:00Z',
        },
      ],
      owedChanges: [
        {
          id: 'oc-1',
          amount: 5,
          status: 'open',
          timestamp: '2026-10-07T10:05:00Z',
        },
      ],
      adminLogs: [
        {
          id: 'log-1',
          type: 'payment_confirmed',
          timestamp: '2026-10-07T10:00:00Z',
          message: 'Payment confirmed',
          meta: {
            transactionId: 'tx-1',
            amount: 100,
            totalPages: 10,
            pagesPrinted: 8,
            colorPages: 2,
            bwPages: 6,
          },
        },
      ],
      pendingRefunds: [],
      recovery: { sessions: [] },
      receiptRecords: [],
      balance: 0,
      earnings: 80,
    } as any;

    const res = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    // Financial metrics
    expect(data.financials.grossCharged).toBe(100);
    expect(data.financials.cashRefundsIssued).toBe(20);
    expect(data.financials.refundCount).toBe(1);
    expect(data.financials.netCashRetained).toBe(80);
    expect(data.financials.unresolvedOwedChange).toBe(5);
    expect(data.financials.unresolvedOwedChangeCount).toBe(1);

    // Page production metrics
    expect(data.pages.totalRequested).toBe(10);
    expect(data.pages.totalPrinted).toBe(8);
    expect(data.pages.totalFailed).toBe(2);
    expect(data.pages.fulfillmentRatePercent).toBe(80);
    expect(data.pages.colorPagesPrinted).toBe(2);
    expect(data.pages.bwPagesPrinted).toBe(6);

    // Hardware incidents
    expect(data.hardwareIncidents.spoolerFailures).toBe(0);
    expect(data.hardwareIncidents.hopperShortfalls).toBe(1);

    // Scope
    expect(data.scope.totalTransactions).toBe(1);
    expect(data.scope.dateFrom).toBeNull();
    expect(data.scope.dateTo).toBeNull();
  });

  it('aggregates multiple transactions across different modes with color breakdown', async () => {
    db.data = {
      financialLedger: [
        {
          id: 'fl-1',
          eventType: 'job_completed',
          amount: 50,
          referenceId: 'tx-print-1',
          timestamp: '2026-10-07T08:00:00Z',
        },
        {
          id: 'fl-2',
          eventType: 'job_completed',
          amount: 30,
          referenceId: 'tx-copy-1',
          timestamp: '2026-10-07T09:00:00Z',
        },
        {
          id: 'fl-3',
          eventType: 'refund_issued',
          amount: 10,
          referenceId: 'tx-copy-1',
          timestamp: '2026-10-07T09:15:00Z',
        },
      ],
      owedChanges: [
        {
          id: 'oc-res',
          amount: 10,
          status: 'resolved',
          timestamp: '2026-10-07T08:05:00Z',
        },
      ],
      adminLogs: [
        {
          id: 'log-tx1',
          type: 'print_job_completed',
          timestamp: '2026-10-07T08:00:00Z',
          message: 'Print completed',
          meta: {
            transactionId: 'tx-print-1',
            mode: 'print',
            amount: 50,
            totalPages: 5,
            pagesPrinted: 5,
            colorPages: 3,
            bwPages: 2,
          },
        },
        {
          id: 'log-tx2',
          type: 'copy_job_completed',
          timestamp: '2026-10-07T09:00:00Z',
          message: 'Copy completed',
          meta: {
            transactionId: 'tx-copy-1',
            mode: 'copy',
            amount: 30,
            totalPages: 6,
            pagesPrinted: 4,
            colorPages: 0,
            bwPages: 4,
          },
        },
      ],
      pendingRefunds: [],
      recovery: { sessions: [] },
      receiptRecords: [],
      balance: 0,
      earnings: 70,
    } as any;

    const res = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.scope.totalTransactions).toBe(2);
    expect(data.financials.grossCharged).toBe(80); // 50 + 30
    expect(data.financials.cashRefundsIssued).toBe(10);
    expect(data.financials.refundCount).toBe(1);
    expect(data.financials.netCashRetained).toBe(70);
    expect(data.financials.unresolvedOwedChange).toBe(0); // oc-res is resolved
    expect(data.financials.unresolvedOwedChangeCount).toBe(0);

    expect(data.pages.totalRequested).toBe(11); // 5 + 6
    expect(data.pages.totalPrinted).toBe(9); // 5 + 4
    expect(data.pages.totalFailed).toBe(2); // 11 - 9
    expect(data.pages.colorPagesPrinted).toBe(3); // 3 + 0
    expect(data.pages.bwPagesPrinted).toBe(6); // 2 + 4
    expect(data.pages.fulfillmentRatePercent).toBe(81.82); // 9 / 11 * 100 = 81.82
  });

  it('filters summary by date range correctly', async () => {
    db.data = {
      financialLedger: [
        {
          id: 'fl-early',
          eventType: 'payment_received',
          amount: 20,
          referenceId: 'tx-early',
          timestamp: '2026-10-05T10:00:00Z',
        },
        {
          id: 'fl-in',
          eventType: 'payment_received',
          amount: 60,
          referenceId: 'tx-in',
          timestamp: '2026-10-07T10:00:00Z',
        },
        {
          id: 'fl-late',
          eventType: 'payment_received',
          amount: 40,
          referenceId: 'tx-late',
          timestamp: '2026-10-09T10:00:00Z',
        },
      ],
      owedChanges: [
        {
          id: 'oc-early',
          amount: 5,
          status: 'open',
          timestamp: '2026-10-05T10:05:00Z',
        },
        {
          id: 'oc-in',
          amount: 3,
          status: 'open',
          timestamp: '2026-10-07T10:05:00Z',
        },
      ],
      adminLogs: [
        {
          id: 'log-early',
          type: 'payment_confirmed',
          timestamp: '2026-10-05T10:00:00Z',
          message: 'Early transaction',
          meta: { transactionId: 'tx-early', totalPages: 2, pagesPrinted: 2, bwPages: 2 },
        },
        {
          id: 'log-in',
          type: 'payment_confirmed',
          timestamp: '2026-10-07T10:00:00Z',
          message: 'In range transaction',
          meta: { transactionId: 'tx-in', totalPages: 6, pagesPrinted: 6, colorPages: 6 },
        },
        {
          id: 'log-late',
          type: 'payment_confirmed',
          timestamp: '2026-10-09T10:00:00Z',
          message: 'Late transaction',
          meta: { transactionId: 'tx-late', totalPages: 4, pagesPrinted: 4, bwPages: 4 },
        },
      ],
      pendingRefunds: [],
      recovery: { sessions: [] },
      receiptRecords: [],
      balance: 0,
      earnings: 120,
    } as any;

    const query = new URLSearchParams({
      dateFrom: '2026-10-06T00:00:00.000Z',
      dateTo: '2026-10-08T00:00:00.000Z',
    });

    const res = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary?${query.toString()}`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.scope.totalTransactions).toBe(1);
    expect(data.scope.dateFrom).toBe('2026-10-06T00:00:00.000Z');
    expect(data.scope.dateTo).toBe('2026-10-08T00:00:00.000Z');

    expect(data.financials.grossCharged).toBe(60);
    expect(data.financials.unresolvedOwedChange).toBe(3);
    expect(data.financials.unresolvedOwedChangeCount).toBe(1);

    expect(data.pages.totalRequested).toBe(6);
    expect(data.pages.totalPrinted).toBe(6);
    expect(data.pages.colorPagesPrinted).toBe(6);
    expect(data.pages.bwPagesPrinted).toBe(0);
  });

  it('filters summary by mode and status correctly', async () => {
    db.data = {
      financialLedger: [
        {
          id: 'fl-p',
          eventType: 'payment_received',
          amount: 50,
          referenceId: 'tx-print',
          timestamp: '2026-10-07T10:00:00Z',
        },
        {
          id: 'fl-c',
          eventType: 'payment_received',
          amount: 25,
          referenceId: 'tx-copy',
          timestamp: '2026-10-07T10:05:00Z',
        },
        {
          id: 'fl-f',
          eventType: 'payment_received',
          amount: 15,
          referenceId: 'tx-failed',
          timestamp: '2026-10-07T10:10:00Z',
        },
        {
          id: 'fl-s',
          eventType: 'payment_received',
          amount: 20,
          referenceId: 'tx-scan',
          timestamp: '2026-10-07T10:15:00Z',
        },
      ],
      owedChanges: [
        {
          id: 'oc-for-copy',
          amount: 5,
          status: 'open',
          timestamp: '2026-10-07T10:05:00Z',
          meta: { transactionId: 'tx-copy' },
        },
      ],
      adminLogs: [
        {
          id: 'log-p',
          type: 'print_job_completed',
          timestamp: '2026-10-07T10:00:00Z',
          message: 'Print completed',
          meta: { transactionId: 'tx-print', mode: 'print', totalPages: 5, pagesPrinted: 5 },
        },
        {
          id: 'log-c',
          type: 'copy_job_completed',
          timestamp: '2026-10-07T10:05:00Z',
          message: 'Copy completed',
          meta: { transactionId: 'tx-copy', mode: 'copy', totalPages: 3, pagesPrinted: 3 },
        },
        {
          id: 'log-f',
          type: 'print_spooler_job_failed',
          timestamp: '2026-10-07T10:10:00Z',
          message: 'Print failed with jam',
          meta: { transactionId: 'tx-failed', mode: 'print', totalPages: 4, pagesPrinted: 0 },
        },
        {
          id: 'log-s',
          type: 'scan_job_completed',
          timestamp: '2026-10-07T10:15:00Z',
          message: 'Scan completed',
          meta: { transactionId: 'tx-scan', mode: 'scan', totalPages: 2 },
        },
      ],
      pendingRefunds: [],
      recovery: { sessions: [] },
      receiptRecords: [],
      balance: 0,
      earnings: 110,
    } as any;

    // 1. Mode filter: print (tx-print + tx-failed)
    const resPrint = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary?mode=print`,
    );
    expect(resPrint.status).toBe(200);
    const dataPrint = await resPrint.json();
    expect(dataPrint.scope.totalTransactions).toBe(2);
    expect(dataPrint.financials.grossCharged).toBe(65); // 50 + 15
    expect(dataPrint.pages.totalRequested).toBe(9); // 5 + 4
    expect(dataPrint.pages.totalPrinted).toBe(5);
    expect(dataPrint.pages.totalFailed).toBe(4);
    // oc-for-copy is linked to tx-copy (mode copy), so it must not leak into mode=print
    expect(dataPrint.financials.unresolvedOwedChange).toBe(0);

    // 2. Mode filter: copy (tx-copy)
    const resCopy = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary?mode=copy`,
    );
    expect(resCopy.status).toBe(200);
    const dataCopy = await resCopy.json();
    expect(dataCopy.scope.totalTransactions).toBe(1);
    expect(dataCopy.financials.grossCharged).toBe(25);
    expect(dataCopy.pages.totalRequested).toBe(3);
    expect(dataCopy.financials.unresolvedOwedChange).toBe(5);

    // 3. Mode filter: scan (tx-scan) - document scanning produces 0 printed pages
    const resScan = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary?mode=scan`,
    );
    expect(resScan.status).toBe(200);
    const dataScan = await resScan.json();
    expect(dataScan.scope.totalTransactions).toBe(1);
    expect(dataScan.financials.grossCharged).toBe(20);
    expect(dataScan.pages.totalRequested).toBe(0);
    expect(dataScan.pages.totalPrinted).toBe(0);
    expect(dataScan.pages.totalFailed).toBe(0);
    expect(dataScan.pages.colorPagesPrinted).toBe(0);
    expect(dataScan.pages.bwPagesPrinted).toBe(0);

    // 4. Status filter: completed (tx-print, tx-copy, tx-scan)
    const resCompleted = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary?status=completed`,
    );
    expect(resCompleted.status).toBe(200);
    const dataCompleted = await resCompleted.json();
    expect(dataCompleted.scope.totalTransactions).toBe(3);
    expect(dataCompleted.financials.grossCharged).toBe(95); // 50 + 25 + 20
    expect(dataCompleted.pages.totalRequested).toBe(8); // 5 + 3
    expect(dataCompleted.pages.totalPrinted).toBe(8);
    expect(dataCompleted.pages.totalFailed).toBe(0);

    // 5. Status filter: failed (tx-failed)
    const resFailed = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary?status=failed`,
    );
    expect(resFailed.status).toBe(200);
    const dataFailed = await resFailed.json();
    expect(dataFailed.scope.totalTransactions).toBe(1);
    expect(dataFailed.financials.grossCharged).toBe(15);
    expect(dataFailed.pages.totalRequested).toBe(4);
    expect(dataFailed.pages.totalPrinted).toBe(0);
    expect(dataFailed.pages.totalFailed).toBe(4);
    expect(dataFailed.hardwareIncidents.spoolerFailures).toBe(1);
    // oc-for-copy is linked to tx-copy (status completed), so it must not leak into status=failed
    expect(dataFailed.financials.unresolvedOwedChange).toBe(0);
  });

  it('tracks spooler failures and hopper shortfalls in hardware incidents', async () => {
    db.data = {
      financialLedger: [
        {
          id: 'fl-fail',
          eventType: 'payment_received',
          amount: 40,
          referenceId: 'tx-fail-1',
          timestamp: '2026-10-07T11:00:00Z',
        },
      ],
      owedChanges: [
        {
          id: 'oc-fail',
          amount: 5,
          status: 'open',
          timestamp: '2026-10-07T11:05:00Z',
          meta: { transactionId: 'tx-fail-1' },
        },
      ],
      adminLogs: [
        {
          id: 'log-spool-fail',
          type: 'print_spooler_job_failed',
          timestamp: '2026-10-07T11:01:00Z',
          message: 'Spooler crashed during print',
          meta: {
            transactionId: 'tx-fail-1',
            totalPages: 4,
            pagesPrinted: 1,
          },
        },
        {
          id: 'log-hopper-fail',
          type: 'hopper_dispense_failed',
          timestamp: '2026-10-07T11:05:00Z',
          message: 'Hopper motor timeout',
          meta: {
            transactionId: 'tx-fail-1',
          },
        },
      ],
      pendingRefunds: [],
      recovery: { sessions: [] },
      receiptRecords: [],
      balance: 0,
      earnings: 40,
    } as any;

    const res = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.hardwareIncidents.spoolerFailures).toBe(1);
    expect(data.hardwareIncidents.hopperShortfalls).toBe(1);
    expect(data.pages.totalRequested).toBe(4);
    expect(data.pages.totalPrinted).toBe(1);
    expect(data.pages.totalFailed).toBe(3);
    expect(data.pages.fulfillmentRatePercent).toBe(25);
  });

  it('validates filter parameters and rejects invalid inputs with 400', async () => {
    const invalidMode = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary?mode=invalid`,
    );
    expect(invalidMode.status).toBe(400);

    const invalidStatus = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary?status=invalid_status`,
    );
    expect(invalidStatus.status).toBe(400);

    const invalidDateFrom = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary?dateFrom=not-a-date`,
    );
    expect(invalidDateFrom.status).toBe(400);

    const invertedDates = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary?dateFrom=2026-10-08T00:00:00Z&dateTo=2026-10-07T00:00:00Z`,
    );
    expect(invertedDates.status).toBe(400);
  });

  it('handles empty database returning zeroed metrics and 100% fulfillment rate', async () => {
    const res = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.scope.totalTransactions).toBe(0);
    expect(data.scope.dateFrom).toBeNull();
    expect(data.scope.dateTo).toBeNull();

    expect(data.financials.grossCharged).toBe(0);
    expect(data.financials.cashRefundsIssued).toBe(0);
    expect(data.financials.refundCount).toBe(0);
    expect(data.financials.netCashRetained).toBe(0);
    expect(data.financials.unresolvedOwedChange).toBe(0);
    expect(data.financials.unresolvedOwedChangeCount).toBe(0);

    expect(data.pages.totalRequested).toBe(0);
    expect(data.pages.totalPrinted).toBe(0);
    expect(data.pages.totalFailed).toBe(0);
    expect(data.pages.fulfillmentRatePercent).toBe(100);
    expect(data.pages.colorPagesPrinted).toBe(0);
    expect(data.pages.bwPagesPrinted).toBe(0);

    expect(data.hardwareIncidents.spoolerFailures).toBe(0);
    expect(data.hardwareIncidents.hopperShortfalls).toBe(0);
  });

  it('handles cumulative partial refunds and tracks refundCount accurately', async () => {
    db.data = {
      financialLedger: [
        {
          id: 'fl-1',
          eventType: 'job_completed',
          amount: 80,
          referenceId: 'tx-cum-1',
          timestamp: '2026-10-07T10:00:00Z',
        },
        {
          id: 'fl-ref1',
          eventType: 'refund_issued',
          amount: 15,
          referenceId: 'tx-cum-1',
          timestamp: '2026-10-07T10:10:00Z',
        },
        {
          id: 'fl-ref2',
          eventType: 'refund_issued',
          amount: 25,
          referenceId: 'tx-cum-1',
          timestamp: '2026-10-07T10:20:00Z',
        },
      ],
      owedChanges: [],
      adminLogs: [
        {
          id: 'log-cum-1',
          type: 'print_job_completed',
          timestamp: '2026-10-07T10:00:00Z',
          message: 'Job completed',
          meta: {
            transactionId: 'tx-cum-1',
            totalPages: 10,
            pagesPrinted: 5,
            bwPages: 5,
          },
        },
      ],
      pendingRefunds: [],
      recovery: { sessions: [] },
      receiptRecords: [],
      balance: 0,
      earnings: 40,
    } as any;

    const res = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.financials.grossCharged).toBe(80);
    expect(data.financials.cashRefundsIssued).toBe(40); // 15 + 25
    expect(data.financials.refundCount).toBe(2);
    expect(data.financials.netCashRetained).toBe(40); // 80 - 40
  });

  it('does not double count spooler failure logs without transactionId', async () => {
    db.data = {
      financialLedger: [],
      owedChanges: [],
      adminLogs: [
        {
          id: 'log-no-tx-fail',
          type: 'print_spooler_job_failed',
          timestamp: '2026-10-07T12:00:00Z',
          message: 'Anonymous spooler worker crash',
          meta: {}, // no transactionId
        },
      ],
      pendingRefunds: [],
      recovery: { sessions: [] },
      receiptRecords: [],
      balance: 0,
      earnings: 0,
    } as any;

    const res = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    // Must be exactly 1, never 2
    expect(data.hardwareIncidents.spoolerFailures).toBe(1);
  });

  it('caps color and B&W pages printed to total printed pages', async () => {
    db.data = {
      financialLedger: [
        {
          id: 'fl-cap',
          eventType: 'payment_received',
          amount: 25,
          referenceId: 'tx-cap',
          timestamp: '2026-10-07T12:00:00Z',
        },
      ],
      owedChanges: [],
      adminLogs: [
        {
          id: 'log-cap',
          type: 'print_job_completed',
          timestamp: '2026-10-07T12:00:00Z',
          message: 'Print completed',
          meta: {
            transactionId: 'tx-cap',
            mode: 'print',
            totalPages: 5,
            pagesPrinted: 5,
            colorPages: 4,
            bwPages: 4, // 4 + 4 = 8, exceeds pagesPrinted 5
          },
        },
      ],
      pendingRefunds: [],
      recovery: { sessions: [] },
      receiptRecords: [],
      balance: 0,
      earnings: 25,
    } as any;

    const res = await fetch(
      `${baseUrl}/api/admin/logs/transactions/page-output-summary`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.pages.totalPrinted).toBe(5);
    expect(data.pages.colorPagesPrinted).toBe(4);
    expect(data.pages.bwPagesPrinted).toBe(1); // capped: 5 - 4 = 1
    expect(data.pages.colorPagesPrinted + data.pages.bwPagesPrinted).toBe(data.pages.totalPrinted);
  });

  it('registers route with requireAdminLocalAccess and requireAdminPin middleware', () => {
    const routeLayer = adminController.router.stack.find(
      (layer: any) =>
        layer.route?.path === '/logs/transactions/page-output-summary' &&
        layer.route?.methods?.get,
    );
    expect(routeLayer).toBeDefined();
    // Middleware chain: requireAdminLocalAccess + requireAdminPin + handleGetPageOutputSummary
    expect(routeLayer?.route?.stack?.length).toBeGreaterThanOrEqual(3);
  });
});
