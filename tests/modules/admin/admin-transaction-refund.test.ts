import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { db } from '@/services/db';
import { AdminController } from '@/modules/admin/admin.controller';
import { AdminService } from '@/modules/admin/admin.service';
import { ConsumablesService } from '@/modules/admin/consumables.service';
import { financialLedgerService } from '@/services/financial-ledger';
import { TrustedTimeError, type TrustedTimeStatus } from '@/services/time-source';
import { ReceiptService } from '@/modules/receipt';

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

  it('handles cumulative partial refunds and enforces cap against prior refunds sum', async () => {
    const txId = 'tx-cumulative-test';
    db.data!.financialLedger.push({
      id: 'led-cum-1',
      eventType: 'payment_received',
      amount: 40,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    // 1st refund: 25 -> OK
    const res1 = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 25, reason: 'First partial refund' }),
      },
    );
    expect(res1.status).toBe(200);
    expect(db.data!.earnings).toBe(475); // 500 - 25

    // 2nd refund: 15 -> OK (total 40 refunded out of 40)
    const res2 = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 15, reason: 'Second partial refund' }),
      },
    );
    expect(res2.status).toBe(200);
    expect(db.data!.earnings).toBe(460); // 475 - 15

    // 3rd refund: 1 -> Rejected (exceeds cap)
    const res3 = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1, reason: 'Over-refund attempt' }),
      },
    );
    expect(res3.status).toBe(400);
    const body3 = await res3.json();
    expect(body3.error).toMatch(/exceeds maximum refundable amount/i);
    expect(db.data!.earnings).toBe(460); // Unchanged
  });

  it('includes auto-spooler failure refunds linked to transaction in prior refunds sum', async () => {
    const txId = 'tx-spooler-linked-test';
    db.data!.financialLedger.push({
      id: 'led-spooler-init',
      eventType: 'job_completed',
      amount: 50,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    const spoolerPrefId = 'pref-auto-spooler-88';
    db.data!.pendingRefunds.push({
      id: spoolerPrefId,
      timestamp: '2026-10-07T11:52:00.000Z',
      chargedAmount: 30,
      reason: 'Spooler timeout auto-refund',
      status: 'refunded',
      closedAt: '2026-10-07T11:52:00.000Z',
      payoutType: 'cash',
      jobContext: {
        transactionId: txId,
        payoutType: 'cash',
      },
    });

    db.data!.financialLedger.push({
      id: 'led-auto-spooler',
      eventType: 'refund_issued',
      amount: 30,
      referenceId: spoolerPrefId, // Reference is the pending refund ID
      timestamp: '2026-10-07T11:52:00.000Z',
    } as any);

    // Remaining refundable is 50 - 30 = 20. Requesting 25 should be rejected.
    const resOver = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 25, reason: 'Exceed remaining' }),
      },
    );
    expect(resOver.status).toBe(400);
    const bodyOver = await resOver.json();
    expect(bodyOver.error).toMatch(/exceeds/i);

    // Requesting exactly 20 should succeed
    const resExact = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 20, reason: 'Remaining refund' }),
      },
    );
    expect(resExact.status).toBe(200);
    expect(db.data!.earnings).toBe(480); // 500 - 20
  });

  it('updates receipt status to refunded and prevents receipt status from shadowing refund in transaction context', async () => {
    const txId = 'tx-receipt-test-456';
    const receiptService = new ReceiptService();
    receiptService.upsertReceiptSnapshot({
      transactionId: txId,
      mode: 'print',
      chargedAmount: 35,
      status: 'printed',
    });

    const res = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 35, reason: 'Full refund after printed failure' }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Context status must be 'refunded', not 'printed'
    expect(body.status).toBe('refunded');

    // Underlying receipt store must also be updated
    const resolution = receiptService.resolveByTransactionId(txId);
    expect(resolution.status).toBe('ok');
    if (resolution.status === 'ok') {
      expect(resolution.receipt.status).toBe('refunded');
    }
  });

  it('rejects refund if unprintedPages is invalid (negative or non-integer)', async () => {
    const txId = 'tx-unprinted-pages-test';
    db.data!.financialLedger.push({
      id: 'led-unp',
      eventType: 'payment_received',
      amount: 40,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    const resNeg = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 10, reason: 'Jam', unprintedPages: -2 }),
      },
    );
    expect(resNeg.status).toBe(400);
    const bodyNeg = await resNeg.json();
    expect(bodyNeg.error).toMatch(/unprintedPages must be a non-negative integer/i);

    const resDec = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 10, reason: 'Jam', unprintedPages: 1.5 }),
      },
    );
    expect(resDec.status).toBe(400);
  });

  it('rolls back in-memory earnings mutation if financialLedgerService.append throws', async () => {
    const txId = 'tx-rollback-test';
    db.data!.financialLedger.push({
      id: 'led-rb',
      eventType: 'payment_received',
      amount: 40,
      referenceId: txId,
      timestamp: '2026-10-07T11:50:00.000Z',
    } as any);

    const originalAppend = financialLedgerService.append;
    jest.spyOn(financialLedgerService, 'append').mockImplementationOnce(async () => {
      throw new Error('Disk IO write failure simulation');
    });

    const res = await fetch(
      `${baseUrl}/api/admin/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 20, reason: 'Test rollback' }),
      },
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to process cash refund.');
    // Earnings must be rolled back to 500
    expect(db.data!.earnings).toBe(500);
    expect(db.data!.balance).toBe(100);

    jest.spyOn(financialLedgerService, 'append').mockRestore();
  });
});
