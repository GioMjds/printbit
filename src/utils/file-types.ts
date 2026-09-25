export const ALLOWED_MIME_TYPES = new Set([
  // PDF
  'application/pdf',
  // Word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/octet-stream',
]);

export const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
]);

export const REPORT_ATTACHMENT_ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/octet-stream',
]);

export const REPORT_ATTACHMENT_ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_FILE_SIZE_LABEL = '25 MB';

export interface MagicSignature {
  bytes: number[];
  offset?: number;
}

// OLE Compound File header (used by legacy Office formats: DOC)
const OLE_MAGIC: MagicSignature = {
  bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
};

// OOXML (ZIP-based) header (used by DOCX)
const OOXML_MAGIC: MagicSignature = { bytes: [0x50, 0x4b, 0x03, 0x04] };

export const MAGIC_SIGNATURES: Record<string, MagicSignature[]> = {
  // PDF
  'application/pdf': [{ bytes: [0x25, 0x50, 0x44, 0x46] }],
  // Word
  'application/msword': [OLE_MAGIC],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    OOXML_MAGIC,
  ],
  // Images
  'image/jpeg': [{ bytes: [0xff, 0xd8, 0xff] }],
  'image/png': [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  'image/gif': [
    { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
    { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  ],
};

export const REPORT_ATTACHMENT_MAGIC_SIGNATURES: Record<
  string,
  MagicSignature[]
> = {
  'image/jpeg': [{ bytes: [0xff, 0xd8, 0xff] }],
  'image/png': [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  // WebP files begin with RIFF....WEBP (RIFF at offset 0 + WEBP at offset 8).
  // The second marker is enforced through a custom validator in middleware.
  'image/webp': [{ bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }],
};

// Extension-to-MIME mapping for consistent lookups
export const EXTENSION_MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

export const REPORT_ATTACHMENT_EXTENSION_MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

// OOXML internal directory markers for structural validation
export const OOXML_DIRECTORY_MARKERS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'word/',
};
