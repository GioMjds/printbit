export class DomainException extends Error {
	constructor(
		message: string,
		public readonly code = 'DOMAIN_ERROR',
	) {
		super(message);
		this.name = 'DomainException';
	}
}
