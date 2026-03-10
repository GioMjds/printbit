import { randomUUID } from 'node:crypto';

export type LogMetaValue = string | number | boolean | null;
export type LogMeta = Record<string, LogMetaValue>;

export interface LogProps {
	id: string;
	timestamp: string;
	type: string;
	message: string;
	meta?: LogMeta;
}

export class Log {
	private constructor(private readonly props: LogProps) {}

	static create(type: string, message: string, meta?: LogMeta): Log {
		return new Log({
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			type,
			message,
			meta,
		});
	}

	static reconstitute(props: LogProps): Log {
		return new Log(props);
	}

	toPrimitives(): LogProps {
		return {
			id: this.props.id,
			timestamp: this.props.timestamp,
			type: this.props.type,
			message: this.props.message,
			meta: this.props.meta ? { ...this.props.meta } : undefined,
		};
	}
}
