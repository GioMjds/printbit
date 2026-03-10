import { randomUUID } from 'node:crypto';
import { ValidationException } from '@/domain/errors';
import { MimeType } from '@/domain/value-objects';

export type UploadSessionStatus = 'pending' | 'uploaded';

export interface UploadDocument {
	id: string;
	filename: string;
	originalName: string;
	contentType: string;
	sizeBytes: number;
	filePath: string;
	uploadedAt: string;
}

export interface UploadSessionProps {
	id: string;
	token: string;
	uploadUrl: string;
	status: UploadSessionStatus;
	createdAt: string;
	documents: UploadDocument[];
}

export class UploadSession {
	static readonly TTL_MS = 15 * 60 * 1000;
	static readonly MAX_FILES = 10;
	static readonly MAX_CUMULATIVE_BYTES = 50 * 1024 * 1024;

	private constructor(private readonly props: UploadSessionProps) {}

	static create(): UploadSession {
		const token = randomUUID();
		return new UploadSession({
			id: randomUUID(),
			token,
			uploadUrl: `/upload/${token}`,
			status: 'pending',
			createdAt: new Date().toISOString(),
			documents: [],
		});
	}

	static reconstitute(props: UploadSessionProps): UploadSession {
		return new UploadSession({ ...props, documents: [...props.documents] });
	}

	isExpired(now = Date.now()): boolean {
		return now - new Date(this.props.createdAt).getTime() > UploadSession.TTL_MS;
	}

	canAcceptMore(): boolean {
		return this.props.documents.length < UploadSession.MAX_FILES;
	}

	validateFile(sizeBytes: number, contentType: string): void {
		MimeType.from(contentType);
		if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
			throw new ValidationException('File size must be a positive integer.');
		}
		if (!this.canAcceptMore()) {
			throw new ValidationException('Session file limit reached.');
		}

		const currentTotal = this.props.documents.reduce(
			(sum, doc) => sum + doc.sizeBytes,
			0,
		);
		const nextTotal = currentTotal + sizeBytes;
		if (nextTotal > UploadSession.MAX_CUMULATIVE_BYTES) {
			throw new ValidationException('Session cumulative upload size exceeded.');
		}
	}

	addFile(file: Omit<UploadDocument, 'id' | 'uploadedAt'>): UploadSession {
		this.validateFile(file.sizeBytes, file.contentType);

		const nextDocuments = [
			...this.props.documents,
			{
				id: randomUUID(),
				uploadedAt: new Date().toISOString(),
				...file,
			},
		];

		return new UploadSession({
			...this.props,
			documents: nextDocuments,
			status: 'uploaded',
		});
	}

	toPrimitives(): UploadSessionProps {
		return {
			...this.props,
			documents: this.props.documents.map((document) => ({ ...document })),
		};
	}
}
