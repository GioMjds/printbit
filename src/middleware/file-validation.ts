import path from 'node:path';
import multer from 'multer';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_LABEL,
  MAGIC_SIGNATURES,
  EXTENSION_MIME_MAP,
  OOXML_DIRECTORY_MARKERS,
  REPORT_ATTACHMENT_ALLOWED_EXTENSIONS,
  REPORT_ATTACHMENT_ALLOWED_MIME_TYPES,
  REPORT_ATTACHMENT_EXTENSION_MIME_MAP,
  REPORT_ATTACHMENT_MAGIC_SIGNATURES,
} from '@/utils/file-types';
import { adminService } from '@/services/admin';
import {
  quarantineStagedUpload,
  type QuarantineReason,
} from '@/services/quarantine';
import {
  createUploadStagingStorage,
  discardStagedUpload,
  readStagedFileRange,
} from '@/services/upload-staging';
import {
  getSharedDefenderScanner,
  type DefenderScanner,
} from '@/services/defender-scanner';
import { anomalyService, buildAnomalyFingerprint } from '@/services/anomaly';

export type UploadSurface =
  | 'wireless-session-upload'
  | 'legacy-upload'
  | 'report-issue-attachment';

export interface ValidationPolicy {
  readonly allowedExtensions: Set<string>;
  readonly allowedMimeTypes: Set<string>;
  readonly extensionMimeMap: Record<string, string>;
  readonly magicSignatures: Record<
    string,
    { bytes: number[]; offset?: number }[]
  >;
  readonly surface: UploadSurface;
}

export type UploadRejectionNotifier = (input: {
  sessionId?: string | null;
  filename?: string | null;
  code: string;
  reason: string;
}) => void;

let defaultUploadRejectionNotifier: UploadRejectionNotifier | null = null;

export function setUploadRejectionNotifier(
  notifier: UploadRejectionNotifier | null,
): void {
  defaultUploadRejectionNotifier = notifier;
}

export interface UploadSecurityMiddlewareDeps {
  readonly scanner?: DefenderScanner;
  readonly readRange?: typeof readStagedFileRange;
  readonly discardStaged?: typeof discardStagedUpload;
  readonly quarantineStaged?: typeof quarantineStagedUpload;
  readonly onUploadRejected?: UploadRejectionNotifier;
}

function notifyUploadRejection(
  req: Request,
  file: Express.Multer.File | undefined,
  code: string,
  reason: string,
  deps?: UploadSecurityMiddlewareDeps,
): void {
  const sessionId =
    typeof req.params?.sessionId === 'string'
      ? req.params.sessionId
      : typeof req.body?.sessionId === 'string'
        ? req.body.sessionId
        : null;
  const filename = file?.originalname ?? null;
  const notifier = deps?.onUploadRejected ?? defaultUploadRejectionNotifier;
  if (notifier && sessionId) {
    notifier({ sessionId, filename, code, reason });
  }
}

const DANGEROUS_SCRIPT_OR_EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.pif',
  '.cpl',
  '.msi',
  '.msp',
  '.dll',
  '.sys',
  '.ps1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.hta',
  '.sh',
  '.bash',
  '.zsh',
  '.ksh',
  '.jar',
  '.apk',
  '.gadget',
  '.ts',
  '.tsx',
  '.py',
  '.pyw',
  '.php',
  '.phtml',
  '.vba',
  '.rb',
  '.pl',
  '.cgi',
  '.mjs',
  '.cjs',
]);

const DOCUMENT_UPLOAD_POLICY = {
  allowedExtensions: ALLOWED_EXTENSIONS,
  allowedMimeTypes: ALLOWED_MIME_TYPES,
  extensionMimeMap: EXTENSION_MIME_MAP,
  magicSignatures: MAGIC_SIGNATURES,
  surface: 'wireless-session-upload',
} as const satisfies ValidationPolicy;

const LEGACY_UPLOAD_POLICY = {
  allowedExtensions: ALLOWED_EXTENSIONS,
  allowedMimeTypes: ALLOWED_MIME_TYPES,
  extensionMimeMap: EXTENSION_MIME_MAP,
  magicSignatures: MAGIC_SIGNATURES,
  surface: 'legacy-upload',
} as const satisfies ValidationPolicy;

const REPORT_ATTACHMENT_POLICY = {
  allowedExtensions: REPORT_ATTACHMENT_ALLOWED_EXTENSIONS,
  allowedMimeTypes: REPORT_ATTACHMENT_ALLOWED_MIME_TYPES,
  extensionMimeMap: REPORT_ATTACHMENT_EXTENSION_MIME_MAP,
  magicSignatures: REPORT_ATTACHMENT_MAGIC_SIGNATURES,
  surface: 'report-issue-attachment',
} as const satisfies ValidationPolicy;

function classifyDetectedMime(
  buffer: Buffer,
  signatures: ValidationPolicy['magicSignatures'],
): string | null {
  for (const [mime, mimeSignatures] of Object.entries(signatures)) {
    if (mime === 'image/webp' && !hasValidWebpSignature(buffer)) {
      continue;
    }
    const matched = mimeSignatures.some(({ bytes, offset = 0 }) => {
      if (buffer.length < offset + bytes.length) return false;
      return bytes.every((byte, index) => buffer[offset + index] === byte);
    });
    if (matched) return mime;
  }
  return null;
}

export function detectDisguisedExecutableName(originalName: string): {
  flagged: boolean;
  matchedExtension: string | null;
} {
  const filename = path.basename(originalName).toLowerCase();
  const parts = filename
    .split('.')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return { flagged: false, matchedExtension: null };
  }

  for (let idx = 1; idx < parts.length - 1; idx += 1) {
    const ext = `.${parts[idx]}`;
    if (DANGEROUS_SCRIPT_OR_EXECUTABLE_EXTENSIONS.has(ext)) {
      return { flagged: true, matchedExtension: ext };
    }
  }

  const finalExt = `.${parts[parts.length - 1]}`;
  if (DANGEROUS_SCRIPT_OR_EXECUTABLE_EXTENSIONS.has(finalExt)) {
    return { flagged: true, matchedExtension: finalExt };
  }

  return { flagged: false, matchedExtension: null };
}

function getRequestClientIp(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) {
    return (
      forwarded
        .split(',')
        .map((part) => part.trim())
        .find((part) => part.length > 0) ??
      (req.ip || '')
    );
  }
  return req.ip || '';
}

function extractRequestContext(
  req: Request,
): Record<string, string | number | boolean | null> {
  return {
    route: req.route?.path?.toString() ?? null,
    method: req.method,
    ipAddress: getRequestClientIp(req) || null,
    sessionId:
      typeof req.params?.sessionId === 'string' ? req.params.sessionId : null,
    uploadToken: typeof req.query?.token === 'string' ? req.query.token : null,
    uploadClientId:
      req.header('x-upload-client-id') ??
      req.header('x-session-client-id') ??
      null,
  };
}

async function reportUploadSecurityAnomaly(input: {
  type: string;
  source: UploadSurface;
  severity: 'warning' | 'critical';
  message: string;
  fingerprintParts: (string | null)[];
  context?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  try {
    await anomalyService.report({
      type: input.type,
      source: input.source,
      category: 'security',
      severity: input.severity,
      message: input.message,
      fingerprint: buildAnomalyFingerprint(input.fingerprintParts),
      context: input.context,
    });
  } catch (error) {
    console.error('[UPLOAD_SECURITY] Failed to report anomaly incident.', {
      type: input.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function appendSecurityLog(
  type: string,
  message: string,
  meta: Record<string, string | number | boolean | null>,
): void {
  void adminService.appendAdminLog(type, message, meta).catch((error) => {
    console.error('[UPLOAD_SECURITY] Failed to append admin security log.', {
      type,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function validateIncomingFileType(
  req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
  policy: ValidationPolicy,
  deps?: UploadSecurityMiddlewareDeps,
): void {
  const ext = path.extname(file.originalname).toLowerCase();
  const incomingMime = file.mimetype.toLowerCase();
  const requestContext = extractRequestContext(req);

  const disguised = detectDisguisedExecutableName(file.originalname);
  if (disguised.flagged) {
    const meta = {
      ...requestContext,
      originalFilename: file.originalname,
      declaredMimeType: incomingMime,
      detectedMimeType: null,
      detectedExecutableExtension: disguised.matchedExtension,
      validationReason: 'DISGUISED_EXECUTABLE_NAME',
      uploadSurface: policy.surface,
    };
    appendSecurityLog(
      'upload_security_violation',
      'Rejected upload with disguised executable filename pattern.',
      meta,
    );
    void reportUploadSecurityAnomaly({
      type: 'upload_disguised_executable_rejected',
      source: policy.surface,
      severity: 'critical',
      message:
        'Upload rejected because filename contains a dangerous executable extension pattern.',
      fingerprintParts: [
        policy.surface,
        'disguised-filename',
        disguised.matchedExtension,
      ],
      context: meta,
    });
    notifyUploadRejection(
      req,
      file,
      'DISGUISED_EXECUTABLE',
      `Disguised executable filename pattern detected (${disguised.matchedExtension}).`,
      deps,
    );
    cb(
      Object.assign(new Error('Disguised executable filename detected'), {
        code: 'DISGUISED_EXECUTABLE',
      }),
    );
    return;
  }

  if (
    !policy.allowedExtensions.has(ext) ||
    !policy.allowedMimeTypes.has(incomingMime)
  ) {
    const meta = {
      ...requestContext,
      originalFilename: file.originalname,
      declaredMimeType: incomingMime,
      detectedMimeType: null,
      detectedExecutableExtension: null,
      validationReason: 'UNSUPPORTED_TYPE',
      uploadSurface: policy.surface,
    };
    appendSecurityLog(
      'upload_security_violation',
      'Rejected upload because extension or declared MIME type is not allowed.',
      meta,
    );
    notifyUploadRejection(
      req,
      file,
      'UNSUPPORTED_TYPE',
      'File format not supported. Only PDF, DOCX, and images (JPG, PNG, GIF, WebP, BMP) are allowed.',
      deps,
    );
    cb(
      Object.assign(new Error('Invalid file type'), {
        code: 'UNSUPPORTED_TYPE',
      }),
    );
    return;
  }

  const pipeline = adminService.getPipelineSettings();
  if (
    !pipeline.documentConversionEnabled &&
    (ext === '.doc' || ext === '.docx')
  ) {
    const meta = {
      ...requestContext,
      originalFilename: file.originalname,
      declaredMimeType: incomingMime,
      detectedMimeType: null,
      detectedExecutableExtension: null,
      validationReason: 'UNSUPPORTED_TYPE',
      uploadSurface: policy.surface,
    };
    appendSecurityLog(
      'upload_security_violation',
      'Rejected upload because document conversion is disabled and file is a Word document.',
      meta,
    );
    notifyUploadRejection(
      req,
      file,
      'UNSUPPORTED_TYPE',
      'Word document conversion is disabled on this kiosk.',
      deps,
    );
    cb(
      Object.assign(
        new Error(
          'Document conversion is disabled. Only PDF and image files are allowed.',
        ),
        {
          code: 'UNSUPPORTED_TYPE',
        },
      ),
    );
    return;
  }

  const expectedMime = policy.extensionMimeMap[ext];
  const isBothImages =
    Boolean(expectedMime?.startsWith('image/')) &&
    incomingMime.startsWith('image/');
  const normalizedMime =
    incomingMime === 'application/octet-stream' || isBothImages
      ? (expectedMime ?? incomingMime)
      : incomingMime;
  if (!normalizedMime || (expectedMime && expectedMime !== normalizedMime && !isBothImages)) {
    const meta = {
      ...requestContext,
      originalFilename: file.originalname,
      declaredMimeType: incomingMime,
      detectedMimeType: null,
      detectedExecutableExtension: null,
      validationReason: 'EXTENSION_MIME_MISMATCH',
      expectedMimeType: expectedMime ?? null,
      uploadSurface: policy.surface,
    };
    appendSecurityLog(
      'upload_security_violation',
      'Rejected upload because extension does not match declared MIME type.',
      meta,
    );
    notifyUploadRejection(
      req,
      file,
      'UNSUPPORTED_TYPE',
      'File extension does not match declared content type.',
      deps,
    );
    cb(
      Object.assign(new Error('File extension does not match content type'), {
        code: 'UNSUPPORTED_TYPE',
      }),
    );
    return;
  }

  file.mimetype = normalizedMime;
  cb(null, true);
}

export function handleMulterError(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      notifyUploadRejection(
        req,
        req.file,
        'FILE_TOO_LARGE',
        `File size exceeds limit of ${MAX_FILE_SIZE_LABEL}.`,
      );
      res.status(413).json({
        code: 'FILE_TOO_LARGE',
        error: `File size exceeds the limit of ${MAX_FILE_SIZE_LABEL}.`,
      });
      return;
    }
    notifyUploadRejection(
      req,
      req.file,
      'UPLOAD_ERROR',
      error.message,
    );
    res.status(400).json({
      code: 'UPLOAD_ERROR',
      error: error.message,
    });
    return;
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    if (code === 'UNSUPPORTED_TYPE') {
      notifyUploadRejection(
        req,
        req.file,
        'UNSUPPORTED_TYPE',
        error.message,
      );
      res.status(415).json({
        code: 'UNSUPPORTED_FILE_TYPE',
        error: error.message,
      });
      return;
    }
    if (code === 'DISGUISED_EXECUTABLE') {
      notifyUploadRejection(
        req,
        req.file,
        'DISGUISED_EXECUTABLE',
        error.message,
      );
      res.status(422).json({
        code: 'DISGUISED_EXECUTABLE',
        error: error.message,
      });
      return;
    }
    if (code === 'STAGING_QUOTA_EXCEEDED') {
      notifyUploadRejection(
        req,
        req.file,
        'STAGING_QUOTA_EXCEEDED',
        'Upload rejected: staging byte quota exceeded.',
      );
      res.status(413).json({
        code: 'STAGING_QUOTA_EXCEEDED',
        error: 'Upload rejected: staging byte quota exceeded.',
      });
      return;
    }
  }
  next(error);
}

function matchesMagicBytes(
  buffer: Buffer,
  mime: string,
  signaturesByMime: ValidationPolicy['magicSignatures'],
): boolean {
  const signatures = signaturesByMime[mime];
  if (!signatures) return false;

  return signatures.some(({ bytes, offset = 0 }) => {
    if (buffer.length < offset + bytes.length) return false;
    return bytes.every((byte, index) => buffer[offset + index] === byte);
  });
}

function hasValidWebpSignature(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const riff = buffer.toString('ascii', 0, 4);
  const webp = buffer.toString('ascii', 8, 12);
  return riff === 'RIFF' && webp === 'WEBP';
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

const MAX_OOXML_CENTRAL_DIRECTORY_SIZE = 8 * 1024 * 1024; // 8 MiB
const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_UNCOMPRESSED_SIZE = 150 * 1024 * 1024; // 150 MiB

export async function validateStagedOoxmlStructure(
  filePath: string,
  fileSize: number,
  directoryMarker: string,
  readRangeFn: typeof readStagedFileRange,
): Promise<{ valid: boolean; reason?: QuarantineReason }> {
  const centralDirectoryHeaderSignature = 0x02014b50;
  const tailReadLength = Math.min(fileSize, 65557);
  const tailOffset = fileSize - tailReadLength;

  if (tailReadLength < 22) return { valid: false, reason: 'OOXML_STRUCTURE_INVALID' };

  const tailBuffer = await readRangeFn(filePath, tailOffset, tailReadLength);
  const eocdRelativeOffset = findEndOfCentralDirectoryOffset(tailBuffer);
  if (eocdRelativeOffset === -1) return { valid: false, reason: 'OOXML_STRUCTURE_INVALID' };

  const eocdAbsoluteOffset = tailOffset + eocdRelativeOffset;
  const centralDirectorySize = tailBuffer.readUInt32LE(eocdRelativeOffset + 12);
  const centralDirectoryOffset = tailBuffer.readUInt32LE(
    eocdRelativeOffset + 16,
  );

  if (
    centralDirectoryOffset < 0 ||
    centralDirectorySize <= 0 ||
    centralDirectorySize > MAX_OOXML_CENTRAL_DIRECTORY_SIZE ||
    centralDirectoryOffset + centralDirectorySize > eocdAbsoluteOffset
  ) {
    return { valid: false, reason: 'OOXML_STRUCTURE_INVALID' };
  }

  const cdBuffer = await readRangeFn(
    filePath,
    centralDirectoryOffset,
    centralDirectorySize,
  );
  let cursor = 0;
  let entryCount = 0;
  let totalUncompressedSize = 0;
  let hasContentTypes = false;
  let hasDirectoryEntry = false;

  while (cursor + 46 <= cdBuffer.length) {
    if (cdBuffer.readUInt32LE(cursor) !== centralDirectoryHeaderSignature) {
      return { valid: false, reason: 'OOXML_STRUCTURE_INVALID' };
    }

    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) {
      return { valid: false, reason: 'ZIP_BOMB_DETECTED' };
    }

    const uncompressedSize = cdBuffer.readUInt32LE(cursor + 24);
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_ZIP_UNCOMPRESSED_SIZE) {
      return { valid: false, reason: 'ZIP_BOMB_DETECTED' };
    }

    const fileNameLength = cdBuffer.readUInt16LE(cursor + 28);
    const extraFieldLength = cdBuffer.readUInt16LE(cursor + 30);
    const fileCommentLength = cdBuffer.readUInt16LE(cursor + 32);
    const fileNameStart = cursor + 46;
    const fileNameEnd = fileNameStart + fileNameLength;

    if (fileNameEnd > cdBuffer.length) {
      return { valid: false, reason: 'OOXML_STRUCTURE_INVALID' };
    }

    const entryName = cdBuffer.toString('utf8', fileNameStart, fileNameEnd);
    const lowerName = entryName.toLowerCase();

    if (
      lowerName.endsWith('vbaproject.bin') ||
      lowerName.includes('macrosheets') ||
      lowerName.endsWith('.vba')
    ) {
      return { valid: false, reason: 'MACRO_DETECTED' };
    }

    if (entryName === '[Content_Types].xml') {
      hasContentTypes = true;
    }

    if (
      entryName.startsWith(directoryMarker) &&
      entryName.length > directoryMarker.length
    ) {
      hasDirectoryEntry = true;
    }

    cursor = fileNameEnd + extraFieldLength + fileCommentLength;
  }

  if (
    totalUncompressedSize > 10 * 1024 * 1024 &&
    totalUncompressedSize / Math.max(fileSize, 1) > 100
  ) {
    return { valid: false, reason: 'ZIP_BOMB_DETECTED' };
  }

  if (hasContentTypes && hasDirectoryEntry) {
    return { valid: true };
  }

  return { valid: false, reason: 'OOXML_STRUCTURE_INVALID' };
}

export async function validateStagedPdfStructure(
  filePath: string,
  fileSize: number,
  readRangeFn: typeof readStagedFileRange,
): Promise<{ valid: boolean; reason?: QuarantineReason }> {
  const inspectSize = Math.min(fileSize, 4 * 1024 * 1024);
  const buffer = await readRangeFn(filePath, 0, inspectSize);
  const text = buffer.toString('latin1');

  const forbiddenPdfTokens = [
    /\/JavaScript\b/i,
    /\/JS\b/i,
    /\/Launch\b/i,
    /\/EmbeddedFiles\b/i,
  ];

  for (const token of forbiddenPdfTokens) {
    if (token.test(text)) {
      return { valid: false, reason: 'ACTIVE_CONTENT_DETECTED' };
    }
  }

  return { valid: true };
}

async function validateStagedMagicBytesWithPolicy(
  req: Request,
  res: Response,
  next: NextFunction,
  policy: ValidationPolicy,
  deps: UploadSecurityMiddlewareDeps,
): Promise<void> {
  const file = req.file;
  if (!file || !file.path) {
    next();
    return;
  }

  const readRangeFn = deps.readRange ?? readStagedFileRange;
  const quarantineFn = deps.quarantineStaged ?? quarantineStagedUpload;

  try {
    const headerBuffer = await readRangeFn(file.path, 0, 64);
    let mime = file.mimetype.toLowerCase();
    const hasKnownHeader = matchesMagicBytes(
      headerBuffer,
      mime,
      policy.magicSignatures,
    );
    const webpValid =
      mime !== 'image/webp' || hasValidWebpSignature(headerBuffer);
    let hasValidMagicBytes = hasKnownHeader && webpValid;

    // Auto-recover image format if declared as an image or has an image extension,
    // but the actual header matches another supported image format (e.g. WebP/JPEG saved with .png extension).
    if (!hasValidMagicBytes) {
      const ext = path.extname(file.originalname).toLowerCase();
      const isImageCandidate =
        mime.startsWith('image/') ||
        ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
      if (isImageCandidate) {
        const detectedMime = classifyDetectedMime(
          headerBuffer,
          policy.magicSignatures,
        );
        if (
          detectedMime &&
          detectedMime.startsWith('image/') &&
          policy.allowedMimeTypes.has(detectedMime)
        ) {
          const detectedWebpValid =
            detectedMime !== 'image/webp' || hasValidWebpSignature(headerBuffer);
          if (detectedWebpValid) {
            mime = detectedMime;
            file.mimetype = detectedMime;
            hasValidMagicBytes = true;
          }
        }
      }
    }

    const ooxmlMarker = OOXML_DIRECTORY_MARKERS[mime];
    const isOoxmlFormat = !!ooxmlMarker;

    let structuralResult: { valid: boolean; reason?: QuarantineReason } = {
      valid: true,
    };

    if (hasValidMagicBytes) {
      if (isOoxmlFormat) {
        structuralResult = await validateStagedOoxmlStructure(
          file.path,
          file.size,
          ooxmlMarker,
          readRangeFn,
        );
      } else if (mime === 'application/pdf') {
        structuralResult = await validateStagedPdfStructure(
          file.path,
          file.size,
          readRangeFn,
        );
      }
    }

    const isValid = hasValidMagicBytes && structuralResult.valid;

    if (!isValid) {
      const detectedMime = classifyDetectedMime(
        headerBuffer,
        policy.magicSignatures,
      );
      const validationReason: QuarantineReason = !hasValidMagicBytes
        ? 'MAGIC_BYTE_MISMATCH'
        : (structuralResult.reason ?? 'OOXML_STRUCTURE_INVALID');

      const meta = {
        ...extractRequestContext(req),
        originalFilename: file.originalname,
        declaredMimeType: mime,
        detectedMimeType: detectedMime,
        detectedExecutableExtension: null,
        validationReason,
        uploadSurface: policy.surface,
        sizeBytes: file.size,
      };

      await quarantineFn(file, validationReason);

      appendSecurityLog(
        'upload_security_violation',
        `Rejected upload because file failed security validation (${validationReason}).`,
        meta,
      );
      void reportUploadSecurityAnomaly({
        type:
          validationReason === 'OOXML_STRUCTURE_INVALID'
            ? 'upload_ooxml_structure_invalid'
            : validationReason === 'MACRO_DETECTED'
              ? 'upload_macro_detected'
              : validationReason === 'ACTIVE_CONTENT_DETECTED'
                ? 'upload_active_content_detected'
                : validationReason === 'ZIP_BOMB_DETECTED'
                  ? 'upload_zip_bomb_detected'
                  : 'upload_magic_byte_mismatch',
        source: policy.surface,
        severity: 'critical',
        message:
          'Upload rejected because file content validation failed against declared document type.',
        fingerprintParts: [
          policy.surface,
          validationReason,
          mime,
          detectedMime,
        ],
        context: meta,
      });

      const pipeline = adminService.getPipelineSettings();
      const isDisguised =
        validationReason === 'OOXML_STRUCTURE_INVALID' ||
        validationReason === 'MAGIC_BYTE_MISMATCH' ||
        validationReason === 'MACRO_DETECTED' ||
        validationReason === 'ACTIVE_CONTENT_DETECTED' ||
        validationReason === 'ZIP_BOMB_DETECTED';
      const errorMessage = pipeline.malwareScanningEnabled
        ? 'Security check failed: Suspicious or disguised file detected.'
        : 'File content does not match its declared type.';
      const clientCode = isDisguised ? 'DISGUISED_FILE' : 'UNSUPPORTED_TYPE';
      const detailReason =
        validationReason === 'MACRO_DETECTED'
          ? 'Macros or executable content detected in document'
          : validationReason === 'ACTIVE_CONTENT_DETECTED'
            ? 'Interactive scripts or executable actions detected in PDF'
            : validationReason === 'ZIP_BOMB_DETECTED'
              ? 'Archive decompression safety limits exceeded'
              : validationReason === 'OOXML_STRUCTURE_INVALID'
                ? 'Corrupted or disguised document structure'
                : 'File signature does not match declared format';

      notifyUploadRejection(req, file, clientCode, detailReason, deps);

      res.status(422).json({
        code: clientCode,
        error: errorMessage,
      });
      return;
    }

    next();
  } catch (error) {
    console.error(
      '[file-validation] Unexpected error validating magic bytes:',
      error,
    );
    notifyUploadRejection(
      req,
      file,
      'UNSUPPORTED_TYPE',
      'File content could not be verified.',
      deps,
    );
    res.status(422).json({
      code: 'UNSUPPORTED_TYPE',
      error: 'File content could not be verified.',
    });
  }
}

async function scanStagedUploadWithSurface(
  req: Request,
  res: Response,
  next: NextFunction,
  surface: UploadSurface,
  deps: UploadSecurityMiddlewareDeps,
): Promise<void> {
  const file = req.file;
  if (!file || !file.path) {
    next();
    return;
  }

  const pipeline = adminService.getPipelineSettings();
  if (!pipeline.malwareScanningEnabled) {
    next();
    return;
  }

  const scanner = deps.scanner ?? getSharedDefenderScanner();
  const discardFn = deps.discardStaged ?? discardStagedUpload;
  const quarantineFn = deps.quarantineStaged ?? quarantineStagedUpload;
  const requestContext = extractRequestContext(req);

  try {
    const health = await scanner.getHealth();
    if (health.status !== 'clean') {
      await discardFn(file);
      const meta = {
        ...requestContext,
        originalFilename: file.originalname,
        scannerHealth: health.status,
        signatureAgeHours: health.signatureAgeHours,
        scannerDetail: health.detail,
        uploadSurface: surface,
      };

      appendSecurityLog(
        'antivirus_scan_unavailable',
        `Upload blocked because Microsoft Defender is ${health.status}.`,
        meta,
      );

      void reportUploadSecurityAnomaly({
        type: 'upload_antivirus_unavailable',
        source: surface,
        severity: 'critical',
        message: `Upload blocked because Microsoft Defender scanner is ${health.status}.`,
        fingerprintParts: [surface, 'scanner-health', health.status],
        context: meta,
      });

      notifyUploadRejection(
        req,
        file,
        'SCAN_UNAVAILABLE',
        `Malware scanning service is ${health.status}`,
        deps,
      );

      res.status(503).json({
        code: 'SCAN_UNAVAILABLE',
        error:
          'Malware scanning service is temporarily unavailable. Upload was rejected.',
      });
      return;
    }

    const scanResult = await scanner.scanFile(file.path);

    if (scanResult.status === 'infected') {
      await quarantineFn(
        file,
        'FILE_INFECTED',
        scanResult.detectionName ?? undefined,
      );

      const meta = {
        ...requestContext,
        originalFilename: file.originalname,
        detectionName: scanResult.detectionName,
        uploadSurface: surface,
      };

      appendSecurityLog(
        'upload_malware_detected',
        `Malware detected during upload scan: ${scanResult.detectionName ?? 'ThreatDetected'}`,
        meta,
      );

      void reportUploadSecurityAnomaly({
        type: 'upload_malware_detected',
        source: surface,
        severity: 'critical',
        message:
          'Upload quarantined because Microsoft Defender detected malware.',
        fingerprintParts: [
          surface,
          'malware-detected',
          scanResult.detectionName ?? 'unknown',
        ],
        context: meta,
      });

      notifyUploadRejection(
        req,
        file,
        'FILE_INFECTED',
        scanResult.detectionName
          ? `Malware detected (${scanResult.detectionName})`
          : 'Malware detected in uploaded file',
        deps,
      );

      res.status(422).json({
        code: 'FILE_INFECTED',
        error: 'File was identified as containing potential malware.',
      });
      return;
    }

    if (scanResult.status === 'timeout' || scanResult.status === 'failed') {
      await discardFn(file);
      const meta = {
        ...requestContext,
        originalFilename: file.originalname,
        scanStatus: scanResult.status,
        scanDetail: scanResult.detail,
        uploadSurface: surface,
      };

      appendSecurityLog(
        'upload_scan_failed',
        `Upload rejected because Defender scan ${scanResult.status}.`,
        meta,
      );

      notifyUploadRejection(
        req,
        file,
        'SCAN_FAILED',
        `File security scan ${scanResult.status}`,
        deps,
      );

      res.status(503).json({
        code: 'SCAN_FAILED',
        error: 'File scanning could not be completed. Please try again.',
      });
      return;
    }

    if (scanResult.status === 'unavailable') {
      await discardFn(file);
      notifyUploadRejection(
        req,
        file,
        'SCAN_UNAVAILABLE',
        'Malware scanning service is unavailable',
        deps,
      );
      res.status(503).json({
        code: 'SCAN_UNAVAILABLE',
        error: 'Malware scanning is unavailable.',
      });
      return;
    }

    // Clean scan -> proceed
    next();
  } catch (error) {
    await discardFn(file);
    console.error('[file-validation] Error during malware scan gate:', error);
    notifyUploadRejection(
      req,
      file,
      'SCAN_FAILED',
      'File security verification error',
      deps,
    );
    res.status(503).json({
      code: 'SCAN_FAILED',
      error: 'An error occurred during file security verification.',
    });
  }
}

export function createUploadSecurityMiddleware(
  deps: UploadSecurityMiddlewareDeps = {},
) {
  const uploadMiddlewareInstance = multer({
    storage: createUploadStagingStorage('wireless-session-upload'),
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
    fileFilter: (_req, file, cb) => {
      validateIncomingFileType(_req, file, cb, DOCUMENT_UPLOAD_POLICY, deps);
    },
  });

  const legacyUploadMiddlewareInstance = multer({
    storage: createUploadStagingStorage('legacy-upload'),
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
    fileFilter: (req, file, cb) => {
      validateIncomingFileType(req, file, cb, LEGACY_UPLOAD_POLICY, deps);
    },
  });

  const reportIssueAttachmentUploadMiddlewareInstance = multer({
    storage: createUploadStagingStorage('report-issue-attachment'),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      validateIncomingFileType(req, file, cb, REPORT_ATTACHMENT_POLICY, deps);
    },
  });

  const validateMagicBytesHandler: RequestHandler = (req, res, next) => {
    return validateStagedMagicBytesWithPolicy(
      req,
      res,
      next,
      DOCUMENT_UPLOAD_POLICY,
      deps,
    ) as unknown as void;
  };

  const validateLegacyUploadMagicBytesHandler: RequestHandler = (
    req,
    res,
    next,
  ) => {
    return validateStagedMagicBytesWithPolicy(
      req,
      res,
      next,
      LEGACY_UPLOAD_POLICY,
      deps,
    ) as unknown as void;
  };

  const validateReportIssueAttachmentMagicBytesHandler: RequestHandler = (
    req,
    res,
    next,
  ) => {
    return validateStagedMagicBytesWithPolicy(
      req,
      res,
      next,
      REPORT_ATTACHMENT_POLICY,
      deps,
    ) as unknown as void;
  };

  const scanForMalwareHandler: RequestHandler = (req, res, next) => {
    return scanStagedUploadWithSurface(
      req,
      res,
      next,
      'wireless-session-upload',
      deps,
    ) as unknown as void;
  };

  const scanLegacyUploadForMalwareHandler: RequestHandler = (
    req,
    res,
    next,
  ) => {
    return scanStagedUploadWithSurface(
      req,
      res,
      next,
      'legacy-upload',
      deps,
    ) as unknown as void;
  };

  const scanReportIssueAttachmentForMalwareHandler: RequestHandler = (
    req,
    res,
    next,
  ) => {
    return scanStagedUploadWithSurface(
      req,
      res,
      next,
      'report-issue-attachment',
      deps,
    ) as unknown as void;
  };

  return {
    middleware: {
      uploadMiddleware: uploadMiddlewareInstance,
      legacyUploadMiddleware: legacyUploadMiddlewareInstance,
      reportIssueAttachmentUploadMiddleware:
        reportIssueAttachmentUploadMiddlewareInstance,
      validateMagicBytes: validateMagicBytesHandler,
      validateLegacyUploadMagicBytes: validateLegacyUploadMagicBytesHandler,
      validateReportIssueAttachmentMagicBytes:
        validateReportIssueAttachmentMagicBytesHandler,
      scanForMalware: scanForMalwareHandler,
      scanLegacyUploadForMalware: scanLegacyUploadForMalwareHandler,
      scanReportIssueAttachmentForMalware:
        scanReportIssueAttachmentForMalwareHandler,
      handleMulterError,
    },
  };
}

const defaultSecurityMiddleware = createUploadSecurityMiddleware();

export const uploadMiddleware =
  defaultSecurityMiddleware.middleware.uploadMiddleware;
export const legacyUploadMiddleware =
  defaultSecurityMiddleware.middleware.legacyUploadMiddleware;
export const reportIssueAttachmentUploadMiddleware =
  defaultSecurityMiddleware.middleware.reportIssueAttachmentUploadMiddleware;
export const validateMagicBytes =
  defaultSecurityMiddleware.middleware.validateMagicBytes;
export const validateLegacyUploadMagicBytes =
  defaultSecurityMiddleware.middleware.validateLegacyUploadMagicBytes;
export const validateReportIssueAttachmentMagicBytes =
  defaultSecurityMiddleware.middleware.validateReportIssueAttachmentMagicBytes;
export const scanForMalware =
  defaultSecurityMiddleware.middleware.scanForMalware;
export const scanLegacyUploadForMalware =
  defaultSecurityMiddleware.middleware.scanLegacyUploadForMalware;
export const scanReportIssueAttachmentForMalware =
  defaultSecurityMiddleware.middleware.scanReportIssueAttachmentForMalware;
