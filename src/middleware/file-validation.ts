import path from 'node:path';
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_LABEL,
  MAGIC_SIGNATURES,
} from '@/utils/file-types';
import { adminService } from '@/services';
import { scanBuffer, isClamdReachable } from '@/services/clamd';
import { quarantineBuffer } from '@/services/quarantine';

function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
): void {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype.toLowerCase();
  const pairAllowed =
    (ext === '.pdf' && mime === 'application/pdf') ||
    (ext === '.docx' &&
      mime ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
    ((ext === '.jpg' || ext === '.jpeg') && mime === 'image/jpeg') ||
    (ext === '.png' && mime === 'image/png');
  if (
    !ALLOWED_EXTENSIONS.has(ext) ||
    !ALLOWED_MIME_TYPES.has(mime) ||
    !pairAllowed
  ) {
    cb(
      Object.assign(new Error('Invalid file type'), {
        code: 'UNSUPPORTED_TYPE',
      }),
    );
    return;
  }

  cb(null, true);
}

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter,
});

export function handleMulterError(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        code: 'FILE_TOO_LARGE',
        error: `File size exceeds the limit of ${MAX_FILE_SIZE_LABEL}.`,
      });
      return;
    }
    res.status(400).json({
      code: 'UPLOAD_ERROR',
      error: error.message,
    });
    return;
  }
  if (
    error instanceof Error &&
    (error as Error & { code?: string }).code === 'UNSUPPORTED_TYPE'
  ) {
    res.status(415).json({
      code: 'UNSUPPORTED_FILE_TYPE',
      error: error.message,
    });
    return;
  }
  next(error);
}

function matchesMagicBytes(buffer: Buffer, mime: string): boolean {
  const signatures = MAGIC_SIGNATURES[mime];
  if (!signatures) return false;

  return signatures.some(({ bytes, offset = 0 }) => {
    if (buffer.length < offset + bytes.length) return false;
    return bytes.every((byte, index) => buffer[offset + index] === byte);
  });
}

function findEndOfCentralDirectoryOffset(buffer: Buffer): number {
  const eocdSignature = 0x06054b50;
  const minEocdLength = 22;
  const maxCommentLength = 0xffff;

  if (buffer.length < minEocdLength) return -1;

  const searchStart = Math.max(
    0,
    buffer.length - minEocdLength - maxCommentLength,
  );

  for (
    let offset = buffer.length - minEocdLength;
    offset >= searchStart;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      return offset;
    }
  }

  return -1;
}

function validateDocxMagic(buffer: Buffer): boolean {
  const centralDirectoryHeaderSignature = 0x02014b50;
  const eocdOffset = findEndOfCentralDirectoryOffset(buffer);

  if (eocdOffset === -1) return false;

  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;

  if (
    centralDirectoryOffset < 0 ||
    centralDirectorySize <= 0 ||
    centralDirectoryEnd > buffer.length
  ) {
    return false;
  }

  let cursor = centralDirectoryOffset;
  let hasContentTypes = false;
  let hasWordEntry = false;

  while (cursor + 46 <= centralDirectoryEnd) {
    if (buffer.readUInt32LE(cursor) !== centralDirectoryHeaderSignature) {
      return false;
    }

    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraFieldLength = buffer.readUInt16LE(cursor + 30);
    const fileCommentLength = buffer.readUInt16LE(cursor + 32);
    const fileNameStart = cursor + 46;
    const fileNameEnd = fileNameStart + fileNameLength;

    if (fileNameEnd > centralDirectoryEnd) return false;

    const entryName = buffer.toString('utf8', fileNameStart, fileNameEnd);

    if (entryName === '[Content_Types].xml') {
      hasContentTypes = true;
    }

    if (entryName.startsWith('word/') && entryName.length > 'word/'.length) {
      hasWordEntry = true;
    }

    if (hasContentTypes && hasWordEntry) {
      return true;
    }

    cursor = fileNameEnd + extraFieldLength + fileCommentLength;
  }

  return false;
}

export async function validateMagicBytes(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const file = req.file;

  if (!file) {
    next();
    return;
  }

  const mime = file.mimetype.toLowerCase();

  const hasValidMagicBytes = matchesMagicBytes(file.buffer, mime);
  const isDocxMime =
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const isValidDocx = !isDocxMime || (hasValidMagicBytes && validateDocxMagic(file.buffer));

  if (!hasValidMagicBytes || isValidDocx) {
    void quarantineBuffer(
      file.buffer,
      file.originalname,
      file.size,
      'MAGIC_BYTE_MISMATCH',
    ).catch(() => {});

    res.status(415).json({
      code: 'UNSUPPORTED_TYPE',
      error: 'File content does not match its declared type.',
    });
    return;
  }

  next();
}

export async function scanForMalware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const file = req.file;

  if (!file) {
    next();
    return;
  }

  const daemonUp = await isClamdReachable();
  if (!daemonUp) {
    // Fail closed — if ClamAV is unreachable, block the upload entirely
    void adminService
      .appendAdminLog(
        'scan_unavailable',
        'ClamAV daemon unreachable — upload blocked.',
        {
          originalName: file.originalname,
          sizeBytes: file.size,
        },
      )
      .catch(() => {});

    res.status(503).json({
      code: 'SCAN_UNAVAILABLE',
      error:
        'File scanning is currently unavailable. Please try again shortly.',
    });
    return;
  }

  try {
    const result = await scanBuffer(file.buffer);

    if (!result.isClean) {
      void quarantineBuffer(
        file.buffer,
        file.originalname,
        file.size,
        'FILE_INFECTED',
        result.virusName ?? undefined,
      ).catch(() => {});

      res.status(422).json({
        code: 'FILE_INFECTED',
        error:
          'This file was flagged by our security scanner and cannot be accepted.',
      });
      return;
    }

    next();
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown scan error';
    void quarantineBuffer(
      file.buffer,
      file.originalname,
      file.size,
      'SCAN_ERROR',
    ).catch(() => {});

    console.error(`[SCAN] Unexpected error: ${reason}`);
    res.status(500).json({
      code: 'SCAN_ERROR',
      error: 'An error occurred while scanning the file. Please try again.',
    });
  }
}
