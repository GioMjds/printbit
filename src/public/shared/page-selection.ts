export interface PageRange {
  start: number;
  end: number;
}

export type PageSelectionMode = 'all' | 'custom' | 'single';

export interface PageSelection {
  mode: PageSelectionMode;
  ranges: PageRange[];
}

export interface NormalizedPageSelectionResult {
  mode: PageSelectionMode;
  ranges: PageRange[];
  totalSelectedPages: number;
  canonicalString: string;
  hasOverlapsMerged: boolean;
  warnings?: string[];
}

export function formatPageRangeString(ranges: PageRange[]): string {
  if (ranges.length === 0) return '';
  return ranges
    .map((r) => (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`))
    .join(', ');
}

export function parsePageRangeString(
  raw: string,
  totalPages: number,
): PageRange[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const max = Math.max(1, totalPages);
  const chunks = trimmed.split(',');
  const parsed: PageRange[] = [];

  for (const chunk of chunks) {
    const part = chunk.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [sStr, eStr] = part.split('-');
      const s = parseInt(sStr.trim(), 10);
      const e = parseInt(eStr.trim(), 10);
      if (Number.isFinite(s) && Number.isFinite(e)) {
        const start = Math.max(1, Math.min(max, Math.min(s, e)));
        const end = Math.max(1, Math.min(max, Math.max(s, e)));
        parsed.push({ start, end });
      }
    } else {
      const p = parseInt(part, 10);
      if (Number.isFinite(p)) {
        const clamped = Math.max(1, Math.min(max, p));
        parsed.push({ start: clamped, end: clamped });
      }
    }
  }

  return parsed;
}

export function normalizePageSelection(
  raw: unknown,
  totalPages: number,
): NormalizedPageSelectionResult {
  const maxPages = Math.max(1, totalPages);

  if (!raw || typeof raw !== 'object') {
    return {
      mode: 'all',
      ranges: [{ start: 1, end: maxPages }],
      totalSelectedPages: maxPages,
      canonicalString: `1-${maxPages}`,
      hasOverlapsMerged: false,
    };
  }

  const selection = raw as Partial<PageSelection>;
  const mode: PageSelectionMode =
    selection.mode === 'custom' || selection.mode === 'single'
      ? selection.mode
      : 'all';

  if (mode === 'all') {
    return {
      mode: 'all',
      ranges: [{ start: 1, end: maxPages }],
      totalSelectedPages: maxPages,
      canonicalString: `1-${maxPages}`,
      hasOverlapsMerged: false,
    };
  }

  let inputRanges: PageRange[] = [];
  if (Array.isArray(selection.ranges)) {
    inputRanges = selection.ranges
      .filter(
        (r): r is PageRange =>
          r && typeof r.start === 'number' && typeof r.end === 'number',
      )
      .map((r) => ({
        start: Math.max(1, Math.min(maxPages, Math.min(r.start, r.end))),
        end: Math.max(1, Math.min(maxPages, Math.max(r.start, r.end))),
      }));
  }

  if (inputRanges.length === 0) {
    return {
      mode,
      ranges: [{ start: 1, end: maxPages }],
      totalSelectedPages: maxPages,
      canonicalString: `1-${maxPages}`,
      hasOverlapsMerged: false,
    };
  }

  inputRanges.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: PageRange[] = [];
  let overlapsMerged = false;

  for (const range of inputRanges) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ ...range });
      continue;
    }

    if (range.start <= prev.end + 1) {
      overlapsMerged = true;
      prev.end = Math.max(prev.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  let totalSelected = 0;
  for (const r of merged) {
    totalSelected += r.end - r.start + 1;
  }

  return {
    mode,
    ranges: merged,
    totalSelectedPages: totalSelected,
    canonicalString: formatPageRangeString(merged),
    hasOverlapsMerged: overlapsMerged,
  };
}
