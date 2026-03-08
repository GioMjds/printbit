import { ValidationException } from '@/domain/errors';

export const ALLOWED_UPLOAD_MIME_TYPES = [
	'application/pdf',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'image/jpeg',
	'image/png',
] as const;

export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

const ALLOWED_UPLOAD_MIME_TYPE_SET: ReadonlySet<string> = new Set(
	ALLOWED_UPLOAD_MIME_TYPES,
);

export class MimeType {
	private constructor(private readonly raw: AllowedUploadMimeType) {}

	static from(value: string): MimeType {
		if (!ALLOWED_UPLOAD_MIME_TYPE_SET.has(value)) {
			throw new ValidationException(`Unsupported mime type: ${value}`);
		}
		return new MimeType(value as AllowedUploadMimeType);
	}

	get value(): AllowedUploadMimeType {
		return this.raw;
	}
}
