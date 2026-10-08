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
