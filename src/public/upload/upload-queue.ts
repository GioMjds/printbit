// Pure helpers for the phone upload page. Kept free of DOM access so they can
// be unit tested under jest's node environment.

export type ItemStatus = 'pending' | 'uploading' | 'done' | 'error';

/** Mirrors MAX_FILE_SIZE_BYTES in src/utils/file-types.ts (server limit). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Whole-request ceiling for one upload XHR. Must exceed the server's Defender
 * scan timeout (60 s default) plus transfer time over the kiosk access point.
 */
export const UPLOAD_REQUEST_TIMEOUT_MS = 180_000;

export interface FileLike {
  name: string;
  type: string;
  size: number;
}

export type ClassifyOptions = { documentConversionEnabled: boolean };

export type ClassifyResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'word-disabled' | 'too-large' };

export function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? 'file';
}

export function isWordDocument(fileName: string, mimeType?: string): boolean {
  const ext = extOf(fileName);
  if (ext === 'doc' || ext === 'docx') return true;
  const normalized = mimeType?.trim().toLowerCase();
  return (
    normalized === 'application/msword' ||
    normalized ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

export function normalizeMimeByExtension(
  fileName: string,
  mimeType: string,
): string | null {
  const normalizedMime = mimeType.trim().toLowerCase();
  const ext = extOf(fileName);
  const extensionMimeMap = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  } as Record<string, string>;

  const vendorAliases = {
    'application/x-pdf': 'application/pdf',
    'application/acrobat': 'application/pdf',
    'applications/vnd.pdf': 'application/pdf',
    'application/vnd.ms-word': 'application/msword',
    'application/x-msword': 'application/msword',
    'image/pjpeg': 'image/jpeg',
    'image/x-png': 'image/png',
  } as Record<string, string>;

  if (vendorAliases[normalizedMime]) {
    return vendorAliases[normalizedMime];
  }

  const mappedByExt = extensionMimeMap[ext];
  if (
    normalizedMime === '' ||
    normalizedMime === 'application/octet-stream' ||
    (mappedByExt && !normalizedMime.includes('/'))
  ) {
    return mappedByExt || null;
  }

  return mappedByExt ?? normalizedMime;
}

/**
 * Single source of truth for "may this file enter the queue". Both the error
 * message and the queue loop must use this, so they cannot disagree.
 */
export function classifyUploadFile(
  file: FileLike,
  { documentConversionEnabled }: ClassifyOptions,
): ClassifyResult {
  const isWord = isWordDocument(file.name, file.type);
  if (!documentConversionEnabled && isWord) {
    return { ok: false, reason: 'word-disabled' };
  }

  const allowed = new Set<string>([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
  ]);
  if (documentConversionEnabled) {
    allowed.add('application/msword');
    allowed.add(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  }

  const normalized = normalizeMimeByExtension(file.name, file.type);
  if (!normalized || !allowed.has(normalized)) {
    return { ok: false, reason: 'unsupported' };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: 'too-large' };
  }

  return { ok: true };
}

/**
 * A failed item must not block re-adding the same file, so only items that
 * still hold (or already delivered) the content count as duplicates.
 */
export function findDuplicate(
  queue: ReadonlyArray<{ contentHash?: string; status: ItemStatus }>,
  contentHash: string | undefined,
): boolean {
  if (!contentHash) return false;
  return queue.some(
    (q) => q.contentHash === contentHash && q.status !== 'error',
  );
}

export interface UploadFailure {
  /** 0 or undefined means the request never got an HTTP response. */
  httpStatus?: number;
  code?: string;
  timedOut?: boolean;
}

const RETRYABLE_CODES = new Set(['SCAN_UNAVAILABLE', 'SCAN_FAILED']);

/** True when sending the same file again could succeed without user changes. */
export function isRetryableFailure(failure: UploadFailure): boolean {
  if (failure.timedOut) return true;
  if (failure.code && RETRYABLE_CODES.has(failure.code)) return true;
  if (failure.code) return false;
  const status = failure.httpStatus ?? 0;
  return status === 0 || status === 429 || status >= 500;
}
