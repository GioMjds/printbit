export interface PageOutputSummaryResponse {
  scope: {
    totalTransactions: number;
    dateFrom: string | null;
    dateTo: string | null;
  };
  financials: {
    grossCharged: number;
    cashRefundsIssued: number;
    refundCount: number;
    netCashRetained: number;
    unresolvedOwedChange: number;
    unresolvedOwedChangeCount: number;
  };
  pages: {
    totalRequested: number;
    totalPrinted: number;
    totalFailed: number;
    fulfillmentRatePercent: number;
    colorPagesPrinted: number;
    bwPagesPrinted: number;
  };
  hardwareIncidents: {
    spoolerFailures: number;
    hopperShortfalls: number;
  };
}

export function formatReportScope(scope: {
  totalTransactions: number;
  dateFrom: string | null;
  dateTo: string | null;
}): string {
  const count = scope.totalTransactions;
  const countLabel = `${count} ${count === 1 ? 'transaction' : 'transactions'} analyzed`;

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toISOString().slice(0, 10);
    } catch {
      return iso;
    }
  };

  if (scope.dateFrom && scope.dateTo) {
    return `${formatDate(scope.dateFrom)} to ${formatDate(scope.dateTo)} · ${countLabel}`;
  }
  if (scope.dateFrom) {
    return `From ${formatDate(scope.dateFrom)} · ${countLabel}`;
  }
  if (scope.dateTo) {
    return `Up to ${formatDate(scope.dateTo)} · ${countLabel}`;
  }
  return `All time · ${countLabel}`;
}

export function getFulfillmentBadgeClass(
  rate: number,
): 'page-report-rate-badge--good' | 'page-report-rate-badge--warn' | 'page-report-rate-badge--alert' {
  if (rate >= 95) return 'page-report-rate-badge--good';
  if (rate >= 80) return 'page-report-rate-badge--warn';
  return 'page-report-rate-badge--alert';
}

export function generatePageOutputCsv(
  summary: PageOutputSummaryResponse,
  generatedAtIso?: string,
): string {
  const escapeCsv = (value: unknown): string => {
    const text = value == null ? '' : String(value);
    const escaped = text.replace(/"/g, '""');
    return `"${escaped}"`;
  };

  const rows: [string, string, string | number][] = [
    // Scope
    ['Scope', 'Report Generation Timestamp', generatedAtIso ?? new Date().toISOString()],
    ['Scope', 'Filter Date From', summary.scope.dateFrom ?? 'All'],
    ['Scope', 'Filter Date To', summary.scope.dateTo ?? 'All'],
    ['Scope', 'Transactions Analyzed', summary.scope.totalTransactions],

    // Financials
    ['Financials', 'Gross Charged (PHP)', Number(summary.financials.grossCharged).toFixed(2)],
    ['Financials', 'Cash Refunds Issued (PHP)', Number(summary.financials.cashRefundsIssued).toFixed(2)],
    ['Financials', 'Cash Refund Count', summary.financials.refundCount],
    ['Financials', 'Net Cash Retained (PHP)', Number(summary.financials.netCashRetained).toFixed(2)],
    ['Financials', 'Unresolved Owed Change (PHP)', Number(summary.financials.unresolvedOwedChange).toFixed(2)],
    ['Financials', 'Unresolved Owed Change Count', summary.financials.unresolvedOwedChangeCount],

    // Page Production
    ['Page Production', 'Total Requested Pages', summary.pages.totalRequested],
    ['Page Production', 'Total Printed Pages', summary.pages.totalPrinted],
    ['Page Production', 'Total Failed Pages', summary.pages.totalFailed],
    ['Page Production', 'Fulfillment Rate (%)', `${summary.pages.fulfillmentRatePercent}%`],
    ['Page Production', 'Color Pages', summary.pages.colorPagesPrinted],
    ['Page Production', 'B&W Pages', summary.pages.bwPagesPrinted],

    // Incidents
    ['Incidents', 'Spooler Failures', summary.hardwareIncidents.spoolerFailures],
    ['Incidents', 'Hopper Shortfalls', summary.hardwareIncidents.hopperShortfalls],
  ];

  const header = ['Category', 'Metric', 'Value'].map(escapeCsv).join(',');
  const csvLines = [header];
  for (const [category, metric, value] of rows) {
    csvLines.push([escapeCsv(category), escapeCsv(metric), escapeCsv(value)].join(','));
  }
  return csvLines.join('\r\n');
}
