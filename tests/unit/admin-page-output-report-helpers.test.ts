import {
  formatReportScope,
  getFulfillmentBadgeClass,
  generatePageOutputCsv,
  PageOutputSummaryResponse,
} from '../../src/public/admin/transactions/page-output-report-helpers';

describe('Admin Page Output Report Helpers', () => {
  const sampleSummary: PageOutputSummaryResponse = {
    scope: {
      totalTransactions: 42,
      dateFrom: '2026-10-01T08:00:00.000Z',
      dateTo: '2026-10-07T18:00:00.000Z',
    },
    financials: {
      grossCharged: 1250.5,
      cashRefundsIssued: 50.25,
      refundCount: 2,
      netCashRetained: 1200.25,
      unresolvedOwedChange: 15.0,
      unresolvedOwedChangeCount: 1,
    },
    pages: {
      totalRequested: 250,
      totalPrinted: 240,
      totalFailed: 10,
      fulfillmentRatePercent: 96.0,
      colorPagesPrinted: 80,
      bwPagesPrinted: 160,
    },
    hardwareIncidents: {
      spoolerFailures: 1,
      hopperShortfalls: 2,
    },
  };

  describe('formatReportScope', () => {
    it('formats scope with both dateFrom and dateTo', () => {
      const formatted = formatReportScope({
        totalTransactions: 5,
        dateFrom: '2026-10-01T00:00:00.000Z',
        dateTo: '2026-10-05T00:00:00.000Z',
      });
      expect(formatted).toBe('2026-10-01 to 2026-10-05 · 5 transactions analyzed');
    });

    it('formats scope with singular transaction', () => {
      const formatted = formatReportScope({
        totalTransactions: 1,
        dateFrom: '2026-10-01T00:00:00.000Z',
        dateTo: '2026-10-05T00:00:00.000Z',
      });
      expect(formatted).toBe('2026-10-01 to 2026-10-05 · 1 transaction analyzed');
    });

    it('formats scope with only dateFrom', () => {
      const formatted = formatReportScope({
        totalTransactions: 12,
        dateFrom: '2026-10-01T00:00:00.000Z',
        dateTo: null,
      });
      expect(formatted).toBe('From 2026-10-01 · 12 transactions analyzed');
    });

    it('formats scope with only dateTo', () => {
      const formatted = formatReportScope({
        totalTransactions: 8,
        dateFrom: null,
        dateTo: '2026-10-07T00:00:00.000Z',
      });
      expect(formatted).toBe('Up to 2026-10-07 · 8 transactions analyzed');
    });

    it('formats scope with all time (neither dateFrom nor dateTo)', () => {
      const formatted = formatReportScope({
        totalTransactions: 100,
        dateFrom: null,
        dateTo: null,
      });
      expect(formatted).toBe('All time · 100 transactions analyzed');
    });
  });

  describe('getFulfillmentBadgeClass', () => {
    it('returns good badge for >= 95%', () => {
      expect(getFulfillmentBadgeClass(100)).toBe('page-report-rate-badge--good');
      expect(getFulfillmentBadgeClass(95)).toBe('page-report-rate-badge--good');
      expect(getFulfillmentBadgeClass(95.5)).toBe('page-report-rate-badge--good');
    });

    it('returns warn badge for 80% to 94.9%', () => {
      expect(getFulfillmentBadgeClass(94.9)).toBe('page-report-rate-badge--warn');
      expect(getFulfillmentBadgeClass(80)).toBe('page-report-rate-badge--warn');
      expect(getFulfillmentBadgeClass(85.2)).toBe('page-report-rate-badge--warn');
    });

    it('returns alert badge for < 80%', () => {
      expect(getFulfillmentBadgeClass(79.9)).toBe('page-report-rate-badge--alert');
      expect(getFulfillmentBadgeClass(50)).toBe('page-report-rate-badge--alert');
      expect(getFulfillmentBadgeClass(0)).toBe('page-report-rate-badge--alert');
    });
  });

  describe('generatePageOutputCsv', () => {
    it('generates well-formed CSV with all scope, financials, pages, and incidents fields', () => {
      const fixedIso = '2026-10-08T12:00:00.000Z';
      const csv = generatePageOutputCsv(sampleSummary, fixedIso);

      expect(csv).toContain('"Category","Metric","Value"');
      expect(csv).toContain('"Scope","Report Generation Timestamp","2026-10-08T12:00:00.000Z"');
      expect(csv).toContain('"Scope","Filter Date From","2026-10-01T08:00:00.000Z"');
      expect(csv).toContain('"Scope","Filter Date To","2026-10-07T18:00:00.000Z"');
      expect(csv).toContain('"Scope","Transactions Analyzed","42"');

      expect(csv).toContain('"Financials","Gross Charged (PHP)","1250.50"');
      expect(csv).toContain('"Financials","Cash Refunds Issued (PHP)","50.25"');
      expect(csv).toContain('"Financials","Cash Refund Count","2"');
      expect(csv).toContain('"Financials","Net Cash Retained (PHP)","1200.25"');
      expect(csv).toContain('"Financials","Unresolved Owed Change (PHP)","15.00"');
      expect(csv).toContain('"Financials","Unresolved Owed Change Count","1"');

      expect(csv).toContain('"Page Production","Total Requested Pages","250"');
      expect(csv).toContain('"Page Production","Total Printed Pages","240"');
      expect(csv).toContain('"Page Production","Total Failed Pages","10"');
      expect(csv).toContain('"Page Production","Fulfillment Rate (%)","96%"');
      expect(csv).toContain('"Page Production","Color Pages","80"');
      expect(csv).toContain('"Page Production","B&W Pages","160"');

      expect(csv).toContain('"Incidents","Spooler Failures","1"');
      expect(csv).toContain('"Incidents","Hopper Shortfalls","2"');
    });

    it('handles null date ranges in CSV', () => {
      const summaryNoDates: PageOutputSummaryResponse = {
        ...sampleSummary,
        scope: {
          totalTransactions: 0,
          dateFrom: null,
          dateTo: null,
        },
      };
      const csv = generatePageOutputCsv(summaryNoDates, '2026-10-08T00:00:00.000Z');
      expect(csv).toContain('"Scope","Filter Date From","All"');
      expect(csv).toContain('"Scope","Filter Date To","All"');
      expect(csv).toContain('"Scope","Transactions Analyzed","0"');
    });
  });
});
