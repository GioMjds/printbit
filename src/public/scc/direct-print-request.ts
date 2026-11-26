export type DirectPrintOptions = {
  copies: number;
  colorMode: 'colored' | 'grayscale';
  paperSize: 'A4' | 'Short' | 'Long';
  duplex: boolean;
  quality: 'standard' | 'high';
  orientation: 'portrait' | 'landscape';
  pageRange: string;
};

export const QUOTE_MAX_ATTEMPTS = 20;

const RETRYABLE_QUOTE_CODES = new Set([
  'ANALYSIS_PENDING',
  'ANALYSIS_UNAVAILABLE',
]);

export function buildDirectPrintSettings(opts: DirectPrintOptions) {
  const pageRange = opts.pageRange.trim();
  return {
    copies: opts.copies,
    colorMode: opts.colorMode,
    paperSize: opts.paperSize,
    duplex: opts.duplex,
    quality: opts.quality,
    orientation: opts.orientation,
    rotationDeg: 0,
    pageRange: pageRange || null,
  };
}

export function buildQuoteBody(
  sessionId: string,
  documentId: string,
  opts: DirectPrintOptions,
) {
  return { sessionId, documentId, ...buildDirectPrintSettings(opts) };
}

export function buildConfirmBody(
  sessionId: string,
  documentId: string,
  opts: DirectPrintOptions,
  spoolerCorrelationKey: string,
) {
  return {
    mode: 'print' as const,
    sessionId,
    documentId,
    ...buildDirectPrintSettings(opts),
    spoolerCorrelationKey,
  };
}

export function shouldRetryQuote(
  status: number,
  code: string | null,
  attempt: number,
): boolean {
  return (
    status === 409 &&
    code !== null &&
    RETRYABLE_QUOTE_CODES.has(code) &&
    attempt < QUOTE_MAX_ATTEMPTS - 1
  );
}
