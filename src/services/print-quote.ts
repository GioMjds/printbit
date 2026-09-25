import { randomUUID, createHash } from 'node:crypto';
import { adminService } from './admin';
import { db, type ColorMode, type PrintQuality, defaultPricingEngine } from './db';
import type { CoverageTier } from '@/core/database/models/admin.model';
import { resolveCoverageTier } from './document-analysis';
import type { DocumentAnalysis } from './session';

type PageRangeSelectionPayload =
  | { type: 'all' }
  | { type: 'custom'; range?: unknown }
  | { type: 'single'; page?: unknown };

interface ParsedPageRange {
  normalized: string | null;
  error?: string;
}

export interface PrintPageQuoteBreakdown {
  pageNumber: number;
  isColor: boolean;
  coverage: number;
  coverageTier: CoverageTier;
  printCost: number;
}

export interface PrintQuoteResult {
  requiredAmount: number;
  copies: number;
  duplex: boolean;
  paperSize: 'A4' | 'Short' | 'Long';
  selectedPages: number;
  totalPages: number;
  physicalSheets: number;
  paperCostPerSheet: number;
  paperSubtotal: number;
  printSubtotal: number;
  qualitySubtotal: number;
  duplexSavings: number;
  requestedColorMode: ColorMode;
  effectiveColorMode: ColorMode;
  quality: PrintQuality;
  pageBreakdown: PrintPageQuoteBreakdown[];
  // Quote integrity
  quoteId: string;
  quoteHash: string;
  expiresAt: string;
  // Keep legacy metadata fields if consumers use them:
  selectedColorPages: number;
  selectedBwPages: number;
  billableColorPages: number;
  billableBwPages: number;
  billableImagePages: number;
  billableImageBwPages: number;
  pageRange: string | null;
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
  paperSize?: 'A4' | 'Short' | 'Long';
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

  const paperSize: 'A4' | 'Short' | 'Long' = input.paperSize ?? 'A4';
  const profileKey =
    paperSize === 'Long'
      ? 'longBond'
      : paperSize === 'Short'
        ? 'shortBond'
        : 'a4';
  const engineCfg = db.data?.settings?.pricingEngine;
  const profile =
    engineCfg?.paperProfiles?.[profileKey] ??
    defaultPricingEngine.paperProfiles[profileKey];

  const duplex = Boolean(input.duplex);
  const physicalSheetsPerCopy = duplex
    ? Math.ceil(selectedCount / 2)
    : selectedCount;
  const totalPhysicalSheets = physicalSheetsPerCopy * safeCopies;
  const paperCostPerSheet = profile.paperCost;
  const paperSubtotal = totalPhysicalSheets * paperCostPerSheet;
  const duplexSavings =
    (selectedCount * safeCopies - totalPhysicalSheets) * paperCostPerSheet;

  // If the user requested 'colored' mode, but none of the selected pages actually contain color,
  // downgrade the effectiveColorMode to 'grayscale' so downstream UI and printer driver use grayscale (no color ink).
  const effectiveColorMode: ColorMode =
    input.colorMode === 'colored' && selectedColorPages === 0
      ? 'grayscale'
      : input.colorMode;

  const pageBreakdown: PrintPageQuoteBreakdown[] = [];
  let singleCopyPrintCost = 0;
  let billableColorPages = 0;
  let billableBwPages = 0;
  let billableImagePages = 0;
  let billableImageBwPages = 0;

  for (const pageNum of selectedPages.selected) {
    const page = pageDetailsMap.get(pageNum);
    const isPageColor = page ? Boolean(page.isColor) : pageNum <= selectedColorPages;
    const rawCoverage = page?.coverage ?? (page as any)?.contentCoverage ?? 0;
    const coverage =
      typeof rawCoverage === 'number' && Number.isFinite(rawCoverage)
        ? rawCoverage
        : 0;
    const coverageTier: CoverageTier =
      page?.coverageTier ?? resolveCoverageTier(coverage);
    const isColorPrint = effectiveColorMode === 'colored' && isPageColor;
    const pageRate = isColorPrint
      ? profile.colorPrint[coverageTier]
      : profile.bwPrint[coverageTier];

    singleCopyPrintCost += pageRate;
    pageBreakdown.push({
      pageNumber: pageNum,
      isColor: isPageColor,
      coverage,
      coverageTier,
      printCost: pageRate,
    });

    const isImage = Boolean(
      page?.classification === 'image' ||
        page?.isImagePage ||
        (usedFallbackAssumptions && input.analysis.fileType === 'image'),
    );
    if (isColorPrint) {
      if (isImage) {
        billableImagePages += 1;
      } else {
        billableColorPages += 1;
      }
    } else {
      if (isImage) {
        billableImageBwPages += 1;
      } else {
        billableBwPages += 1;
      }
    }
  }

  const printSubtotal = singleCopyPrintCost * safeCopies;
  const quality: PrintQuality = input.quality ?? 'standard';
  const surchargePerSide =
    quality === 'high' ? (engineCfg?.highQualitySurcharge ?? 2) : 0;
  const qualitySubtotal = surchargePerSide * selectedCount * safeCopies;

  const requiredAmount = paperSubtotal + printSubtotal + qualitySubtotal;

  const quoteId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const quoteHash = createHash('sha256')
    .update(
      JSON.stringify({
        fileHash: (input.analysis as any).fileHash ?? input.analysis.fileType,
        paperSize,
        colorMode: input.colorMode,
        copies: safeCopies,
        duplex,
        pageRange: parsedRange.normalized,
        quality,
        requiredAmount,
        pricingVersion: 9,
      }),
    )
    .digest('hex');

  const pricing = adminService.getPricingSettings();
  return {
    ok: true,
    quote: {
      requiredAmount,
      copies: safeCopies,
      duplex,
      paperSize,
      selectedPages: selectedCount,
      totalPages,
      physicalSheets: totalPhysicalSheets,
      paperCostPerSheet,
      paperSubtotal,
      printSubtotal,
      qualitySubtotal,
      duplexSavings,
      requestedColorMode: input.colorMode,
      effectiveColorMode,
      quality,
      pageBreakdown,
      quoteId,
      quoteHash,
      expiresAt,
      selectedColorPages,
      selectedBwPages,
      billableColorPages,
      billableBwPages,
      billableImagePages,
      billableImageBwPages,
      pageRange: parsedRange.normalized,
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
