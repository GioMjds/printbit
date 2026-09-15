import { adminService } from '@/modules/admin/admin.service';
import { adminLogStore } from '@/core/database/sqlite-storage';
import { type AdminLogEntry } from '@/modules/admin/admin.schema';

describe('Transaction ID flexible filtering', () => {
  const sampleTxId = 'c02b9f3d-59bb-4cb3-a612-87063d8985c5';
  const logEntry: AdminLogEntry = {
    id: 'test-log-1',
    timestamp: new Date().toISOString(),
    type: 'payment_received',
    message: 'Payment received: ₱10.00',
    meta: {
      transactionId: sampleTxId,
      chargedAmount: 10,
      mode: 'print',
      status: 'completed',
    },
  };

  beforeEach(() => {
    adminLogStore.clear();
    adminLogStore.append(logEntry, 100);
  });

  afterAll(() => {
    adminLogStore.clear();
  });

  it('filters by full transaction ID', () => {
    const results = adminService.listTransactionLogs(50, {
      transactionId: sampleTxId,
    });
    expect(results).toHaveLength(1);
    expect(results[0].meta?.transactionId).toBe(sampleTxId);
  });

  it('filters by transaction ID suffix', () => {
    const results = adminService.listTransactionLogs(50, {
      transactionId: '8985c5',
    });
    expect(results).toHaveLength(1);
    expect(results[0].meta?.transactionId).toBe(sampleTxId);
  });

  it('filters by transaction ID prefix', () => {
    const results = adminService.listTransactionLogs(50, {
      transactionId: 'c02b9f3d',
    });
    expect(results).toHaveLength(1);
    expect(results[0].meta?.transactionId).toBe(sampleTxId);
  });

  it('filters by transaction ID case-insensitively', () => {
    const results = adminService.listTransactionLogs(50, {
      transactionId: '8985C5',
    });
    expect(results).toHaveLength(1);
    expect(results[0].meta?.transactionId).toBe(sampleTxId);
  });

  it('filters by transaction ID with whitespace trimmed', () => {
    const results = adminService.listTransactionLogs(50, {
      transactionId: '  8985c5  ',
    });
    expect(results).toHaveLength(1);
    expect(results[0].meta?.transactionId).toBe(sampleTxId);
  });

  it('filters by transaction ID without hyphens', () => {
    const results = adminService.listTransactionLogs(50, {
      transactionId: 'c02b9f3d59bb',
    });
    expect(results).toHaveLength(1);
    expect(results[0].meta?.transactionId).toBe(sampleTxId);
  });
});
