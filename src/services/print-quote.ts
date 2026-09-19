import { adminService } from './admin';
import { db, type ColorMode, type PrintQuality } from './db';
import type { DocumentAnalysis } from './session';

type PageRangeSelectionPayload =
  | { type: 'all' }
  | { type: 'custom'; range?: unknown }
  | { type: 'single'; page?: unknown };

interface ParsedPageRange {
  normalized: string | null;
  error?: string;
}

export interface PrintQuoteResult {
  requiredAmount: number;
  copies: number;
  duplex: boolean;
  pageRange: string | null;
  totalPages: number;
  selectedPages: number;
  selectedColorPages: number;
  selectedBwPages: number;
  billableColorPages: number;
  billableBwPages: number;
  billableImagePages: number;
  requestedColorMode: ColorMode;
  effectiveColorMode: ColorMode;
  quality: PrintQuality;
  pricing: {
    printPerPage: number;
    colorSurcharge: number;
    highQualitySurcharge: number;
  };
  analysisConfidence: 'high' | 'medium' | 'low';
  billingPageDetection:
    | 'high-confidence-page-detection'
    | 'fallback-assumptions';
  analysisFallbackReasonFlags: string[];
  colorDetectionEnabled: boolean;
}

export type PrintQuoteComputation =
  | { ok: true; quote: PrintQuoteResult }
  | { ok: false; error: string; code?: string };

function normalizeRangeString(raw: string): string | null {
  const compact = raw.replace(/\s+/g, '');
  if (!compact) return null;
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(compact)) return null;

  const chunks = compact.split(',');
  for (const chunk of chunks) {
    if (chunk.includes('-')) {
      const [startRaw, endRaw] = chunk.split('-');
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
      if (start < 1 || end < 1 || start > end) return null;
      continue;
    }

    const page = Number(chunk);
    if (!Number.isInteger(page) || page < 1) return null;
  }

  return compact;
}

function parsePageRange(raw: unknown): ParsedPageRange {
  if (raw == null) return { normalized: null };

  if (typeof raw === 'string') {
    const normalized = normalizeRangeString(raw);
    if (!normalized) {
      return { normalized: null, error: 'Invalid page range format' };
    }
    return { normalized };
  }

  if (typeof raw !== 'object') {
    return { normalized: null, error: 'Invalid page range payload' };
  }

  const payload = raw as PageRangeSelectionPayload;
  if (payload.type === 'all') {
    return { normalized: null };
  }

  if (payload.type === 'single') {
    const pageRaw = payload.page;
    const page =
      typeof pageRaw === 'number' && Number.isFinite(pageRaw)
        ? Math.floor(pageRaw)
        : Number(pageRaw);
    if (!Number.isInteger(page) || page < 1) {
      return { normalized: null, error: 'Invalid single page selection' };
    }
    return { normalized: String(page) };
  }

  if (payload.type === 'custom') {
    const normalized = normalizeRangeString(String(payload.range ?? ''));
    if (!normalized) {
      return { normalized: null, error: 'Invalid custom page range' };
    }
    return { normalized };
  }

  return { normalized: null, error: 'Invalid page range payload' };
}

function getTotalPages(analysis: DocumentAnalysis): number {
  const fromTotalPages = Math.floor(analysis.totalPages ?? 0);
  if (fromTotalPages > 0) return fromTotalPages;

  const fromPageCount = Math.floor(analysis.pageCount ?? 0);
  if (fromPageCount > 0) return fromPageCount;

  const fromPages = Array.isArray(analysis.pages) ? analysis.pages.length : 0;
  if (fromPages > 0) return fromPages;

  return 0;
}

function parseSelectedPages(
  normalizedRange: string | null,
  totalPages: number,
): { selected: Set<number>; error?: string } {
  if (totalPages < 1) {
    return { selected: new Set<number>(), error: 'Document has no pages.' };
  }

  if (!normalizedRange) {
    const selected = new Set<number>();
    for (let page = 1; page <= totalPages; page += 1) {
      selected.add(page);
    }
    return { selected };
  }

  const selected = new Set<number>();
  const chunks = normalizedRange.split(',');
  for (const chunk of chunks) {
    if (chunk.includes('-')) {
      const [startRaw, endRaw] = chunk.split('-');
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (start > totalPages || end > totalPages) {
        return {
          selected: new Set<number>(),
          error: `Page range exceeds document length (${totalPages} pages).`,
        };
      }
      for (let page = start; page <= end; page += 1) {
        selected.add(page);
      }
      continue;
    }

    const page = Number(chunk);
    if (page > totalPages) {
      return {
        selected: new Set<number>(),
        error: `Page selection exceeds document length (${totalPages} pages).`,
      };
    }
    selected.add(page);
  }

  if (selected.size === 0) {
    return {
      selected: new Set<number>(),
      error: 'Page selection resolved to zero pages.',
    };
  }

  return { selected };
}

export function buildPrintQuote(input: {
  analysis: DocumentAnalysis;
  colorMode: ColorMode;
  copies: number;
  paperSize?: 'A4' | 'Letter' | 'Legal';
  pageRange?: unknown;
  duplex?: boolean;
  quality?: PrintQuality;
}): PrintQuoteComputation {
  const maxPages = db.data?.settings?.printLimits?.maxPagesPerSession ?? 30;
  const safeCopies = Math.min(maxPages, Math.max(1, Math.floor(input.copies)));
  const parsedRange = parsePageRange(input.pageRange);
  if (parsedRange.error) {
    return { ok: false, error: parsedRange.error };
  }

  const totalPages = getTotalPages(input.analysis);
  if (totalPages < 1) {
    return { ok: false, error: 'Document analysis has no page count.' };
  }

  const selectedPages = parseSelectedPages(parsedRange.normalized, totalPages);
  if (selectedPages.error) {
    return { ok: false, error: selectedPages.error };
  }

  const pageAnalyses = Array.isArray(input.analysis.pages)
    ? input.analysis.pages
    : [];
  const byPage = new Map<number, boolean>();
  const pageDetailsMap = new Map<number, (typeof pageAnalyses)[number]>();
  for (const page of pageAnalyses) {
    const index = Math.floor(page.index);
    if (index >= 1) {
      byPage.set(index, Boolean(page.isColor));
      pageDetailsMap.set(index, page);
    }
  }

  let selectedColorPages = 0;
  let selectedBwPages = 0;
  let usedFallbackAssumptions = false;
  if (byPage.size > 0) {
    for (const page of selectedPages.selected) {
      if (!byPage.has(page)) {
        return {
          ok: false,
          error: 'Document analysis is incomplete for selected pages.',
        };
      }
      if (byPage.get(page)) {
        selectedColorPages += 1;
      } else {
        selectedBwPages += 1;
      }
    }
  } else if (!parsedRange.normalized) {
    usedFallbackAssumptions = true;
    selectedColorPages = Math.max(
      0,
      Math.floor(input.analysis.colorPages ?? 0),
    );
    selectedBwPages = Math.max(0, Math.floor(input.analysis.bwPages ?? 0));
  } else {
    return {
      ok: false,
      error: 'Page-level analysis unavailable for custom page selection.',
    };
  }

  const analysisFallbackReasonFlags = Array.from(
    new Set(
      pageAnalyses.flatMap((page) =>
        Array.isArray(page.fallbackReasonFlags) ? page.fallbackReasonFlags : [],
      ),
    ),
  );
  const billingPageDetection =
    !usedFallbackAssumptions && input.analysis.confidence === 'high'
      ? 'high-confidence-page-detection'
      : 'fallback-assumptions';

  const selectedCount = selectedPages.selected.size;
  if (selectedColorPages + selectedBwPages !== selectedCount) {
    return {
      ok: false,
      error: 'Document analysis mismatch for selected pages.',
    };
  }

  if (selectedCount > maxPages) {
    return {
      ok: false,
      code: 'PAGE_LIMIT_EXCEEDED',
      error: `Maximum ${maxPages} printed pages allowed per job.`,
    };
  }

  const totalBillablePages = selectedCount * safeCopies;
  if (totalBillablePages > maxPages) {
    return {
      ok: false,
      code: 'PAGE_LIMIT_EXCEEDED',
      error: `Job exceeds maximum length of ${maxPages} pages (requested ${totalBillablePages} pages).`,
    };
  }

  // The selected print mode is the customer's billing choice.
  // In Color mode: per-page grading bills photos/images at baseImagePrice,
  // colored pages at baseColorPrice, and B&W/blank at baseBwPrice.
  // In B&W mode: driver prints pure grayscale, all pages bill at baseBwPrice.
  const effectiveColorMode: ColorMode = input.colorMode;
  let billableColorPages = 0;
  let billableBwPages = 0;
  let billableImagePages = 0;

  if (effectiveColorMode === 'colored') {
    if (!usedFallbackAssumptions && input.analysis.confidence !== 'low') {
      for (const pageNum of selectedPages.selected) {
        const page = pageDetailsMap.get(pageNum);
        const isImage =
          page?.classification === 'image' ||
          Boolean(page?.isImagePage && page?.isColor);
        if (isImage) {
          billableImagePages += 1;
        } else if (page?.isColor) {
          billableColorPages += 1;
        } else {
          billableBwPages += 1;
        }
      }
    } else {
      // Fallback without reliable page detection: bill binary color/BW
      billableColorPages = selectedColorPages;
      billableBwPages = selectedBwPages;
      billableImagePages = 0;
    }
  } else {
    // B&W Mode: forces all pages to baseBwPrice (zero color ink)
    billableBwPages = selectedCount;
    billableColorPages = 0;
    billableImagePages = 0;
  }

  const quality: PrintQuality = input.quality ?? 'standard';
  const requiredAmount = adminService.calculateDocumentAmount(
    'print',
    {
      colorPages: billableColorPages,
      bwPages: billableBwPages,
      imagePages: billableImagePages,
    },
    safeCopies,
    input.paperSize ?? 'A4',
    quality,
  );

  const pricing = adminService.getPricingSettings();
  return {
    ok: true,
    quote: {
      requiredAmount,
      copies: safeCopies,
      duplex: Boolean(input.duplex),
      pageRange: parsedRange.normalized,
      totalPages,
      selectedPages: selectedCount,
      selectedColorPages,
      selectedBwPages,
      billableColorPages,
      billableBwPages,
      billableImagePages,
      requestedColorMode: input.colorMode,
      effectiveColorMode,
      quality,
      pricing: {
        printPerPage: pricing.printPerPage,
        colorSurcharge: pricing.colorSurcharge,
        highQualitySurcharge: pricing.highQualitySurcharge,
      },
      analysisConfidence: input.analysis.confidence,
      billingPageDetection,
      analysisFallbackReasonFlags,
      colorDetectionEnabled: adminService.getPipelineSettings().colorDetectionEnabled,
    },
  };
}
