/**
 * Calculates a suggested pro-rated refund amount based on unprinted pages.
 *
 * Formula: ((N - K) / N) * chargedAmount, rounded to 2 decimal places (centavos).
 *
 * @param requestedPages Total pages requested (N)
 * @param printedPages Successfully printed pages (K)
 * @param chargedAmount Total amount charged in currency units (e.g. PHP)
 * @returns Suggested refund amount rounded to 2 decimal places, or 0 if no refund is due.
 */
export function calculateSuggestedRefund(
  requestedPages: number,
  printedPages: number,
  chargedAmount: number,
): number {
  if (!Number.isFinite(requestedPages) || requestedPages <= 0) return 0;
  if (!Number.isFinite(chargedAmount) || chargedAmount <= 0) return 0;
  const printed = Number.isFinite(printedPages) ? Math.max(0, printedPages) : 0;
  if (printed >= requestedPages) return 0;
  const unprinted = requestedPages - printed;
  return Math.round(((unprinted / requestedPages) * chargedAmount) * 100) / 100;
}

export type LedgerRefundEntry = {
  eventType: string;
  amount: number;
  referenceId?: string | null;
  id?: string;
};

export type PendingRefundSummary = {
  id: string;
  status: string;
  chargedAmount: number;
};

/**
 * Calculates the total sum of prior refunds issued for a transaction.
 *
 * Sums ledger `refund_issued` entries and accounts for any refunded `pendingRefunds`
 * not yet referenced in the ledger, avoiding double counting.
 */
export function calculatePriorRefunds(
  ledgerEntries: LedgerRefundEntry[] = [],
  pendingRefunds: PendingRefundSummary[] = [],
  transactionId?: string,
): number {
  const refundLedgerEntries = (ledgerEntries || []).filter(
    (entry) => entry && entry.eventType === 'refund_issued',
  );

  const ledgerRefundSum = refundLedgerEntries.reduce(
    (sum, entry) => sum + (Number.isFinite(entry.amount) ? entry.amount : 0),
    0,
  );

  const referencedIds = new Set(
    refundLedgerEntries.map((e) => e.referenceId).filter(Boolean),
  );
  if (transactionId) {
    const hasTxRef = refundLedgerEntries.some((e) => e.referenceId === transactionId);
    if (hasTxRef) {
      referencedIds.add(transactionId);
    }
  }

  let extraPendingSum = 0;
  for (const pr of pendingRefunds || []) {
    if (pr && pr.status === 'refunded') {
      const isReferenced =
        referencedIds.has(pr.id) ||
        (transactionId ? referencedIds.has(transactionId) : false);
      if (!isReferenced) {
        extraPendingSum += Number.isFinite(pr.chargedAmount) ? pr.chargedAmount : 0;
      }
    }
  }

  return Math.round((ledgerRefundSum + extraPendingSum) * 100) / 100;
}

/**
 * Calculates the maximum refundable cash amount for a transaction.
 *
 * Formula: maxRefundable = Math.max(0, chargedAmount - priorRefunds)
 *
 * @param chargedAmount Total amount billed for transaction
 * @param ledgerEntries Ledger entries associated with transaction
 * @param pendingRefunds Linked pending refund entries
 * @param transactionId ID of the transaction
 * @returns Maximum allowable refund in PHP (rounded to centavos)
 */
export function calculateMaxRefundable(
  chargedAmount: number | null | undefined,
  ledgerEntries: LedgerRefundEntry[] = [],
  pendingRefunds: PendingRefundSummary[] = [],
  transactionId?: string,
): number {
  if (
    typeof chargedAmount !== 'number' ||
    !Number.isFinite(chargedAmount) ||
    chargedAmount <= 0
  ) {
    return 0;
  }
  const prior = calculatePriorRefunds(ledgerEntries, pendingRefunds, transactionId);
  return Math.max(0, Math.round((chargedAmount - prior) * 100) / 100);
}

