import { ScannerError } from '@/services/scanner';

export type ScanPreviewFailureCode =
  | 'NO_DOCUMENT'
  | 'SCANNER_TIMEOUT'
  | 'SCANNER_OFFLINE'
  | 'SCANNER_BUSY'
  | 'PAPER_JAM'
  | 'ADF_ERROR'
  | 'SCAN_FAILED';

export interface ScanPreviewFailure {
  code: ScanPreviewFailureCode;
  /** Customer-facing sentence. Never contains device or driver names. */
  error: string;
}

const MESSAGES = {
  SCANNER_TIMEOUT: 'The scanner did not respond in time. Please try again.',
  SCANNER_OFFLINE:
    'The scanner is offline or not connected. Please ask staff for assistance.',
  SCANNER_BUSY: 'The scanner is busy. Wait a few seconds, then try again.',
  PAPER_JAM:
    'Paper jam detected. Clear the jammed paper from the scanner, then try again.',
  SCAN_FAILED: 'The scanner could not complete the check. Please try again.',
} satisfies Record<
  Exclude<ScanPreviewFailureCode, 'NO_DOCUMENT' | 'ADF_ERROR'>,
  string
>;

const NO_DOCUMENT_GLASS =
  'No document detected. Place your document face-down on the scanner glass and try again.';
const NO_DOCUMENT_FEEDER =
  'No document detected in the document feeder. Insert your document face-up, then try again.';

function classify(
  workerCode: string | undefined,
  message: string,
): ScanPreviewFailureCode {
  // The worker's own code is the most specific evidence, so it wins.
  switch (workerCode) {
    case 'FEEDER_EMPTY':
    case 'OUTPUT_FILE_MISSING':
      return 'NO_DOCUMENT';
    case 'PAPER_JAM':
      return 'PAPER_JAM';
    case 'SCANNER_BUSY':
    case 'DEVICE_BUSY':
      return 'SCANNER_BUSY';
    case 'SCANNER_UNAVAILABLE':
      return 'SCANNER_OFFLINE';
    case 'SCAN_TIMEOUT':
    case 'SCAN_PAGE_TIMEOUT':
    case 'WORKER_NO_RESPONSE':
      return 'SCANNER_TIMEOUT';
    default:
      break;
  }

  // PROCESS_FAILED and unknown codes carry the driver's text. Read it.
  const text = message.toLowerCase();
  if (text.includes('printer adf error')) return 'ADF_ERROR';
  if (text.includes('jam')) return 'PAPER_JAM';
  if (
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('no response received')
  ) {
    return 'SCANNER_TIMEOUT';
  }
  if (
    text.includes('offline') ||
    text.includes('unavailable') ||
    text.includes('not connected') ||
    text.includes('no scanner') ||
    text.includes('disconnected')
  ) {
    return 'SCANNER_OFFLINE';
  }
  if (text.includes('busy') || text.includes('already in progress')) {
    return 'SCANNER_BUSY';
  }
  return 'SCAN_FAILED';
}

/**
 * Turns a failed copy pre-scan into a code and a truthful customer message.
 * Only an empty glass or feeder is reported as "No document detected".
 */
export function describeScanPreviewFailure(
  err: unknown,
  source: 'adf' | 'flatbed',
): ScanPreviewFailure {
  const message = err instanceof Error ? err.message : '';
  const workerCode = err instanceof ScannerError ? err.code : undefined;
  const code = classify(workerCode, message);

  if (code === 'NO_DOCUMENT') {
    return {
      code,
      error: source === 'adf' ? NO_DOCUMENT_FEEDER : NO_DOCUMENT_GLASS,
    };
  }
  if (code === 'ADF_ERROR') {
    return { code, error: message };
  }
  return { code, error: MESSAGES[code] };
}
