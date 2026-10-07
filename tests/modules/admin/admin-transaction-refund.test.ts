import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { db } from '@/services/db';
import { AdminController } from '@/modules/admin/admin.controller';
import { AdminService } from '@/modules/admin/admin.service';
import { ConsumablesService } from '@/modules/admin/consumables.service';
import { financialLedgerService } from '@/services/financial-ledger';
import { TrustedTimeError, type TrustedTimeStatus } from '@/services/time-source';

let mockTrustedTimeSynced = true;

jest.mock('@/middleware/admin-auth', () => ({
  requireAdminLocalAccess: (_req: any, _res: any, next: any) => next(),
  requireAdminPin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('@/services/time-source', () => {
  const actual = jest.requireActual('@/services/time-source');
  return {
    ...actual,
    assertTrustedTimeForFinancialOperation: jest.fn((op: string) => {
      if (!mockTrustedTimeSynced) {
        const status: TrustedTimeStatus = {
          source: 'system',
          synced: false,
          offsetMs: null,
          driftExceeded: false,
          maxDriftMs: 5000,
          enforceForFinancial: true,
          checkedAt: new Date().toISOString(),
          detail: 'Mock clock desynchronized',
          ntpSource: null,
          lastSuccessfulSyncAt: null,
        };
        throw new actual.TrustedTimeError(op, status);
      }
    }),
    getTrustedTimestamp: () => ({
      timestamp: '2026-10-07T12:00:00.000Z',
      meta: {
        source: 'ntp',
        synced: true,
        offsetMs: 0,
        detail: 'Synchronized',
      },
    }),
  };
});

describe('Admin Transaction Cash Refund API', () => {
  let app: Express;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const adminService = new AdminService();
    const consumablesService = new ConsumablesService();
    const adminController = new AdminController(adminService, consumablesService, {
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
  });

  beforeEach(() => {
    mockTrustedTimeSynced = true;
    db.data = {
      balance: 100,
      earnings: 500,
      pendingRefunds: [],
      financialLedger: [],
      owedChanges: [],
      adminLogs: [],
      recovery: { sessions: [] },
      paperTray: { sheets: 50, maxCapacity: 150 },
    } as any;
  });

  it('deducts earnings, does NOT alter machine balance, and appends ledger entry on physical cash refund', async () => {
    const txId = 'tx-test-123';
    // Seed an initial payment log or transaction record
    db.data!.financialLedger.push({
      id: 'led-1',
      eventType: 'payment_received',
      amount: 40,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    const res = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: 25,
          reason: 'Partial jam on page 2',
          unprintedPages: 3,
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactionId).toBe(txId);

    // Critical financial invariants
    expect(db.data!.balance).toBe(100); // BALANCE UNTOUCHED
    expect(db.data!.earnings).toBe(475); // 500 - 25

    // Ledger inspection
    const refundEvent = db.data!.financialLedger.find(
      (e) => e.referenceId === txId && e.eventType === 'refund_issued',
    );
    expect(refundEvent).toBeDefined();
    expect(refundEvent!.amount).toBe(25);
    expect(refundEvent!.meta?.payoutType).toBe('cash');
    expect(refundEvent!.meta?.source).toBe('admin_cash_refund');
    expect(refundEvent!.meta?.reason).toBe('Partial jam on page 2');
    expect(refundEvent!.meta?.unprintedPages).toBe(3);

    // Pending refund sync
    const pendingRefund = db.data!.pendingRefunds.find(
      (e) => e.jobContext.transactionId === txId,
    );
    expect(pendingRefund).toBeDefined();
    expect(pendingRefund!.status).toBe('refunded');
    expect(pendingRefund!.closedAt).toBe('2026-10-07T12:00:00.000Z');
    expect(pendingRefund!.jobContext.payoutType).toBe('cash');
  });

  it('closes existing open pending refund when issuing physical cash refund', async () => {
    const txId = 'tx-pending-sync-test';
    db.data!.financialLedger.push({
      id: 'led-existing',
      eventType: 'job_completed',
      amount: 50,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    db.data!.pendingRefunds.push({
      id: 'pref-123',
      timestamp: '2026-10-07T11:55:00.000Z',
      chargedAmount: 50,
      reason: 'Spooler crash',
      status: 'open',
      closedAt: null,
      jobContext: {
        transactionId: txId,
      },
    });

    const res = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: 50,
          reason: 'Admin resolved crash via cash payout',
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(db.data!.balance).toBe(100);
    expect(db.data!.earnings).toBe(450);

    const openRemaining = db.data!.pendingRefunds.filter(
      (e) => e.jobContext.transactionId === txId && e.status === 'open',
    );
    expect(openRemaining).toHaveLength(0);

    const closedEntry = db.data!.pendingRefunds.find((e) => e.id === 'pref-123');
    expect(closedEntry).toBeDefined();
    expect(closedEntry!.status).toBe('refunded');
    expect(closedEntry!.closedAt).toBe('2026-10-07T12:00:00.000Z');
    expect(closedEntry!.jobContext.payoutType).toBe('cash');
  });

  it('rejects refund if amount exceeds max refundable', async () => {
    const txId = 'tx-cap-test';
    db.data!.financialLedger.push({
      id: 'led-2',
      eventType: 'payment_received',
      amount: 30,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    const res = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 50, reason: 'Too much' }),
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds/i);
    expect(db.data!.earnings).toBe(500); // Unchanged
    expect(db.data!.balance).toBe(100); // Unchanged
  });

  it('rejects refund if amount is not positive', async () => {
    const txId = 'tx-negative-test';
    db.data!.financialLedger.push({
      id: 'led-3',
      eventType: 'payment_received',
      amount: 30,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    const resZero = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 0, reason: 'Zero amount' }),
      },
    );
    expect(resZero.status).toBe(400);

    const resNegative = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: -10, reason: 'Negative amount' }),
      },
    );
    expect(resNegative.status).toBe(400);
  });

  it('fails with 503 when trusted time assertion fails', async () => {
    const txId = 'tx-time-fail';
    db.data!.financialLedger.push({
      id: 'led-4',
      eventType: 'payment_received',
      amount: 40,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    mockTrustedTimeSynced = false;

    const res = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 20, reason: 'Cash refund' }),
      },
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('TRUSTED_TIME_UNAVAILABLE');
    expect(db.data!.earnings).toBe(500); // Unchanged
    expect(db.data!.balance).toBe(100); // Unchanged
  });

  it('returns 404 if transaction is not found', async () => {
    const res = await fetch(
      `${baseUrl}/api/admin/transactions/non-existent-tx/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 10, reason: 'Ghost' }),
      },
    );

    expect(res.status).toBe(404);
  });
});
