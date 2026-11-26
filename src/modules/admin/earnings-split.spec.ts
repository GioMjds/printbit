import type { FinancialLedgerEntry, LogMeta } from '@/services/db';
import { sumDirectLedger } from './earnings-split';

let seq = 0;
function ledger(
  eventType: string,
  timestamp: string,
  amount: number,
  meta: LogMeta,
): FinancialLedgerEntry {
  seq += 1;
  return {
    id: `led-${seq}`,
    timestamp,
    timestampMeta: {} as never,
    eventType: eventType as FinancialLedgerEntry['eventType'],
    amount,
    referenceId: null,
    meta,
    previousHash: null,
    hash: '',
  };
}

describe('sumDirectLedger', () => {
  it('sums direct completions minus direct refunds only', () => {
    const entries = [
      ledger('job_completed', '2026-11-26T08:00:00', 8, {
        paymentSource: 'direct',
      }),
      ledger('refund_issued', '2026-11-26T08:30:00', 3, {
        paymentSource: 'direct',
      }),
      ledger('job_completed', '2026-11-26T08:45:00', 50, { mode: 'print' }),
      ledger('job_completed', '2026-11-02T08:00:00', 6, {
        paymentSource: 'direct',
      }),
      ledger('job_completed', '2026-03-01T08:00:00', 2, {
        paymentSource: 'direct',
      }),
      ledger('job_completed', '2025-12-31T08:00:00', 4, {
        paymentSource: 'direct',
      }),
      ledger('job_completed', '2026-11-26T09:00:00', 99, {
        paymentSource: 'direct',
        environment: 'test',
      }),
      ledger('job_started', '2026-11-26T07:59:00', 8, {
        paymentSource: 'direct',
      }),
    ];

    expect(
      sumDirectLedger(entries, {
        startOfToday: new Date('2026-11-26T00:00:00'),
        startOfWeek: new Date('2026-11-20T00:00:00'),
        startOfMonth: new Date('2026-11-01T00:00:00'),
        startOfYear: new Date('2026-01-01T00:00:00'),
      }),
    ).toEqual({ today: 5, week: 5, month: 11, year: 13, allTime: 17 });
  });
});
