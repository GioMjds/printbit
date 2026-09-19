export const PRINT_PAGE_WARNING_THRESHOLD = 30;

export function formatPrintSessionLimitNote(
  limit: number = PRINT_PAGE_WARNING_THRESHOLD,
): string {
  return `Print limit: A maximum of ${limit} pages can be printed in this session. Your selected page range multiplied by copies must stay within ${limit} pages.`;
}

export function isLargePrintDocument(
  pageCount: unknown,
  threshold: number = PRINT_PAGE_WARNING_THRESHOLD,
): pageCount is number {
  return (
    typeof pageCount === 'number' &&
    Number.isFinite(pageCount) &&
    pageCount >= threshold
  );
}

export function formatLargePrintDisclaimer(
  pageCount: number,
  limit: number = PRINT_PAGE_WARNING_THRESHOLD,
): string {
  return `Print-only notice: This kiosk allows a maximum of ${limit} printed pages per session. Your document contains ${pageCount} pages. If you print more than ${limit} pages or use copies that exceed ${limit} total pages, choose a smaller page range or fewer copies. Review the page range, copies, and total price before continuing. This limit applies only to Print and this session.`;
}

