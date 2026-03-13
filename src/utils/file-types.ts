export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
]);

export const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.jpg',
  '.jpeg',
  '.png',
]);

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_FILE_SIZE_LABEL = '25 MB';

export interface MagicSignature {
  bytes: number[];
  offset?: number;
}

export const MAGIC_SIGNATURES: Record<string, MagicSignature[]> = {
  'application/pdf': [
    { bytes: [0x25, 0x50, 0x44, 0x46] },
  ],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    { bytes: [0x50, 0x4b, 0x03, 0x04] },
  ],
  'image/jpeg': [{ bytes: [0xff, 0xd8, 0xff] }],
  'image/png': [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
};
