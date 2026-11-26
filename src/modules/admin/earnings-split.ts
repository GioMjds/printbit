import type { FinancialLedgerEntry } from '@/services/db';

/** Direct (bypass) revenue derived from tagged ledger entries; refunds subtract. */
export function sumDirectLedger(
  entries: Iterable<FinancialLedgerEntry>,
  bounds: {
    startOfToday: Date;
    startOfWeek: Date;
    startOfMonth: Date;
    startOfYear: Date;
  },
): {
  today: number;
  week: number;
  month: number;
  year: number;
  allTime: number;
} {
  const totals = { today: 0, week: 0, month: 0, year: 0, allTime: 0 };
  for (const entry of entries) {
    if (entry.meta?.paymentSource !== 'direct') continue;
    if (entry.meta?.environment === 'test') continue;
    if (
      entry.eventType !== 'job_completed' &&
      entry.eventType !== 'refund_issued'
    ) {
      continue;
    }
    const amount = Number(entry.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const ts = new Date(entry.timestamp);
    if (Number.isNaN(ts.getTime())) continue;

    const signed = entry.eventType === 'refund_issued' ? -amount : amount;
    totals.allTime += signed;
    if (ts >= bounds.startOfToday) totals.today += signed;
    if (ts >= bounds.startOfWeek) totals.week += signed;
    if (ts >= bounds.startOfMonth) totals.month += signed;
    if (ts >= bounds.startOfYear) totals.year += signed;
  }
  return totals;
}
