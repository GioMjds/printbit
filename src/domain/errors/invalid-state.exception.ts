import { DomainException } from './domain.exception';

export class InvalidStateException extends DomainException {
	constructor(message: string) {
		super(message, 'INVALID_STATE');
		this.name = 'InvalidStateException';
	}
}
