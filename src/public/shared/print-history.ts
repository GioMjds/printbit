import {
  formatPageRangeString,
  normalizePageSelection,
  parsePageRangeString,
  type PageRange,
} from './page-selection';

/**
 * Pages already printed per uploaded document during this kiosk session.
 * Lives in sessionStorage next to the wireless session id; Done / idle
 * timeout clear it together with the session (and its files).
 */
const STORAGE_KEY = 'printbit.printHistory';

export interface PrintHistoryEntry {
  filename: string;
  totalPages: number;
  printedRanges: PageRange[];
}

export type PrintHistory = Record<string, PrintHistoryEntry>;

export type PageRangeSelectionLike =
  | { type: 'all' }
  | { type: 'custom'; range: string; ranges?: PageRange[] }
  | { type: 'single'; page: number };

function mergeRanges(ranges: PageRange[], totalPages: number): PageRange[] {
  // normalizePageSelection treats an empty custom list as "all pages".
  if (ranges.length === 0) return [];
  return normalizePageSelection({ mode: 'custom', ranges }, totalPages).ranges;
}

export function selectionToRanges(
  selection: PageRangeSelectionLike | undefined,
  totalPages: number,
): PageRange[] {
  const max = Math.max(1, totalPages);
  if (!selection || selection.type === 'all') return [{ start: 1, end: max }];
  if (selection.type === 'single') {
    const page = Math.max(1, Math.min(max, Math.trunc(selection.page) || 1));
    return [{ start: page, end: page }];
  }
  const ranges = selection.ranges?.length
    ? selection.ranges
    : parsePageRangeString(selection.range ?? '', max);
  return mergeRanges(ranges, max);
}

export function unprintedRanges(
  totalPages: number,
  printed: PageRange[],
): PageRange[] {
  const out: PageRange[] = [];
  let next = 1;
  for (const range of mergeRanges(printed, totalPages)) {
    if (range.start > next) out.push({ start: next, end: range.start - 1 });
    next = Math.max(next, range.end + 1);
  }
  if (next <= totalPages) out.push({ start: next, end: totalPages });
  return out;
}

/** First `limit` pages of `ranges`, keeping range order. */
export function takePages(ranges: PageRange[], limit: number): PageRange[] {
  const out: PageRange[] = [];
  let left = Math.max(0, Math.floor(limit));
  for (const range of ranges) {
    if (left <= 0) break;
    const end = Math.min(range.end, range.start + left - 1);
    out.push({ start: range.start, end });
    left -= end - range.start + 1;
  }
  return out;
}

export function countPages(ranges: PageRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
}

/** "31–50" style label for kiosk copy; commas between ranges. */
export function formatPagesLabel(ranges: PageRange[]): string {
  return formatPageRangeString(ranges).replace(/-/g, '–');
}

export function readPrintHistory(): PrintHistory {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as PrintHistory) : {};
  } catch {
    return {};
  }
}

export function recordPrintedPages(
  documentId: string,
  filename: string,
  totalPages: number,
  printed: PageRange[],
): PrintHistoryEntry {
  const history = readPrintHistory();
  const previous = history[documentId];
  const entry: PrintHistoryEntry = {
    filename,
    totalPages,
    printedRanges: mergeRanges(
      [...(previous?.printedRanges ?? []), ...printed],
      totalPages,
    ),
  };
  history[documentId] = entry;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Storage full or blocked: the thank-you screen still uses `entry`.
  }
  return entry;
}

export function forgetPrintedDocument(documentId: string): void {
  const history = readPrintHistory();
  if (!(documentId in history)) return;
  delete history[documentId];
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // best-effort
  }
}

export function clearPrintHistory(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
