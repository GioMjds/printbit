import { randomUUID } from 'node:crypto';

export interface ScanDeliveryTokenProps {
	id: string;
	token: string;
	filePath: string;
	filename: string;
	createdAt: string;
	expiresAt: string;
}

export class ScanDeliveryToken {
	private constructor(private readonly props: ScanDeliveryTokenProps) {}

	static create(filePath: string, filename: string, ttlMs: number): ScanDeliveryToken {
		const now = new Date();
		return new ScanDeliveryToken({
			id: randomUUID(),
			token: randomUUID(),
			filePath,
			filename,
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
		});
	}

	static reconstitute(props: ScanDeliveryTokenProps): ScanDeliveryToken {
		return new ScanDeliveryToken(props);
	}

	isExpired(now = Date.now()): boolean {
		return new Date(this.props.expiresAt).getTime() <= now;
	}

	toPrimitives(): ScanDeliveryTokenProps {
		return { ...this.props };
	}
}
