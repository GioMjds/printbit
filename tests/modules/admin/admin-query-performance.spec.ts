import { adminService } from '@/modules/admin/admin.service';
import { adminLogStore, feedbackStore, reportIssueStore } from '@/core/database/sqlite-storage';
import { anomalyService } from '@/modules/anomaly/anomaly.service';
import { db } from '@/core/database/db';
import { type AdminLogEntry } from '@/modules/admin/admin.schema';

describe('Admin Panel Database Queries & Performance', () => {
  beforeAll(async () => {
    await db.read();
  });

  beforeEach(() => {
    adminLogStore.clear();
  });

  afterAll(() => {
    adminLogStore.clear();
  });

  it('correctly separates and queries system logs vs transaction logs', async () => {
    const sysLog1: AdminLogEntry = {
      id: 'sys-1',
      timestamp: '2026-09-25T10:00:00.000Z',
      type: 'kiosk_lockdown_applied',
      message: 'Lockdown enabled',
    };
    const txLog1: AdminLogEntry = {
      id: 'tx-log-1',
      timestamp: '2026-09-25T10:01:00.000Z',
      type: 'payment_confirmed',
      message: 'Payment received: ₱10',
      meta: { transactionId: 'tx-123', mode: 'print' },
    };
    const txLog2: AdminLogEntry = {
      id: 'tx-log-2',
      timestamp: '2026-09-25T10:02:00.000Z',
      type: 'print_job_completed',
      message: 'Print job completed',
      meta: { transactionId: 'tx-123', mode: 'print' },
    };

    adminLogStore.append(sysLog1, 100);
    adminLogStore.append(txLog1, 100);
    adminLogStore.append(txLog2, 100);

    // System logs should only contain sysLog1
    const sysLogs = adminService.listSystemLogs(10);
    expect(sysLogs).toHaveLength(1);
    expect(sysLogs[0].id).toBe('sys-1');

    // Transaction logs should group txLog1 & txLog2 into 1 grouped transaction entry
    const txLogs = adminService.listTransactionLogs(10, {});
    expect(txLogs).toHaveLength(1);
    expect(txLogs[0].meta?.transactionId).toBe('tx-123');

    // Clear system logs should only delete system logs
    const deletedSys = adminService.clearSystemLogs();
    expect(deletedSys).toBe(1);
    expect(adminService.listSystemLogs(10)).toHaveLength(0);
    expect(adminService.listTransactionLogs(10, {})).toHaveLength(1);

    // Clear transaction logs should delete transaction logs
    const deletedTx = adminService.clearTransactionLogs();
    expect(deletedTx).toBe(2);
    expect(adminService.listTransactionLogs(10, {})).toHaveLength(0);
  });

  it('efficiently calculates feedback and report issue counts from SQLite', () => {
    const fbStats = feedbackStore.getFeedbackStats();
    expect(typeof fbStats.total).toBe('number');
    expect(typeof fbStats.open).toBe('number');
    expect(typeof fbStats.resolved).toBe('number');

    const reportStats = reportIssueStore.getReportIssueStats();
    expect(typeof reportStats.total).toBe('number');
    expect(typeof reportStats.open).toBe('number');
    expect(typeof reportStats.acknowledged).toBe('number');
    expect(typeof reportStats.resolved).toBe('number');
  });

  it('efficiently queries anomaly alerts with single-pass statistics', () => {
    const result = anomalyService.listIncidents({ limit: 10 });
    expect(typeof result.total).toBe('number');
    expect(typeof result.openCount).toBe('number');
    expect(typeof result.acknowledgedCount).toBe('number');
    expect(typeof result.resolvedCount).toBe('number');
    expect(Array.isArray(result.items)).toBe(true);
  });
});
