import { adminService } from '@/modules/admin/admin.service';
import { adminLogStore } from '@/core/database/sqlite-storage';
import { db } from '@/core/database/db';
import type { FinancialLedgerEntry } from '@/core/database/models/payment.model';

describe('Earnings Analytics and Copy Job Recording', () => {
  beforeEach(() => {
    adminLogStore.clear();
    db.data = {
      ...db.data!,
      earnings: 0,
      financialLedger: [],
      pendingRefunds: [],
    };
  });

  afterAll(() => {
    adminLogStore.clear();
  });

  describe('computeDetailedEarningsAnalytics', () => {
    it('records copy earnings in methods.copy and period total when job_completed exists in financialLedger', () => {
      const now = new Date();
      const ledgerEntry: FinancialLedgerEntry = {
        id: 'ledger-copy-1',
        timestamp: now.toISOString(),
        timestampMeta: {
          source: 'system' as const,
          synced: false,
          offsetMs: null,
          detail: null,
        },
        eventType: 'job_completed',
        amount: 25.5,
        referenceId: 'copy-job-123',
        meta: {
          mode: 'copy',
          changeState: 'none',
        },
        previousHash: null,
        hash: 'test-hash-1',
      };

      db.data!.financialLedger = [ledgerEntry];
      db.data!.earnings = 25.5;

      const result = adminService.computeDetailedEarningsAnalytics({
        view: 'daily',
        anchor: now,
        now,
      });

      expect(result.methods.copy).toBe(25.5);
      expect(result.totals.period).toBe(25.5);
      expect(result.totals.today).toBe(25.5);
    });

    it('deducts refunds for copy jobs from methods.copy', () => {
      const now = new Date();
      const completedEntry: FinancialLedgerEntry = {
        id: 'ledger-copy-1',
        timestamp: now.toISOString(),
        timestampMeta: {
          source: 'system' as const,
          synced: false,
          offsetMs: null,
          detail: null,
        },
        eventType: 'job_completed',
        amount: 20.0,
        referenceId: 'copy-job-456',
        meta: {
          mode: 'copy',
        },
        previousHash: null,
        hash: 'hash-completed',
      };

      const refundEntry: FinancialLedgerEntry = {
        id: 'ledger-refund-1',
        timestamp: now.toISOString(),
        timestampMeta: {
          source: 'system' as const,
          synced: false,
          offsetMs: null,
          detail: null,
        },
        eventType: 'refund_issued',
        amount: 10.0,
        referenceId: 'copy-job-456',
        meta: {
          mode: 'copy',
        },
        previousHash: 'hash-completed',
        hash: 'hash-refund',
      };

      db.data!.financialLedger = [refundEntry, completedEntry];
      db.data!.earnings = 10.0;

      const result = adminService.computeDetailedEarningsAnalytics({
        view: 'daily',
        anchor: now,
        now,
      });

      expect(result.methods.copy).toBe(10.0);
      expect(result.totals.period).toBe(10.0);
    });
  });

  describe('computeEarningsBuckets', () => {
    it('includes copy earnings logged as payment_confirmed', () => {
      const now = new Date();
      adminLogStore.append(
        {
          id: 'log-copy-pc',
          timestamp: now.toISOString(),
          type: 'payment_confirmed',
          message: 'Payment confirmed.',
          meta: {
            transactionId: 'copy-tx-789',
            mode: 'copy',
            amount: 15.0,
          },
        },
        100,
      );

      const buckets = adminService.computeEarningsBuckets(now);
      expect(buckets.today).toBe(15.0);
      expect(buckets.week).toBe(15.0);
    });

    it('includes historical copy earnings logged as copy_job_enqueued with chargedAmount', () => {
      const now = new Date();
      adminLogStore.append(
        {
          id: 'log-copy-enq',
          timestamp: now.toISOString(),
          type: 'copy_job_enqueued',
          message: 'Copy job settled and enqueued.',
          meta: {
            jobId: 'copy-tx-historical',
            chargedAmount: 12.5,
            mode: 'copy',
          },
        },
        100,
      );

      const buckets = adminService.computeEarningsBuckets(now);
      expect(buckets.today).toBe(12.5);
      expect(buckets.week).toBe(12.5);
    });

    it('does not double count when both copy_job_enqueued and payment_confirmed exist for the same transaction', () => {
      const now = new Date();
      adminLogStore.append(
        {
          id: 'log-copy-enq-1',
          timestamp: now.toISOString(),
          type: 'copy_job_enqueued',
          message: 'Copy job settled and enqueued.',
          meta: {
            jobId: 'copy-tx-dedup',
            chargedAmount: 18.0,
            mode: 'copy',
          },
        },
        100,
      );
      adminLogStore.append(
        {
          id: 'log-copy-pc-1',
          timestamp: now.toISOString(),
          type: 'payment_confirmed',
          message: 'Payment confirmed.',
          meta: {
            transactionId: 'copy-tx-dedup',
            amount: 18.0,
            mode: 'copy',
          },
        },
        100,
      );

      const buckets = adminService.computeEarningsBuckets(now);
      expect(buckets.today).toBe(18.0);
      expect(buckets.week).toBe(18.0);
    });

    it('excludes copy_job_failed transactions from earnings totals', () => {
      const now = new Date();
      adminLogStore.append(
        {
          id: 'log-copy-failed-1',
          timestamp: now.toISOString(),
          type: 'copy_job_enqueued',
          message: 'Copy job settled and enqueued.',
          meta: { jobId: 'copy-tx-will-fail', chargedAmount: 22.0 },
        },
        100,
      );
      adminLogStore.append(
        {
          id: 'log-copy-failed-2',
          timestamp: now.toISOString(),
          type: 'copy_job_failed',
          message: 'Copy job failed.',
          meta: { jobId: 'copy-tx-will-fail', error: 'printer unavailable' },
        },
        100,
      );

      const buckets = adminService.computeEarningsBuckets(now);
      expect(buckets.today).toBe(0);
      expect(buckets.week).toBe(0);
    });
  });

  describe('Historical copy transaction reconciliation', () => {
    it('findUnreconciledCopyTransactions detects copy_job_enqueued not in financialLedger', () => {
      const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      adminLogStore.append(
        {
          id: 'hist-log-1',
          timestamp: past,
          type: 'copy_job_enqueued',
          message: 'Copy job settled and enqueued.',
          meta: {
            jobId: 'hist-tx-001',
            transactionId: 'hist-tx-001',
            amount: 30.0,
            chargedAmount: 30.0,
            copies: 3,
          },
        },
        100,
      );

      const result = adminService.findUnreconciledCopyTransactions(new Set());
      expect(result.length).toBe(1);
      expect(result[0].txId).toBe('hist-tx-001');
      expect(result[0].amount).toBe(30.0);
    });

    it('findUnreconciledCopyTransactions skips transactions already in financialLedger', () => {
      const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      adminLogStore.append(
        {
          id: 'hist-log-2',
          timestamp: past,
          type: 'copy_job_enqueued',
          message: 'Copy job settled and enqueued.',
          meta: {
            jobId: 'hist-tx-002',
            transactionId: 'hist-tx-002',
            amount: 15.0,
            chargedAmount: 15.0,
          },
        },
        100,
      );

      const alreadyReconciled = new Set(['hist-tx-002']);
      const result = adminService.findUnreconciledCopyTransactions(alreadyReconciled);
      expect(result.length).toBe(0);
    });

    it('findUnreconciledCopyTransactions skips failed copy transactions', () => {
      const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      adminLogStore.append(
        {
          id: 'hist-log-failed-1',
          timestamp: past,
          type: 'copy_job_enqueued',
          message: 'Copy job settled and enqueued.',
          meta: {
            jobId: 'hist-tx-failed',
            transactionId: 'hist-tx-failed',
            amount: 25.0,
            chargedAmount: 25.0,
          },
        },
        100,
      );
      adminLogStore.append(
        {
          id: 'hist-log-failed-2',
          timestamp: past,
          type: 'copy_job_failed',
          message: 'Copy job failed.',
          meta: {
            jobId: 'hist-tx-failed',
            transactionId: 'hist-tx-failed',
            error: 'printer unavailable',
          },
        },
        100,
      );

      const result = adminService.findUnreconciledCopyTransactions(new Set());
      expect(result.length).toBe(0);
    });

    it('computeDetailedEarningsAnalytics surfaces historical unreconciled copy logs', () => {
      const now = new Date();
      const past = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      adminLogStore.append(
        {
          id: 'hist-analytics-log',
          timestamp: past.toISOString(),
          type: 'copy_job_enqueued',
          message: 'Copy job settled and enqueued.',
          meta: {
            jobId: 'hist-analytics-tx',
            transactionId: 'hist-analytics-tx',
            amount: 40.0,
            chargedAmount: 40.0,
          },
        },
        100,
      );

      // financialLedger is empty — no reconciled entries
      db.data!.financialLedger = [];

      const result = adminService.computeDetailedEarningsAnalytics({
        view: 'daily',
        anchor: now,
        now,
      });

      expect(result.methods.copy).toBe(40.0);
      expect(result.totals.today).toBe(40.0);
    });
  });
});
