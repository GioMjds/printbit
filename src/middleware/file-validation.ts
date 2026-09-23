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
  createDefenderScanner,
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

export interface UploadSecurityMiddlewareDeps {
  readonly scanner?: DefenderScanner;
  readonly readRange?: typeof readStagedFileRange;
  readonly discardStaged?: typeof discardStagedUpload;
  readonly quarantineStaged?: typeof quarantineStagedUpload;
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

function detectDisguisedExecutableName(originalName: string): {
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
  const normalizedMime =
    incomingMime === 'application/octet-stream' ? expectedMime : incomingMime;
  if (!normalizedMime || (expectedMime && expectedMime !== normalizedMime)) {
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
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    if (code === 'UNSUPPORTED_TYPE') {
      res.status(415).json({
        code: 'UNSUPPORTED_FILE_TYPE',
        error: error.message,
      });
      return;
    }
    if (code === 'DISGUISED_EXECUTABLE') {
      res.status(422).json({
        code: 'DISGUISED_EXECUTABLE',
        error: error.message,
      });
      return;
    }
    if (code === 'STAGING_QUOTA_EXCEEDED') {
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

async function validateStagedOoxmlStructure(
  filePath: string,
  fileSize: number,
  directoryMarker: string,
  readRangeFn: typeof readStagedFileRange,
): Promise<boolean> {
  const centralDirectoryHeaderSignature = 0x02014b50;
  const tailReadLength = Math.min(fileSize, 65557);
  const tailOffset = fileSize - tailReadLength;

  if (tailReadLength < 22) return false;

  const tailBuffer = await readRangeFn(filePath, tailOffset, tailReadLength);
  const eocdRelativeOffset = findEndOfCentralDirectoryOffset(tailBuffer);
  if (eocdRelativeOffset === -1) return false;

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
    return false;
  }

  const cdBuffer = await readRangeFn(
    filePath,
    centralDirectoryOffset,
    centralDirectorySize,
  );
  let cursor = 0;
  let hasContentTypes = false;
  let hasDirectoryEntry = false;

  while (cursor + 46 <= cdBuffer.length) {
    if (cdBuffer.readUInt32LE(cursor) !== centralDirectoryHeaderSignature) {
      return false;
    }

    const fileNameLength = cdBuffer.readUInt16LE(cursor + 28);
    const extraFieldLength = cdBuffer.readUInt16LE(cursor + 30);
    const fileCommentLength = cdBuffer.readUInt16LE(cursor + 32);
    const fileNameStart = cursor + 46;
    const fileNameEnd = fileNameStart + fileNameLength;

    if (fileNameEnd > cdBuffer.length) return false;

    const entryName = cdBuffer.toString('utf8', fileNameStart, fileNameEnd);

    if (entryName === '[Content_Types].xml') {
      hasContentTypes = true;
    }

    if (
      entryName.startsWith(directoryMarker) &&
      entryName.length > directoryMarker.length
    ) {
      hasDirectoryEntry = true;
    }

    if (hasContentTypes && hasDirectoryEntry) {
      return true;
    }

    cursor = fileNameEnd + extraFieldLength + fileCommentLength;
  }

  return false;
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
    const mime = file.mimetype.toLowerCase();
    const hasKnownHeader = matchesMagicBytes(
      headerBuffer,
      mime,
      policy.magicSignatures,
    );
    const webpValid =
      mime !== 'image/webp' || hasValidWebpSignature(headerBuffer);
    const hasValidMagicBytes = hasKnownHeader && webpValid;

    const ooxmlMarker = OOXML_DIRECTORY_MARKERS[mime];
    const isOoxmlFormat = !!ooxmlMarker;

    let ooxmlStructureIsValid = false;
    if (isOoxmlFormat && hasValidMagicBytes) {
      ooxmlStructureIsValid = await validateStagedOoxmlStructure(
        file.path,
        file.size,
        ooxmlMarker,
        readRangeFn,
      );
    }

    const isValid = isOoxmlFormat
      ? hasValidMagicBytes && ooxmlStructureIsValid
      : hasValidMagicBytes;

    if (!isValid) {
      const detectedMime = classifyDetectedMime(
        headerBuffer,
        policy.magicSignatures,
      );
      const validationReason: QuarantineReason = !hasValidMagicBytes
        ? 'MAGIC_BYTE_MISMATCH'
        : 'OOXML_STRUCTURE_INVALID';

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
        'Rejected upload because file signature or OOXML structure is invalid.',
        meta,
      );
      void reportUploadSecurityAnomaly({
        type:
          validationReason === 'OOXML_STRUCTURE_INVALID'
            ? 'upload_ooxml_structure_invalid'
            : 'upload_magic_byte_mismatch',
        source: policy.surface,
        severity: 'critical',
        message:
          'Upload rejected because file content validation failed against declared document type.',
        fingerprintParts: [
          policy.surface,
          validationReason === 'OOXML_STRUCTURE_INVALID'
            ? 'ooxml-structure-invalid'
            : 'magic-byte-mismatch',
          mime,
          detectedMime,
        ],
        context: meta,
      });

      res.status(422).json({
        code: 'UNSUPPORTED_TYPE',
        error: 'File content does not match its declared type.',
      });
      return;
    }

    next();
  } catch (error) {
    console.error(
      '[file-validation] Unexpected error validating magic bytes:',
      error,
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

  const scanner = deps.scanner ?? createDefenderScanner();
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

      res.status(503).json({
        code: 'SCAN_FAILED',
        error: 'File scanning could not be completed. Please try again.',
      });
      return;
    }

    if (scanResult.status === 'unavailable') {
      await discardFn(file);
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
      validateIncomingFileType(_req, file, cb, DOCUMENT_UPLOAD_POLICY);
    },
  });

  const legacyUploadMiddlewareInstance = multer({
    storage: createUploadStagingStorage('legacy-upload'),
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
    fileFilter: (req, file, cb) => {
      validateIncomingFileType(req, file, cb, LEGACY_UPLOAD_POLICY);
    },
  });

  const reportIssueAttachmentUploadMiddlewareInstance = multer({
    storage: createUploadStagingStorage('report-issue-attachment'),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      validateIncomingFileType(req, file, cb, REPORT_ATTACHMENT_POLICY);
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
